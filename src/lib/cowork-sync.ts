// OneDrive-first sync engine: cheap outline discovery, cached stale-while-revalidate hydration, lazy prioritised
// subtree hydration with bounded connector concurrency, fingerprint-based revalidation at the nearest folder
// boundary, and an explicit full rescan. Works purely through the CoworkTaskRepository contract (live or in-memory),
// and through the LayoutCache contract (IndexedDB or memory), so every path is deterministic under fakes.
import { classifyFolder, skillSummary, type CoworkTaskRepository, type DriveItem, type FileRole } from '@/lib/cowork-domain';
import { containerKind, fileFingerprint, folderFingerprint, normalizePath, type ContainerKind, type CoworkLayout, type DiscoveryIssue, type MemoryEntry, type SkillSummary, type TaskFile, type TaskFolder, type TaskSummary } from '@/lib/cowork-discovery';
import { cacheKey, rootPrefix, type LayoutCache } from '@/lib/layout-cache';

// ---- Snapshots (what is cached) ---------------------------------------------------------------------------------------
export interface Shell { folder: DriveItem; containerId?: string }
export interface OutlineSnapshot { root: DriveItem; rootPath: string; containers: Record<ContainerKind, DriveItem[]>; rootFiles: DriveItem[]; flatLayout: boolean; shells: Shell[]; tasksTruncated: boolean; issues: DiscoveryIssue[]; syncedAt: string }
export interface TaskSnapshot { summary: TaskSummary; fingerprint: string; /** fingerprints of every folder listed inside the task (task folder + role folders + nested), by item id */ folderFingerprints: Record<string, string>; syncedAt: string }
export interface SkillRecord extends SkillSummary { folderFingerprint: string; definitionFingerprint?: string }
export interface SkillsSnapshot { skills: SkillRecord[]; containerFingerprints: Record<string, string>; issues: DiscoveryIssue[]; syncedAt: string }
export interface MemorySnapshot { memory: MemoryEntry[]; folderFingerprints: Record<string, string>; /** folder id → direct subfolder ids (a fingerprint only vouches for direct children) */ subfolders?: Record<string, string[]>; memoryTruncated: boolean; issues: DiscoveryIssue[]; syncedAt: string }

export type SectionState = 'idle' | 'cached' | 'loading' | 'ready' | 'error';
export type SyncPhase = 'idle' | 'authorizing' | 'cold-outline' | 'revalidating' | 'rescanning';
export interface SyncStatus {
  phase: SyncPhase;
  source: 'none' | 'cache' | 'live';
  lastSyncedAt?: string;
  /** Set when the most recent revalidation failed; the last known-good snapshot stays on screen. */
  error?: string;
  rootError?: string;
  progress?: { done: number; total: number; label: string };
  cacheKind: 'indexeddb' | 'memory';
  cacheWarning?: string;
  skills: SectionState; skillsError?: string;
  memory: SectionState; memoryError?: string;
  hydrating: ReadonlySet<string>;
  pendingHydration: number;
}
export interface SyncMetrics { calls: number; peakInFlight: number; byOperation: Record<string, number>; throttledRetries: number; firstLayoutAt?: number; firstCachedAt?: number; firstOutlineAt?: number }

const LIMITS = { pagesPerFolder: 20, roleDepth: 4, roleFiles: 400, skillDepth: 4, skills: 200, memoryDepth: 6, memoryFiles: 500 };
type Priority = 0 | 1 | 2 | 3; // 0 selected, 1 visible/pinned, 2 outline-stale, 3 background
type HydrationMode = 'fingerprint' | 'boundary' | 'force';

class Limiter {
  private active = 0; private queue: (() => void)[] = [];
  peak = 0; calls = 0; byOperation: Record<string, number> = {};
  constructor(private limit: number) {}
  async run<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.queue.push(resolve));
    this.active++; this.peak = Math.max(this.peak, this.active); this.calls++; this.byOperation[operation] = (this.byOperation[operation] ?? 0) + 1;
    try { return await fn(); } finally { this.active--; this.queue.shift()?.(); }
  }
}
/** Connector throttling (HTTP 429 / "rate limit") is retried with backoff inside the ≤3 concurrency gate instead of failing a subtree. */
export const isThrottled = (error: unknown) => { const t = error instanceof Error ? error.message : typeof error === 'string' ? error : ''; return /\b429\b|rate limit/i.test(t); };
const THROTTLE_BACKOFF_MS = [1000, 2000, 4000];
const message = (error: unknown) => { const t = error instanceof Error ? error.message : typeof error === 'string' ? error : 'The folder could not be read.'; return t.length > 200 ? `${t.slice(0, 200)}…` : t; };

export class CoworkSyncEngine {
  private limiter: Limiter;
  private listeners = new Set<() => void>();
  private generation = 0;
  private rootId?: string;
  private rootItem?: DriveItem;
  private rootPath = '';
  private outline?: OutlineSnapshot;
  private tasks = new Map<string, TaskSnapshot>();
  private skillsSnap?: SkillsSnapshot;
  private memorySnap?: MemorySnapshot;
  private queue: { id: string; priority: Priority; mode: HydrationMode }[] = [];
  private inflight = new Map<string, Promise<void>>();
  private workers = 0;
  private revalidation?: Promise<void>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private _layout?: CoworkLayout;
  private _status: SyncStatus;
  readonly metrics: SyncMetrics;
  private startedAt = 0;

  constructor(private repo: CoworkTaskRepository, private cache: LayoutCache, readonly options: { concurrency?: number; now?: () => number; idleDelayMs?: number; onEvent?: (name: string) => void; throttleBackoffMs?: number[] } = {}) {
    this.limiter = new Limiter(Math.min(3, options.concurrency ?? 3));
    this.metrics = { calls: 0, peakInFlight: 0, byOperation: {}, throttledRetries: 0 };
    this._status = { phase: 'idle', source: 'none', cacheKind: cache.kind, skills: 'idle', memory: 'idle', hydrating: new Set(), pendingHydration: 0 };
  }
  private now() { return this.options.now ? this.options.now() : Date.now(); }
  private iso() { return new Date(this.now()).toISOString(); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  get layout() { return this._layout; }
  get status() { return this._status; }
  /** Monotonic change counter so a UI binding can snapshot (status, layout) per emit. */
  private _version = 0;
  get version() { return this._version; }
  /** Re-read the cache kind (the resilient cache may have degraded to session memory) and surface the reason. */
  refreshCacheKind() { const reason = (this.cache as { degradedReason?: string }).degradedReason; this.emit({ cacheWarning: reason ? `Browser cache unavailable — using session memory for this visit (${reason})` : this._status.cacheWarning }); }
  private emit(patch: Partial<SyncStatus> = {}) {
    this._version++;
    this.metrics.calls = this.limiter.calls; this.metrics.peakInFlight = this.limiter.peak; this.metrics.byOperation = { ...this.limiter.byOperation };
    this._status = { ...this._status, ...patch, cacheKind: this.cache.kind, hydrating: new Set(this.inflight.keys()), pendingHydration: this.queue.length + this.inflight.size };
    this._layout = this.build();
    if (this._layout && this.metrics.firstLayoutAt === undefined) this.metrics.firstLayoutAt = this.now() - this.startedAt;
    for (const l of this.listeners) l();
  }
  private call<T>(operation: string, fn: () => Promise<T>) {
    return this.limiter.run(operation, async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await fn(); }
        catch (error) {
          if (!isThrottled(error) || attempt >= THROTTLE_BACKOFF_MS.length) throw error;
          this.metrics.throttledRetries++;
          const wait = this.options.throttleBackoffMs?.[attempt] ?? THROTTLE_BACKOFF_MS[attempt];
          await new Promise(resolve => setTimeout(resolve, wait));
        }
      }
    });
  }
  private async listAll(id: string, maxPages = LIMITS.pagesPerFolder) {
    const items: DriveItem[] = []; let token: string | undefined; let pages = 0;
    do { const page = await this.call('list', () => this.repo.list(id, token)); items.push(...page.items); token = page.nextToken; pages++; } while (token && pages < maxPages);
    return { items, truncated: !!token };
  }
  private key(part: string) { return cacheKey(this.rootId ?? '', part); }
  private async cacheSet<T>(part: string, value: T) {
    try { await this.cache.set(this.key(part), value); const degraded = (this.cache as { degradedReason?: string }).degradedReason; if (degraded && !this._status.cacheWarning) this.emit({ cacheWarning: `Browser cache unavailable — using session memory for this visit (${degraded})` }); else if (!degraded && this._status.cacheWarning) this.emit({ cacheWarning: undefined }); }
    catch (error) { this.emit({ cacheWarning: `Browser cache unavailable — using session memory only (${message(error)})` }); }
  }

  // ---- Lifecycle ----------------------------------------------------------------------------------------------------------
  /** Authorise the root (one cheap call), hydrate any cached snapshot for THAT root, then revalidate the outline. */
  async start(path: string) {
    this.dispose();
    const gen = ++this.generation;
    this.startedAt = this.now();
    this.rootPath = normalizePath(path) || path;
    this.emit({ phase: 'authorizing', rootError: undefined, error: undefined });
    let root: DriveItem;
    try { root = await this.call('resolve', () => this.repo.resolve(this.rootPath)); }
    catch (error) { if (gen !== this.generation) return; this.rootId = undefined; this.outline = undefined; this.tasks.clear(); this.emit({ phase: 'idle', source: 'none', rootError: message(error) }); return; }
    if (gen !== this.generation) return;
    this.rootId = root.Id;
    this.rootItem = root;
    await this.hydrateFromCache(root, gen);
    if (gen !== this.generation) return;
    await this.revalidate(gen, this.outline ? 'revalidating' : 'cold-outline');
  }
  /** Incremental refresh: outline + fingerprint diff; never a whole-tree walk. */
  refresh() { if (!this.rootId) return Promise.resolve(); return this.revalidate(this.generation, 'revalidating'); }
  dispose() { this.generation++; this.queue = []; if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; } }

  private async hydrateFromCache(root: DriveItem, gen: number) {
    try {
      const outline = await this.cache.get<OutlineSnapshot>(this.key('outline'));
      if (gen !== this.generation) return;
      if (!outline || outline.root.Id !== root.Id || normalizePath(outline.rootPath) !== this.rootPath) return; // never render another root's snapshot
      const snapshots = await Promise.all(outline.shells.map(s => this.cache.get<TaskSnapshot>(this.key(`task|${s.folder.Id}`))));
      if (gen !== this.generation) return;
      this.outline = outline;
      this.tasks.clear();
      outline.shells.forEach((s, i) => { const snap = snapshots[i]; if (snap?.summary?.folder?.Id === s.folder.Id) this.tasks.set(s.folder.Id, snap); });
      this.skillsSnap = await this.cache.get<SkillsSnapshot>(this.key('skills'));
      this.memorySnap = await this.cache.get<MemorySnapshot>(this.key('memory'));
      if (gen !== this.generation) return;
      if (this.metrics.firstCachedAt === undefined) this.metrics.firstCachedAt = this.now() - this.startedAt;
      this.options.onEvent?.('cache-hydrated');
      this.emit({ phase: 'revalidating', source: 'cache', lastSyncedAt: outline.syncedAt, skills: this.skillsSnap ? 'cached' : 'idle', memory: this.memorySnap ? 'cached' : 'idle' });
    } catch (error) { this.emit({ cacheWarning: `Browser cache could not be read — starting fresh (${message(error)})` }); }
  }

  private revalidate(gen: number, phase: 'revalidating' | 'cold-outline' | 'rescanning', force = false) {
    if (this.revalidation) return this.revalidation; // dedupe concurrent refreshes
    this.revalidation = this.revalidateOutline(gen, phase, force).finally(() => { this.revalidation = undefined; });
    return this.revalidation;
  }
  private async revalidateOutline(gen: number, phase: 'revalidating' | 'cold-outline' | 'rescanning', force: boolean) {
    if (!this.rootId) return;
    this.emit({ phase, error: undefined });
    try {
      const root = this.rootItem && this.rootItem.Id === this.rootId ? this.rootItem : await this.call('resolve', () => this.repo.resolve(this.rootPath));
      const rootListing = await this.listAll(root.Id);
      if (gen !== this.generation) return;
      const containers: Record<ContainerKind, DriveItem[]> = { tasks: [], skills: [], memory: [], config: [] };
      const otherFolders: DriveItem[] = []; const issues: DiscoveryIssue[] = [];
      for (const item of rootListing.items.filter(i => i.IsFolder)) { const kind = containerKind(item.Name); if (kind) containers[kind].push(item); else otherFolders.push(item); }
      if (rootListing.truncated) issues.push({ scope: 'root', path: this.rootPath, message: `Only the first ${LIMITS.pagesPerFolder} pages of the root folder were read.` });
      const flatLayout = containers.tasks.length === 0;
      const shells: Shell[] = []; let tasksTruncated = false;
      if (flatLayout) shells.push(...otherFolders.map(folder => ({ folder })));
      else for (const container of containers.tasks) {
        try { const listing = await this.listAll(container.Id); tasksTruncated ||= listing.truncated; shells.push(...listing.items.filter(i => i.IsFolder).map(folder => ({ folder, containerId: container.Id }))); }
        catch (error) { issues.push({ scope: 'tasks', path: normalizePath(container.Path) || `${this.rootPath}/${container.Name}`, message: message(error) }); }
      }
      if (gen !== this.generation) return;
      // Merge: deletes drop out, adds appear as shells, moves follow the shell's new container, changed fingerprints are marked stale and queued.
      const present = new Set(shells.map(s => s.folder.Id));
      for (const id of [...this.tasks.keys()]) if (!present.has(id)) { this.tasks.delete(id); void this.cache.delete(this.key(`task|${id}`)).catch(() => undefined); }
      const toHydrate: string[] = [];
      for (const shell of shells) {
        const snap = this.tasks.get(shell.folder.Id);
        if (snap) { snap.summary = { ...snap.summary, folder: shell.folder, container: containers.tasks.find(c => c.Id === shell.containerId) }; }
        if (force || !snap || snap.fingerprint !== folderFingerprint(shell.folder)) { if (snap) snap.summary.stale = true; toHydrate.push(shell.folder.Id); }
      }
      this.outline = { root, rootPath: this.rootPath, containers, rootFiles: rootListing.items.filter(i => !i.IsFolder), flatLayout, shells, tasksTruncated, issues, syncedAt: this.iso() };
      if (this.metrics.firstOutlineAt === undefined) this.metrics.firstOutlineAt = this.now() - this.startedAt;
      this.options.onEvent?.('outline');
      await this.cacheSet('outline', this.outline);
      this.emit({ phase: force ? 'rescanning' : 'idle', source: 'live', lastSyncedAt: this.outline.syncedAt, error: undefined });
      // Skills/memory containers: if a cached section exists and all container fingerprints are unchanged keep it; otherwise mark for lazy reload.
      if (this.skillsSnap && containers.skills.some(c => this.skillsSnap!.containerFingerprints[c.Id] !== folderFingerprint(c))) this.emit({ skills: 'cached' });
      if (this.memorySnap && [...containers.memory, ...containers.config].some(c => this.memorySnap!.folderFingerprints[c.Id] !== folderFingerprint(c))) this.emit({ memory: 'cached' });
      const mode: HydrationMode = force ? 'force' : 'fingerprint';
      for (const id of toHydrate) this.enqueue(id, 2, mode);
      if (force) { this.emit({ progress: { done: 0, total: toHydrate.length, label: 'Inspecting task folders' } }); void this.ensureSkills(true); void this.ensureMemory(true); }
      this.scheduleIdle(gen);
    } catch (error) {
      if (gen !== this.generation) return;
      this.emit({ phase: 'idle', error: message(error) }); // last known-good snapshot stays
    }
  }

  // ---- Task hydration (prioritised, deduplicated, bounded) ------------------------------------------------------------------
  /** UI hint: these task ids are visible/pinned — hydrate them before the rest. */
  /** Visible/pinned shells move to priority 1. A request that changes nothing (already hydrated, in flight, or already at ≥ this priority) emits nothing — a React effect may call this on every render without feeding back into state. */
  prioritize(ids: Iterable<string>) {
    let changed = false;
    for (const id of ids) {
      if (!this.needsHydration(id) || this.inflight.has(id)) continue;
      const existing = this.queue.find(q => q.id === id);
      if (existing) { if (existing.priority > 1) { existing.priority = 1; changed = true; } }
      else { this.queue.push({ id, priority: 1, mode: 'fingerprint' }); changed = true; }
    }
    if (!changed) return;
    this.queue.sort((a, b) => a.priority - b.priority);
    this.emit();
    this.pump();
  }
  /** Selected task: hydrate immediately, validating the nearest cached folder boundaries (direct listings) rather than trusting a parent timestamp. */
  hydrateTask(id: string) { if (!this.outline?.shells.some(s => s.folder.Id === id)) return Promise.resolve(); return this.enqueue(id, 0, this.tasks.get(id) ? 'boundary' : 'fingerprint'); }
  private needsHydration(id: string) { const snap = this.tasks.get(id); return !snap || !!snap.summary.stale; }
  private enqueue(id: string, priority: Priority, mode: HydrationMode): Promise<void> {
    const running = this.inflight.get(id);
    if (running) return running;
    const existing = this.queue.find(q => q.id === id);
    let changed = false;
    if (existing) {
      if (priority < existing.priority) { existing.priority = priority; changed = true; }
      if (mode === 'force' || (mode === 'boundary' && existing.mode === 'fingerprint')) { if (existing.mode !== mode) changed = true; existing.mode = mode; }
    }
    else if (mode === 'fingerprint' && !this.needsHydration(id)) return Promise.resolve();
    else { this.queue.push({ id, priority, mode }); changed = true; }
    if (changed) { this.queue.sort((a, b) => a.priority - b.priority); this.emit(); this.pump(); }
    return new Promise(resolve => { const check = () => { if (!this.queue.some(q => q.id === id) && !this.inflight.has(id)) { unsubscribe(); resolve(); } }; const unsubscribe = this.subscribe(check); check(); });
  }
  private pump() {
    while (this.workers < 3 && this.queue.length) {
      const job = this.queue.shift()!;
      this.workers++;
      const gen = this.generation;
      const run = this.hydrateOne(job.id, job.mode, gen).catch(() => undefined).finally(() => { this.workers--; this.inflight.delete(job.id); if (this._status.progress) { const p = this._status.progress; this.emit({ progress: p.done + 1 >= p.total ? undefined : { ...p, done: p.done + 1 }, phase: p.done + 1 >= p.total ? 'idle' : this._status.phase }); } else this.emit(); this.pump(); });
      this.inflight.set(job.id, run);
      this.emit();
    }
  }
  private async hydrateOne(id: string, mode: HydrationMode, gen: number) {
    const shell = this.outline?.shells.find(s => s.folder.Id === id);
    if (!shell) return;
    const previous = this.tasks.get(id);
    const folder = shell.folder;
    const container = this.outline?.containers.tasks.find(c => c.Id === shell.containerId);
    const summary: TaskSummary = { folder, container, inspected: false, partial: false, roleFolders: [], files: [], folders: [], inputs: 0, outputs: 0 };
    const folderFingerprints: Record<string, string> = { [folder.Id]: folderFingerprint(folder) };
    const issues: DiscoveryIssue[] = [];
    try {
      const children = await this.listAll(folder.Id, 2);
      if (gen !== this.generation) return;
      summary.inspected = true; summary.partial = children.truncated;
      // Nearest-boundary reuse: a nested folder whose own fingerprint is unchanged is restored from the previous snapshot instead of being listed again.
      // A folder's ETag/LastModified only vouches for its DIRECT children (OneDrive does not promise a timestamp cascade from deep descendants),
      // so an unchanged folder is reused only when the previous snapshot saw no subfolders under it; otherwise it is re-listed so nested
      // folders get fresh fingerprints of their own. Cost on open = non-leaf folders of the task, never a false cache hit.
      const reuse = (dir: DriveItem, role: FileRole, relative: string) => mode !== 'force' && !!previous && previous.folderFingerprints[dir.Id] !== undefined && previous.folderFingerprints[dir.Id] === folderFingerprint(dir)
        && !previous.summary.folders.some(d => d.role === role && d.parentRelativePath === relative);
      const restore = (dir: DriveItem, role: FileRole, relative: string) => {
        if (!previous) return;
        const prefix = relative ? `${relative}/` : '';
        for (const f of previous.summary.files) if (f.role === role && (relative ? f.relativePath.startsWith(prefix) : !f.relativePath.includes('/'))) { summary.files.push(f); if (role === 'input') summary.inputs++; if (role === 'output') { summary.outputs++; if (!summary.newestOutput || (f.item.LastModified ?? '') > (summary.newestOutput.LastModified ?? '')) summary.newestOutput = f.item; } }
        for (const d of previous.summary.folders) if (d.role === role && d.relativePath.startsWith(prefix) && d.relativePath !== relative) { summary.folders.push(d); folderFingerprints[d.item.Id] = previous.folderFingerprints[d.item.Id] ?? folderFingerprint(d.item); }
        folderFingerprints[dir.Id] = folderFingerprint(dir);
      };
      const walk = async (dir: DriveItem, role: FileRole, relative: string, depth: number) => {
        if (depth > LIMITS.roleDepth || summary.files.length >= LIMITS.roleFiles) { summary.partial = true; return; }
        if (reuse(dir, role, relative)) { restore(dir, role, relative); return; }
        let inner: { items: DriveItem[]; truncated: boolean };
        try { inner = await this.listAll(dir.Id, 2); } catch (error) { summary.partial = true; issues.push({ scope: 'task', path: normalizePath(dir.Path) || `${folder.Name}/${dir.Name}`, message: message(error) }); return; }
        folderFingerprints[dir.Id] = folderFingerprint(dir);
        summary.partial ||= inner.truncated;
        for (const entry of inner.items) {
          const rel = relative ? `${relative}/${entry.Name ?? entry.Id}` : (entry.Name ?? entry.Id);
          if (entry.IsFolder) { summary.folders.push({ item: entry, role, relativePath: rel, parentRelativePath: relative } satisfies TaskFolder); await walk(entry, role, rel, depth + 1); continue; }
          if (summary.files.length >= LIMITS.roleFiles) { summary.partial = true; break; }
          summary.files.push({ item: entry, role, relativePath: rel } satisfies TaskFile);
          if (role === 'input') summary.inputs++;
          if (role === 'output') { summary.outputs++; if (!summary.newestOutput || (entry.LastModified ?? '') > (summary.newestOutput.LastModified ?? '')) summary.newestOutput = entry; }
        }
      };
      for (const child of children.items) {
        if (!child.IsFolder) { summary.files.push({ item: child, role: 'unclassified', relativePath: '' }); continue; }
        const role = classifyFolder(child.Name);
        if (role === 'unclassified') continue;
        summary.roleFolders.push(child);
        await walk(child, role, '', 1);
      }
      if (gen !== this.generation) return;
      const snap: TaskSnapshot = { summary, fingerprint: folderFingerprint(folder), folderFingerprints, syncedAt: this.iso() };
      this.tasks.set(id, snap);
      if (issues.length && this.outline) this.outline.issues = [...this.outline.issues.filter(i => !i.path.toLowerCase().startsWith((normalizePath(folder.Path) || '\u0000').toLowerCase())), ...issues];
      await this.cacheSet(`task|${id}`, snap);
    } catch (error) {
      if (gen !== this.generation) return;
      if (previous) { previous.summary.stale = false; } // keep the last known-good subtree
      if (this.outline) this.outline.issues = [...this.outline.issues.filter(i => i.path !== (normalizePath(folder.Path) || folder.Name || id)), { scope: 'task', path: normalizePath(folder.Path) || folder.Name || id, message: message(error) }];
    }
  }

  // ---- Skills / Memory (lazy, fingerprint-validated at the container and folder boundaries) ----------------------------------
  private skillsRun?: Promise<void>;
  ensureSkills(force = false): Promise<void> {
    if (!this.outline) return Promise.resolve();
    if (this.skillsRun) return this.skillsRun;
    if (!force && this._status.skills === 'ready') return Promise.resolve();
    const gen = this.generation;
    this.skillsRun = (async () => {
      this.emit({ skills: 'loading', skillsError: undefined });
      const containers = this.outline!.containers.skills;
      const prev = this.skillsSnap;
      const next: SkillsSnapshot = { skills: [], containerFingerprints: {}, issues: [], syncedAt: this.iso() };
      try {
        for (const container of containers) {
          next.containerFingerprints[container.Id] = folderFingerprint(container);
          const listing = await this.listAll(container.Id); // one call per container: the nearest boundary for direct skill folders
          if (gen !== this.generation) return;
          const visit = async (dir: DriveItem, depth: number) => {
            if (depth > LIMITS.skillDepth || next.skills.length >= LIMITS.skills) return;
            const cached = prev?.skills.find(s => s.folder.Id === dir.Id);
            if (!force && cached && cached.folderFingerprint === folderFingerprint(dir)) { next.skills.push({ ...cached, folder: dir }); return; } // unchanged skill: no list, no read
            let items: { items: DriveItem[]; truncated: boolean };
            try { items = await this.listAll(dir.Id, 3); } catch (error) { next.issues.push({ scope: 'skill', path: normalizePath(dir.Path) || dir.Name || dir.Id, message: message(error) }); return; }
            if (gen !== this.generation) return;
            const definition = items.items.find(i => !i.IsFolder && /^skill\.md$/i.test(i.Name ?? ''));
            if (definition) {
              const defFp = fileFingerprint(definition);
              let summary = cached && cached.definitionFingerprint === defFp && !force ? cached.summary : undefined; // unchanged SKILL.md: no read
              if (summary === undefined) { try { summary = skillSummary(await this.call('read', () => this.repo.read(definition))); } catch (error) { summary = `SKILL.md could not be read: ${message(error)}`; } }
              next.skills.push({ folder: dir, definition, summary, files: items.items.filter(i => !i.IsFolder), partial: items.truncated, folderFingerprint: folderFingerprint(dir), definitionFingerprint: defFp });
            }
            for (const child of items.items.filter(i => i.IsFolder)) await visit(child, depth + 1);
          };
          for (const child of listing.items.filter(i => i.IsFolder)) await visit(child, 1);
          if (listing.items.some(i => !i.IsFolder && /^skill\.md$/i.test(i.Name ?? ''))) await visit(container, LIMITS.skillDepth);
        }
        if (gen !== this.generation) return;
        this.skillsSnap = next;
        await this.cacheSet('skills', next);
        this.emit({ skills: 'ready', skillsError: undefined });
      } catch (error) { if (gen !== this.generation) return; this.emit({ skills: prev ? 'cached' : 'error', skillsError: message(error) }); }
    })().finally(() => { this.skillsRun = undefined; });
    return this.skillsRun;
  }
  private memoryRun?: Promise<void>;
  ensureMemory(force = false): Promise<void> {
    if (!this.outline) return Promise.resolve();
    if (this.memoryRun) return this.memoryRun;
    if (!force && this._status.memory === 'ready') return Promise.resolve();
    const gen = this.generation;
    this.memoryRun = (async () => {
      this.emit({ memory: 'loading', memoryError: undefined });
      const containers = [...this.outline!.containers.memory.map(c => ({ c, kind: 'memory' as const })), ...this.outline!.containers.config.map(c => ({ c, kind: 'config' as const }))];
      const prev = this.memorySnap;
      const next: MemorySnapshot = { memory: [], folderFingerprints: {}, subfolders: {}, memoryTruncated: false, issues: [], syncedAt: this.iso() };
      try {
        const walk = async (dir: DriveItem, container: DriveItem, kind: 'memory' | 'config', depth: number) => {
          if (depth > LIMITS.memoryDepth || next.memory.length >= LIMITS.memoryFiles) { next.memoryTruncated = true; return; }
          const fp = folderFingerprint(dir);
          const dirPath = normalizePath(dir.Path).toLowerCase();
          const prevSubfolders = prev?.subfolders?.[dir.Id];
          if (!force && prev && depth > 1 && prev.folderFingerprints[dir.Id] === fp && prevSubfolders !== undefined && prevSubfolders.length === 0) {
            // unchanged LEAF folder (no subfolders last time): its fingerprint vouches for its direct files, restore them without listing
            for (const e of prev.memory) if (normalizePath(e.item.Path).toLowerCase().startsWith(dirPath + '/')) next.memory.push(e);
            next.folderFingerprints[dir.Id] = fp; next.subfolders![dir.Id] = []; return;
          }
          let listing: { items: DriveItem[]; truncated: boolean };
          try { listing = await this.listAll(dir.Id); } catch (error) { next.issues.push({ scope: kind, path: normalizePath(dir.Path) || dir.Name || dir.Id, message: message(error) }); return; }
          if (gen !== this.generation) return;
          next.folderFingerprints[dir.Id] = fp; next.memoryTruncated ||= listing.truncated;
          next.subfolders![dir.Id] = listing.items.filter(i => i.IsFolder).map(i => i.Id);
          for (const item of listing.items) { if (item.IsFolder) await walk(item, container, kind, depth + 1); else if (next.memory.length < LIMITS.memoryFiles) next.memory.push({ item, container, kind }); else next.memoryTruncated = true; }
        };
        for (const { c, kind } of containers) await walk(c, c, kind, 1); // container itself is always listed (one call): the nearest boundary for direct files
        if (gen !== this.generation) return;
        this.memorySnap = next;
        await this.cacheSet('memory', next);
        this.emit({ memory: 'ready', memoryError: undefined });
      } catch (error) { if (gen !== this.generation) return; this.emit({ memory: prev ? 'cached' : 'error', memoryError: message(error) }); }
    })().finally(() => { this.memoryRun = undefined; });
    return this.memoryRun;
  }
  /** Low-priority idle work after the outline: skills and memory discovery, cancellable by dispose/start. */
  private scheduleIdle(gen: number) {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const delay = this.options.idleDelayMs ?? 4000;
    if (delay < 0) return;
    this.idleTimer = setTimeout(() => { if (gen !== this.generation) return; if (this._status.skills === 'idle') void this.ensureSkills(); if (this._status.memory === 'idle') void this.ensureMemory(); }, delay);
  }

  // ---- Explicit cache operations -------------------------------------------------------------------------------------------
  /** Full rescan: ignore fingerprints, re-list every task subtree, skills and memory, with progress; cached content stays visible meanwhile. */
  fullRescan() { if (!this.rootId) return Promise.resolve(); return this.revalidate(this.generation, 'rescanning', true); }
  /** Clear cached data for every root, drop in-memory snapshots and start cold. */
  async clearCache() { const path = this.rootPath; this.dispose(); await this.cache.clear(); this.outline = undefined; this.tasks.clear(); this.skillsSnap = undefined; this.memorySnap = undefined; this.emit({ source: 'none', lastSyncedAt: undefined, skills: 'idle', memory: 'idle' }); if (path) await this.start(path); }
  async clearRootCache() { if (this.rootId) await this.cache.deleteByPrefix(rootPrefix(this.rootId)); }

  // ---- Layout projection (same shape the UI already consumes) ---------------------------------------------------------------
  private build(): CoworkLayout | undefined {
    const o = this.outline;
    if (!o) return undefined;
    const tasks = o.shells.map(s => this.tasks.get(s.folder.Id)?.summary ?? { folder: s.folder, container: o.containers.tasks.find(c => c.Id === s.containerId), inspected: false, partial: false, roleFolders: [], files: [], folders: [], inputs: 0, outputs: 0 } satisfies TaskSummary);
    const skills = this.skillsSnap?.skills ?? [];
    const memory = this.memorySnap?.memory ?? [];
    const observed = new Map<string, DriveItem>();
    const see = (items: DriveItem[]) => { for (const i of items) observed.set(i.Id, i); };
    see([o.root, ...Object.values(o.containers).flat(), ...o.rootFiles, ...o.shells.map(s => s.folder)]);
    for (const t of tasks) see([...t.roleFolders, ...t.folders.map(f => f.item), ...t.files.map(f => f.item)]);
    for (const s of skills) see([s.folder, ...(s.definition ? [s.definition] : []), ...s.files]);
    see(memory.map(m => m.item));
    const issues = [...o.issues, ...(this.skillsSnap?.issues ?? []), ...(this.memorySnap?.issues ?? [])];
    return { root: o.root, rootPath: o.rootPath, containers: o.containers, rootFiles: o.rootFiles, flatLayout: o.flatLayout, tasks, tasksTruncated: o.tasksTruncated, skills, memory, memoryTruncated: this.memorySnap?.memoryTruncated ?? false, issues, observed: [...observed.values()], completedAt: this._status.lastSyncedAt ?? o.syncedAt };
  }
}
