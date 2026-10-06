// Layout discovery for a Cowork root folder. Works purely through the CoworkTaskRepository
// contract (live OneDrive or in-memory), so the UI never touches the connector. Everything here
// is observable folder structure: container names are matched case-insensitively, nothing is
// assumed about which containers exist, and every per-path failure is recorded as an issue
// instead of failing unrelated sections.
import { classifyFolder, skillSummary, type CoworkTaskRepository, type DriveItem, type FileRole } from '@/lib/cowork-domain';

export type ContainerKind = 'tasks' | 'skills' | 'memory' | 'config';
export interface DiscoveryIssue { scope: ContainerKind | 'root' | 'task' | 'skill'; path: string; message: string }
/** `relativePath` is the path inside the input/output folder (e.g. "reports/q1/summary.md"); '' for unclassified direct files. */
export interface TaskFile { item: DriveItem; role: FileRole; relativePath: string }
/** A sub-folder observed inside an input/output folder; `relativePath` is its own path inside that folder. */
export interface TaskFolder { item: DriveItem; role: FileRole; relativePath: string; parentRelativePath: string }
export interface TaskSummary {
  folder: DriveItem;
  container?: DriveItem;
  inspected: boolean;
  partial: boolean;
  /** Set by the sync engine when the folder fingerprint changed and a cached summary is shown until re-hydration completes. */
  stale?: boolean;
  roleFolders: DriveItem[];
  files: TaskFile[];
  folders: TaskFolder[];
  inputs: number;
  outputs: number;
  newestOutput?: DriveItem;
}
export interface SkillSummary { folder: DriveItem; definition?: DriveItem; summary: string; files: DriveItem[]; partial: boolean }
/** Fingerprints from observable metadata only: ETag when present, else LastModified (+ size for files). */
export function folderFingerprint(item: Pick<DriveItem, 'ETag' | 'LastModified'>) { return item.ETag ?? item.LastModified ?? ''; }
export function fileFingerprint(item: Pick<DriveItem, 'ETag' | 'LastModified' | 'Size'>) { return `${item.ETag ?? item.LastModified ?? ''}|${item.Size ?? ''}`; }
export interface MemoryEntry { item: DriveItem; container: DriveItem; kind: 'memory' | 'config' }
export interface CoworkLayout {
  root: DriveItem;
  rootPath: string;
  containers: Record<ContainerKind, DriveItem[]>;
  rootFiles: DriveItem[];
  flatLayout: boolean;
  tasks: TaskSummary[];
  tasksTruncated: boolean;
  skills: SkillSummary[];
  memory: MemoryEntry[];
  memoryTruncated: boolean;
  issues: DiscoveryIssue[];
  observed: DriveItem[];
  completedAt: string;
}

export const containerPatterns: Record<ContainerKind, RegExp> = {
  tasks: /^\.?tasks?$/i,
  skills: /^\.?skills?$/i,
  memory: /^\.?memor(y|ies)$/i,
  config: /^\.?(config|configs|settings)$/i,
};
export function containerKind(name?: string): ContainerKind | undefined {
  for (const kind of Object.keys(containerPatterns) as ContainerKind[]) if (containerPatterns[kind].test(name ?? '')) return kind;
  return undefined;
}
export const isSkillDefinition = (name?: string) => /^skill\.md$/i.test(name ?? '');
export const normalizePath = (path?: string) => (path ?? '').replace(/\/+$/, '');

const LIMITS = { pagesPerFolder: 20, inspectedTasks: 60, skillDepth: 4, skills: 200, memoryDepth: 6, memoryFiles: 500, roleDepth: 4, roleFiles: 400 };

function message(error: unknown) {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : 'The folder could not be read.';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export class CoworkDiscoveryService {
  constructor(private files: CoworkTaskRepository) {}

  private async listAll(id: string, maxPages = LIMITS.pagesPerFolder) {
    const items: DriveItem[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      const page = await this.files.list(id, token);
      items.push(...page.items);
      token = page.nextToken;
      pages += 1;
    } while (token && pages < maxPages);
    return { items, truncated: !!token };
  }

  async discover(rootPath: string): Promise<CoworkLayout> {
    const issues: DiscoveryIssue[] = [];
    const observed = new Map<string, DriveItem>();
    const see = (items: DriveItem[]) => { for (const item of items) observed.set(item.Id, item); };
    const root = await this.files.resolve(rootPath); // a root failure is the one error that fails the whole discovery
    see([root]);
    const rootListing = await this.listAll(root.Id);
    see(rootListing.items);
    const containers: Record<ContainerKind, DriveItem[]> = { tasks: [], skills: [], memory: [], config: [] };
    const otherFolders: DriveItem[] = [];
    for (const item of rootListing.items.filter(i => i.IsFolder)) {
      const kind = containerKind(item.Name);
      if (kind) containers[kind].push(item); else otherFolders.push(item);
    }
    const rootFiles = rootListing.items.filter(i => !i.IsFolder);
    if (rootListing.truncated) issues.push({ scope: 'root', path: rootPath, message: `Only the first ${LIMITS.pagesPerFolder} pages of the root folder were read.` });

    // Tasks: children of every task container; a flat layout (no container) treats other root folders as tasks.
    const flatLayout = containers.tasks.length === 0;
    const taskFolders: { folder: DriveItem; container?: DriveItem }[] = [];
    let tasksTruncated = false;
    if (flatLayout) {
      taskFolders.push(...otherFolders.map(folder => ({ folder })));
    } else {
      for (const container of containers.tasks) {
        try {
          const listing = await this.listAll(container.Id);
          see(listing.items);
          tasksTruncated ||= listing.truncated;
          taskFolders.push(...listing.items.filter(i => i.IsFolder).map(folder => ({ folder, container })));
        } catch (error) {
          issues.push({ scope: 'tasks', path: normalizePath(container.Path) || `${rootPath}/${container.Name}`, message: message(error) });
        }
      }
    }
    const tasks: TaskSummary[] = [];
    for (const [position, { folder, container }] of taskFolders.entries()) {
      const summary: TaskSummary = { folder, container, inspected: false, partial: false, roleFolders: [], files: [], folders: [], inputs: 0, outputs: 0 };
      if (position < LIMITS.inspectedTasks) {
        try {
          const children = await this.listAll(folder.Id, 2);
          see(children.items);
          summary.inspected = true;
          summary.partial = children.truncated;
          // Input/output folders are walked recursively (bounded) so nested output folders keep their hierarchy.
          const walkRole = async (dir: DriveItem, role: FileRole, relative: string, depth: number) => {
            if (depth > LIMITS.roleDepth || summary.files.length >= LIMITS.roleFiles) { summary.partial = true; return; }
            let inner: { items: DriveItem[]; truncated: boolean };
            try { inner = await this.listAll(dir.Id, 2); } catch (error) { summary.partial = true; issues.push({ scope: 'task', path: normalizePath(dir.Path) || `${folder.Name}/${dir.Name}`, message: message(error) }); return; }
            see(inner.items);
            summary.partial ||= inner.truncated;
            for (const entry of inner.items) {
              const rel = relative ? `${relative}/${entry.Name ?? entry.Id}` : (entry.Name ?? entry.Id);
              if (entry.IsFolder) { summary.folders.push({ item: entry, role, relativePath: rel, parentRelativePath: relative }); await walkRole(entry, role, rel, depth + 1); continue; }
              if (summary.files.length >= LIMITS.roleFiles) { summary.partial = true; break; }
              summary.files.push({ item: entry, role, relativePath: rel });
              if (role === 'input') summary.inputs += 1;
              if (role === 'output') { summary.outputs += 1; if (!summary.newestOutput || (entry.LastModified ?? '') > (summary.newestOutput.LastModified ?? '')) summary.newestOutput = entry; }
            }
          };
          for (const child of children.items) {
            if (!child.IsFolder) { summary.files.push({ item: child, role: 'unclassified', relativePath: '' }); continue; }
            const role = classifyFolder(child.Name);
            if (role === 'unclassified') continue;
            summary.roleFolders.push(child);
            await walkRole(child, role, '', 1);
          }
        } catch (error) {
          issues.push({ scope: 'task', path: normalizePath(folder.Path) || folder.Name || folder.Id, message: message(error) });
        }
      }
      tasks.push(summary);
    }

    // Skills: every folder under a skills container (recursively) that holds a SKILL.md.
    const skills: SkillSummary[] = [];
    const walkSkills = async (folder: DriveItem, depth: number) => {
      if (depth > LIMITS.skillDepth || skills.length >= LIMITS.skills) return;
      let listing: { items: DriveItem[]; truncated: boolean };
      try { listing = await this.listAll(folder.Id, 3); } catch (error) { issues.push({ scope: 'skill', path: normalizePath(folder.Path) || folder.Name || folder.Id, message: message(error) }); return; }
      see(listing.items);
      const definition = listing.items.find(i => !i.IsFolder && isSkillDefinition(i.Name));
      if (definition) {
        let summary = 'Summary unavailable.';
        try { summary = skillSummary(await this.files.read(definition)); } catch (error) { summary = `SKILL.md could not be read: ${message(error)}`; }
        skills.push({ folder, definition, summary, files: listing.items.filter(i => !i.IsFolder), partial: listing.truncated });
      }
      for (const child of listing.items.filter(i => i.IsFolder)) await walkSkills(child, depth + 1);
    };
    for (const container of containers.skills) {
      try {
        const listing = await this.listAll(container.Id);
        see(listing.items);
        for (const child of listing.items.filter(i => i.IsFolder)) await walkSkills(child, 1);
        // A SKILL.md placed directly in the skills container is still a skill definition.
        if (listing.items.some(i => !i.IsFolder && isSkillDefinition(i.Name))) await walkSkills(container, LIMITS.skillDepth);
      } catch (error) {
        issues.push({ scope: 'skills', path: normalizePath(container.Path) || `${rootPath}/${container.Name}`, message: message(error) });
      }
    }

    // Memory and config: every visible file below those containers, recursively.
    const memory: MemoryEntry[] = [];
    let memoryTruncated = false;
    const walkMemory = async (folder: DriveItem, container: DriveItem, kind: 'memory' | 'config', depth: number) => {
      if (depth > LIMITS.memoryDepth || memory.length >= LIMITS.memoryFiles) { memoryTruncated = true; return; }
      let listing: { items: DriveItem[]; truncated: boolean };
      try { listing = await this.listAll(folder.Id); } catch (error) { issues.push({ scope: kind, path: normalizePath(folder.Path) || folder.Name || folder.Id, message: message(error) }); return; }
      see(listing.items);
      memoryTruncated ||= listing.truncated;
      for (const item of listing.items) {
        if (item.IsFolder) await walkMemory(item, container, kind, depth + 1);
        else if (memory.length < LIMITS.memoryFiles) memory.push({ item, container, kind });
        else memoryTruncated = true;
      }
    };
    for (const kind of ['memory', 'config'] as const) for (const container of containers[kind]) await walkMemory(container, container, kind, 1);

    return {
      root, rootPath, containers, rootFiles, flatLayout, tasks, tasksTruncated, skills, memory, memoryTruncated, issues,
      observed: [...observed.values()], completedAt: new Date().toISOString(),
    };
  }
}
