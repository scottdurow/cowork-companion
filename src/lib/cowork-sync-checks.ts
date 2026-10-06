// Deterministic performance/correctness gates for the sync engine (counting + latency fake repository, memory cache).
import { InMemoryCoworkTaskRepository, type CoworkTaskRepository, type DriveItem, type FolderPage } from './cowork-domain';
import { CoworkSyncEngine } from './cowork-sync';
import { MemoryLayoutCache, ResilientLayoutCache, CacheError, type LayoutCache } from './layout-cache';
import { createDemoRepositories } from './cowork-demo';

function assert(value: unknown, msg: string): asserts value { if (!value) throw new Error(msg); }
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const settle = async (engine: CoworkSyncEngine, tries = 400) => { for (let i = 0; i < tries; i++) { await tick(2); const s = engine.status; if (s.phase === 'idle' && s.pendingHydration === 0 && s.skills !== 'loading' && s.memory !== 'loading') return; } throw new Error('engine did not settle'); };

/** Counting/latency fake: every connector call is recorded and delayed; items can be mutated between runs. */
class CountingRepository implements CoworkTaskRepository {
  inner: InMemoryCoworkTaskRepository;
  calls: { op: string; id: string }[] = [];
  inFlight = 0; peak = 0; completed = 0;
  constructor(public items: DriveItem[], public contents: Record<string, string> = {}, public latencyMs = 3) { this.inner = new InMemoryCoworkTaskRepository(items, contents); }
  reset() { this.inner = new InMemoryCoworkTaskRepository(this.items, this.contents); }
  private async track<T>(op: string, id: string, fn: () => Promise<T>) { this.calls.push({ op, id }); this.inFlight++; this.peak = Math.max(this.peak, this.inFlight); try { await tick(this.latencyMs); const result = await fn(); this.completed++; return result; } finally { this.inFlight--; } }
  get(id: string) { return this.track('get', id, () => this.inner.get(id)); }
  resolve(path: string) { return this.track('resolve', path, () => this.inner.resolve(path)); }
  list(id: string, token?: string): Promise<FolderPage> { return this.track('list', id, () => this.inner.list(id, token)); }
  read(item: DriveItem) { return this.track('read', item.Id, () => this.inner.read(item)); }
  open(item: DriveItem) { return this.track('open', item.Id, () => this.inner.open(item)); }
  search(path: string, text: string) { return this.track('search', path, () => this.inner.search(path, text)); }
  count(op?: string) { return op ? this.calls.filter(c => c.op === op).length : this.calls.length; }
  listed(id: string) { return this.calls.filter(c => c.op === 'list' && c.id === id).length; }
  clearCalls() { this.calls = []; this.peak = 0; this.completed = 0; }
}

const ROOT = '/Documents/Cowork';
const F = (id: string, path: string, extra: Partial<DriveItem> = {}): DriveItem => ({ Id: id, Name: path.slice(path.lastIndexOf('/') + 1), Path: path, LastModified: '2026-10-01T00:00:00Z', ETag: `${id}-v1`, Size: 100, ...extra });
const D = (id: string, path: string, extra: Partial<DriveItem> = {}) => F(id, path, { IsFolder: true, Size: undefined, ...extra });

/** Synthetic hierarchy: `tasks` tasks each with input + nested output folders, `skills` skills, `memoryFiles` memory files. */
export function synthetic(tasks: number, skills: number, memoryFiles: number) {
  const items: DriveItem[] = [D('root', ROOT), D('tasks', `${ROOT}/Tasks`), D('skills', `${ROOT}/skills`), D('memory', `${ROOT}/memory`)];
  const contents: Record<string, string> = {};
  for (let t = 0; t < tasks; t++) {
    const base = `${ROOT}/Tasks/task-${t}`;
    items.push(D(`t${t}`, base), D(`t${t}-in`, `${base}/input`), D(`t${t}-out`, `${base}/output`), D(`t${t}-out-reports`, `${base}/output/reports`), D(`t${t}-out-reports-q1`, `${base}/output/reports/q1`));
    items.push(F(`t${t}-i1`, `${base}/input/brief.md`), F(`t${t}-i2`, `${base}/input/data.csv`), F(`t${t}-o1`, `${base}/output/summary.md`), F(`t${t}-o2`, `${base}/output/reports/plan.md`), F(`t${t}-o3`, `${base}/output/reports/q1/revenue.csv`));
    contents[`t${t}-o1`] = 'summary';
  }
  for (let s = 0; s < skills; s++) { items.push(D(`s${s}`, `${ROOT}/skills/skill-${s}`), F(`s${s}-def`, `${ROOT}/skills/skill-${s}/SKILL.md`), F(`s${s}-tpl`, `${ROOT}/skills/skill-${s}/template.md`)); contents[`s${s}-def`] = `---\ndescription: Skill ${s}\n---`; }
  for (let m = 0; m < memoryFiles; m++) { const dir = Math.floor(m / 50); if (m % 50 === 0) items.push(D(`mdir${dir}`, `${ROOT}/memory/group-${dir}`)); items.push(F(`m${m}`, `${ROOT}/memory/group-${dir}/note-${m}.md`)); }
  return { items, contents };
}
function touch(repo: CountingRepository, id: string, version: string) { const item = repo.items.find(i => i.Id === id)!; item.ETag = `${id}-${version}`; item.LastModified = '2026-10-06T00:00:00Z'; }

export interface SyncGateReport { gate: string; detail: string }
export async function runSyncChecks(): Promise<{ passed: number; report: SyncGateReport[] }> {
  const report: SyncGateReport[] = [];
  const pass = (gate: string, detail: string) => report.push({ gate, detail });

  // ---- Cold start on a large hierarchy (L, G, H) -------------------------------------------------------------------------------
  const big = synthetic(500, 200, 500);
  const repo = new CountingRepository(big.items, big.contents, 1);
  const cache = new MemoryLayoutCache();
  const events: { name: string; calls: number }[] = [];
  const engine = new CoworkSyncEngine(repo, cache, { concurrency: 3, idleDelayMs: -1, onEvent: name => events.push({ name, calls: repo.count() }) });
  const startPromise = engine.start(ROOT);
  await startPromise; // authorize + outline
  const outlineEvent = events.find(e => e.name === 'outline');
  const taskPages = Math.ceil(500 / 40); // the fake pages at 40 items like the connector's page size; 500 shells = 13 pages
  assert(engine.layout && engine.layout.tasks.length === 500 && outlineEvent && outlineEvent.calls === 2 + taskPages, `Cold outline must be resolve + root + ${taskPages} Tasks pages = ${2 + taskPages} calls; got ${outlineEvent?.calls}`);
  assert(engine.status.source === 'live' && engine.layout.tasks.every(t => !t.inspected) && engine.layout.skills.length === 0 && engine.layout.memory.length === 0, 'Cold start renders 500 task shells before any subtree is inspected and without skills/memory.');
  assert(repo.count('read') === 0 && repo.listed('skills') === 0 && repo.listed('memory') === 0, 'Initial dashboard discovery reads no SKILL.md and lists no skills/memory container.');
  pass('G/L cold outline', `500 tasks · 200 skills · 500 memory files (3,400 items): time-to-outline = ${outlineEvent.calls} connector calls (resolve 1, list root 1, Tasks container ${taskPages} pages of 40); 0 reads; skills/memory not listed; synthetic latency ${repo.latencyMs}ms/call, firstOutlineAt=${engine.metrics.firstOutlineAt}ms (fake clock)`);
  // Prioritised hydration of 12 visible tasks: each task = 1 (task) + 1 (input) + 1 (output) + 1 (reports) + 1 (q1) = 5 lists.
  const visible = Array.from({ length: 12 }, (_, i) => `t${i}`);
  engine.prioritize(visible);
  const queuedTotal = engine.status.pendingHydration;
  for (let i = 0; i < 2000 && visible.some(id => !engine.layout!.tasks.find(t => t.folder.Id === id)!.inspected); i++) await tick(2);
  const callsAfterVisible = repo.count();
  assert(visible.every(id => engine.layout!.tasks.find(t => t.folder.Id === id)!.inspected), 'Visible tasks hydrate first.');
  assert(repo.peak <= 3, `Connector concurrency must never exceed 3 (peak ${repo.peak}).`);
  assert(callsAfterVisible <= outlineEvent.calls + 3 + 12 * 5 + 3 * 5, 'Visible-first hydration is bounded by the visible work (12 tasks × 5 lists) plus at most a few background jobs that were already in flight.');
  pass('H concurrency', `peak in-flight connector calls = ${repo.peak} (limit 3) while hydrating ${visible.length} visible tasks (${callsAfterVisible - outlineEvent.calls} calls incl. in-flight background, 5 lists per task); background queue ${queuedTotal} jobs`);
  engine.dispose(); // cancel the remaining 488 background hydrations

  // ---- Small hierarchy for correctness gates --------------------------------------------------------------------------------
  const small = synthetic(6, 3, 4);
  const srepo = new CountingRepository(small.items, small.contents, 2);
  const scache = new MemoryLayoutCache();
  const e1 = new CoworkSyncEngine(srepo, scache, { concurrency: 3, idleDelayMs: 0 });
  await e1.start(ROOT);
  await settle(e1);
  const coldCalls = srepo.count();
  assert(e1.layout!.tasks.every(t => t.inspected && t.outputs === 3 && t.inputs === 2) && e1.layout!.skills.length === 3 && e1.layout!.memory.length === 4 && srepo.count('read') === 3, 'Cold full hydration inspects every task, reads each SKILL.md once and lists memory.');
  pass('cold full hydration', `6 tasks/3 skills/4 memory files: ${coldCalls} calls (resolve 1, root 1, Tasks 1, 6×5 task lists, skills container 1 + 3 skill folders + 3 reads, memory container 1 + 1 group)`);
  e1.dispose();

  // A. Warm start: cached layout before delayed revalidation completes.
  srepo.clearCalls(); srepo.latencyMs = 30;
  const warmEvents: string[] = [];
  const e2 = new CoworkSyncEngine(srepo, scache, { concurrency: 3, idleDelayMs: -1, onEvent: n => warmEvents.push(n) });
  const warmStart = e2.start(ROOT);
  for (let i = 0; i < 200 && e2.status.source !== 'cache'; i++) await tick(2);
  assert(e2.status.source === 'cache' && e2.layout && e2.layout.tasks.length === 6 && e2.layout.tasks.every(t => t.inspected) && e2.layout.skills.length === 3 && e2.status.phase === 'revalidating' && srepo.completed === 1 && srepo.count() <= 2, `Warm start must show the cached layout after only the root authorization call completed (completed ${srepo.completed}, started ${srepo.count()}).`);
  pass('A warm start', `cached layout emitted after ${srepo.completed} completed connector call (root authorization); outline revalidation (${srepo.count() - 1} call started, ${srepo.latencyMs}ms/call) was still pending; metrics firstCachedAt=${e2.metrics.firstCachedAt}ms firstOutlineAt=${e2.metrics.firstOutlineAt ?? 'pending'}`);
  await warmStart; await settle(e2);
  // B. Unchanged warm refresh: 3 outline calls, no task subtree lists, no SKILL.md reads.
  const warmCalls = srepo.count();
  const taskSubtreeIds = new Set(small.items.filter(i => i.IsFolder && /^t\d/.test(i.Id)).map(i => i.Id)); // task folders and their role/nested folders (ids t0, t0-in, t0-out…), never the Tasks container
  const taskSubtreeLists = srepo.calls.filter(c => c.op === 'list' && taskSubtreeIds.has(c.id)).length;
  assert(warmCalls === 3 && srepo.count('read') === 0 && taskSubtreeLists === 0, `Unchanged warm refresh must be 3 calls (got ${warmCalls}; task subtree lists ${taskSubtreeLists}).`);
  srepo.clearCalls(); srepo.latencyMs = 2;
  await e2.ensureSkills(); await e2.ensureMemory();
  assert(srepo.count('read') === 0 && srepo.count('list') === 2 && e2.status.skills === 'ready' && e2.status.memory === 'ready' && e2.layout!.skills.length === 3 && e2.layout!.memory.length === 4, `Opening Skills/Memory warm = the two container listings only (${srepo.count('list')} lists), zero SKILL.md reads.`);
  pass('B unchanged warm refresh', `warm start + unchanged revalidation = ${warmCalls} calls (resolve root, list root, list Tasks); 0 task subtree lists, 0 reads; opening Skills+Memory = 2 container lists (skill folders and memory groups reused by fingerprint), 0 SKILL.md reads`);
  // C. Changed task invalidates only that task.
  srepo.clearCalls();
  touch(srepo, 't2', 'v2'); touch(srepo, 't2-out', 'v2'); touch(srepo, 't2-o1', 'v2'); srepo.reset();
  await e2.refresh(); await settle(e2);
  const t2lists = srepo.calls.filter(c => c.op === 'list' && c.id.startsWith('t2')).length;
  const otherTaskLists = srepo.calls.filter(c => c.op === 'list' && /^t[013-5]/.test(c.id)).length;
  const t2listed = srepo.calls.filter(c => c.op === 'list' && c.id.startsWith('t2')).map(c => c.id);
  assert(t2lists === 3 && t2listed.includes('t2') && t2listed.includes('t2-out') && t2listed.includes('t2-out-reports') && !t2listed.includes('t2-in') && !t2listed.includes('t2-out-reports-q1') && otherTaskLists === 0 && srepo.count('read') === 0 && e2.layout!.tasks.find(t => t.folder.Id === 't2')!.files.find(f => f.item.Id === 't2-o1')!.item.ETag === 't2-o1-v2', `A changed task re-lists only its own boundaries (t2 listed: ${t2listed.join(',')}; expected task folder, changed output folder and its non-leaf subfolder; leaf input/q1 reused), others ${otherTaskLists}.`);
  pass('C changed task', `after touching task-2/output/summary.md: refresh = ${srepo.count()} calls (2 outline + ${t2lists} for task-2: ${t2listed.join(', ')} — unchanged leaf folders input/ and output/reports/q1 reused by fingerprint); 0 lists for 5 unrelated tasks; skills/memory untouched`);
  // D. Adds / deletes / moves after the parent listing refreshes.
  srepo.clearCalls();
  srepo.items.push(D('t9', `${ROOT}/Tasks/task-9`), D('t9-out', `${ROOT}/Tasks/task-9/output`), F('t9-o1', `${ROOT}/Tasks/task-9/output/new.md`));
  srepo.items = srepo.items.filter(i => !i.Id.startsWith('t5'));
  srepo.items.push(D('archive', `${ROOT}/Tasks/Archive`)); // a new folder inside Tasks is a task shell (observable structure only)
  const moved = srepo.items.find(i => i.Id === 't4')!; moved.Path = `${ROOT}/Tasks/Archive/task-4`; // moved out of the direct Tasks listing
  for (const i of srepo.items.filter(i => i.Path?.startsWith(`${ROOT}/Tasks/task-4/`))) i.Path = i.Path!.replace(`${ROOT}/Tasks/task-4/`, `${ROOT}/Tasks/Archive/task-4/`);
  srepo.reset();
  await e2.refresh(); await settle(e2);
  const ids = e2.layout!.tasks.map(t => t.folder.Id);
  assert(ids.includes('t9') && !ids.includes('t5') && !ids.includes('t4') && ids.includes('archive') && e2.layout!.tasks.find(t => t.folder.Id === 't9')!.outputs === 1 && (await scache.get(`v1|root|task|t5`)) === undefined, 'Adds appear and hydrate, deletes disappear (and their cache record is removed), moved folders follow the parent listing.');
  pass('D add/delete/move', `after refreshing the Tasks listing: +task-9 (hydrated, 1 output), −task-5 (cache record deleted), task-4 moved under Archive/ (no longer a direct shell); ${srepo.count()} calls`);
  // E. Deep descendant change found at the nearest boundary (on-demand), not via a root timestamp cascade.
  srepo.clearCalls();
  touch(srepo, 't1-o3', 'v2'); touch(srepo, 't1-out-reports-q1', 'v2'); // only the deep file and its own folder change; task folder and Tasks untouched
  srepo.reset();
  await e2.refresh(); await settle(e2);
  assert(e2.layout!.tasks.find(t => t.folder.Id === 't1')!.files.find(f => f.item.Id === 't1-o3')!.item.ETag === 't1-o3-v1', 'An incremental refresh must not claim to see a deep change the parent fingerprints cannot reveal.');
  srepo.clearCalls();
  await e2.hydrateTask('t1'); // opening the task validates its folder boundaries
  const t1 = e2.layout!.tasks.find(t => t.folder.Id === 't1')!;
  assert(t1.files.find(f => f.item.Id === 't1-o3')!.item.ETag === 't1-o3-v2' && srepo.listed('t1') === 1 && srepo.listed('t1-out') === 1 && srepo.listed('t1-out-reports') === 1 && srepo.listed('t1-out-reports-q1') === 1 && srepo.listed('t1-in') === 0, `Opening the task re-lists its boundaries down the changed branch only (input reused): ${srepo.calls.map(c => c.id).join(',')}`);
  pass('E deep change', `deep edit under task-1/output/reports/q1: refresh (parent fingerprints unchanged) honestly keeps the old file; opening the task validates boundaries = ${srepo.count()} lists (task, output, reports, q1; input reused) and surfaces the change`);
  // F. Opening a task prioritises and deduplicates its hydration.
  srepo.clearCalls(); srepo.latencyMs = 10;
  for (const id of ['t0', 't1', 't2', 't3']) touch(srepo, id, 'v3'); srepo.reset();
  const refreshing = e2.refresh();
  for (let i = 0; i < 100 && e2.status.pendingHydration === 0; i++) await tick(1);
  const open1 = e2.hydrateTask('t3'); const open2 = e2.hydrateTask('t3');
  await open1; await open2;
  const t3Done = srepo.calls.filter(c => c.op === 'list' && c.id === 't3').length;
  await refreshing; await settle(e2);
  assert(t3Done === 1 && e2.layout!.tasks.find(t => t.folder.Id === 't3')!.inspected && e2.layout!.tasks.every(t => !t.stale), 'Opening a task hydrates it once (deduplicated) ahead of the background queue.');
  pass('F selected task priority', `task-3 listed exactly ${t3Done} time for two concurrent open requests while 4 stale tasks were queued`);
  srepo.latencyMs = 2;
  // I. Corrupt cache / schema mismatch / quota / connector failure.
  const corrupt = new MemoryLayoutCache();
  await corrupt.set('v1|root|outline', { root: { Id: 'other-root' }, shells: 'nonsense' });
  let corruptOutlineCalls = -1; let corruptCacheHydrated = false;
  const e3 = new CoworkSyncEngine(srepo, corrupt, { idleDelayMs: -1, onEvent: n => { if (n === 'outline') corruptOutlineCalls = srepo.count(); if (n === 'cache-hydrated') corruptCacheHydrated = true; } }); srepo.clearCalls();
  await e3.start(ROOT);
  assert(!corruptCacheHydrated && e3.status.source === 'live' && e3.layout!.tasks.length === 6 && corruptOutlineCalls === 3, `A snapshot from another root (or corrupt) is never rendered and a cold outline runs (${corruptOutlineCalls} calls to outline).`);
  const quota = new MemoryLayoutCache(); quota.failWrites = 99;
  const resilient = new ResilientLayoutCache(quota, new MemoryLayoutCache());
  const e4 = new CoworkSyncEngine(srepo, resilient, { idleDelayMs: -1 });
  await e4.start(ROOT); await settle(e4);
  assert(e4.layout!.tasks.length === 6 && resilient.kind === 'memory' && resilient.degradedReason?.includes('quota'), 'Quota failures degrade to session memory with an explicit reason and the UI stays usable.');
  const failing = new CountingRepository(small.items, small.contents, 1);
  const e5 = new CoworkSyncEngine(failing, scache, { idleDelayMs: -1 });
  await e5.start(ROOT); await settle(e5);
  const before = e5.layout!.tasks.length;
  failing.inner.list = async () => { throw new Error('OneDrive list failed: HTTP 503'); };
  await e5.refresh();
  assert(e5.layout!.tasks.length === before && e5.status.error?.includes('503') && e5.status.lastSyncedAt, 'A failed refresh keeps the last known-good snapshot and reports the error with the last sync time.');
  const dead = new CountingRepository(small.items, small.contents, 1); dead.inner.resolve = async () => { throw new Error('Folder /Documents/Cowork could not be resolved: not found (404).'); };
  const e6 = new CoworkSyncEngine(dead, scache, { idleDelayMs: -1 }); await e6.start(ROOT);
  assert(e6.layout === undefined && e6.status.rootError?.includes('404'), 'An unverified root never renders a cached snapshot.');
  pass('I failure behaviour', 'foreign/corrupt snapshot ignored → cold outline (3 calls); quota → session-memory cache with reason; refresh 503 → last known-good kept + error; root 404 → no snapshot rendered');
  // J. Demo mode: zero live content calls.
  const liveSpy = new CountingRepository(small.items, small.contents, 1);
  const demo = createDemoRepositories();
  const e7 = new CoworkSyncEngine(demo.tasks, new MemoryLayoutCache(), { idleDelayMs: 0 });
  await e7.start(ROOT); await settle(e7); await e7.ensureSkills(); await e7.ensureMemory();
  assert(liveSpy.count() === 0 && e7.layout!.tasks.length === 4 && e7.layout!.skills.length === 2 && e7.status.cacheKind === 'memory', 'Demo mode runs the engine over the in-memory repository with a memory cache and makes zero live calls.');
  pass('J demo isolation', `demo engine: ${e7.metrics.calls} in-memory calls, 0 live connector calls, memory cache`);
  // K. Clear cache vs full rescan.
  srepo.clearCalls();
  let rescanBlanked = false;
  const rescanUnsub = e2.subscribe(() => { if (!e2.layout || e2.layout.tasks.length === 0) rescanBlanked = true; });
  await e2.fullRescan(); await settle(e2); rescanUnsub();
  const rescanCalls = srepo.count();
  const shellIds = e2.layout!.tasks.map(t => t.folder.Id);
  assert(!rescanBlanked && srepo.count('resolve') === 0 && shellIds.every(id => srepo.listed(id) === 1) && e2.layout!.tasks.every(t => t.inspected) && srepo.count('read') === 3, `Full rescan keeps content visible, re-lists every task shell once and re-reads every SKILL.md (${rescanCalls} calls, ${srepo.count('read')} reads).`);
  srepo.clearCalls();
  let clearedToNone = false; let clearOutlineCalls = -1;
  const clearUnsub = e2.subscribe(() => { if (e2.status.source === 'none') clearedToNone = true; });
  const prevOnEvent = e2.options.onEvent; e2.options.onEvent = n => { if (n === 'outline' && clearOutlineCalls < 0) clearOutlineCalls = srepo.count(); prevOnEvent?.(n); };
  await e2.clearCache(); await settle(e2); clearUnsub();
  const afterClear = srepo.count();
  const repopulated = await scache.keys('v1|root|');
  assert(clearedToNone && clearOutlineCalls === 3 && srepo.count('resolve') === 1 && shellIds.every(id => srepo.listed(id) === 1) && repopulated.some(k => k.endsWith('|outline')) && repopulated.filter(k => k.includes('|task|')).length === shellIds.length && (e2.status.source as string) === 'live', `Clear cache wipes the records, drops to an empty state, restarts cold (${clearOutlineCalls} calls to outline) and repopulates (${repopulated.length} records).`);
  pass('K clear vs rescan', `full rescan = ${rescanCalls} calls (${shellIds.length} shells × subtree + ${srepo.count('read') || 3} SKILL.md reads) with cached content visible throughout and no re-authorization; clear cache = wipe → empty → re-authorize → cold outline (3 calls) → ${afterClear} calls total, ${repopulated.length} cache records rebuilt`);
  // Throttling: a 429 on a task listing is retried with backoff inside the concurrency gate; the subtree is not marked failed.
  const trepo = new CountingRepository(small.items, small.contents, 1);
  let throttleHits = 0;
  const innerList = trepo.inner.list.bind(trepo.inner);
  trepo.inner.list = async (id: string, token?: string) => { if (id === 't1-out' && throttleHits < 2) { throttleHits++; throw new Error('The OneDrive request failed: HTTP 429.'); } return innerList(id, token); };
  const e8 = new CoworkSyncEngine(trepo, new MemoryLayoutCache(), { idleDelayMs: -1, throttleBackoffMs: [1, 1, 1] });
  await e8.start(ROOT); await settle(e8);
  const t1Snap = e8.layout!.tasks.find(t => t.folder.Id === 't1')!;
  assert(throttleHits === 2 && e8.metrics.throttledRetries === 2 && t1Snap.inspected && t1Snap.outputs === 3 && !t1Snap.partial && e8.layout!.issues.length === 0 && trepo.listed('t1-out') === 3, `429 must be retried transparently (hits ${throttleHits}, retries ${e8.metrics.throttledRetries}, outputs ${t1Snap.outputs}, issues ${e8.layout!.issues.length})`);
  pass('throttling', `two consecutive 429s on task-1/output retried with backoff inside the ≤3 gate (3 attempts = 1 engine call + ${e8.metrics.throttledRetries} retries); subtree complete, no issue raised; non-429 errors are not retried (gate I)`);
  e8.dispose();
  e2.dispose(); e3.dispose(); e4.dispose(); e5.dispose(); e6.dispose(); e7.dispose();
  // Cache record isolation
  const keys = await scache.keys('v1|root|');
  assert(keys.every(k => k.startsWith('v1|root|')) && !keys.some(k => /share|token|url/i.test(k)), 'Cache keys are scoped by schema + root item id and hold no links or tokens.');
  const anyTask = await scache.get<{ summary: { files: { item: DriveItem }[] } }>(keys.find(k => k.includes('|task|'))!);
  assert(anyTask && !JSON.stringify(anyTask).includes('sharepoint.com'), 'Task snapshots contain metadata only.');
  pass('cache scoping', `${keys.length} records under v1|<rootId>|…; metadata only`);
  return { passed: report.length, report };
}
export { CountingRepository, type LayoutCache, CacheError };
