// Pure helpers for the full-page task workspace: route encoding, list-state restoration,
// output-first file ordering, file type labels and the direct "Open" flow. No React, no connector.
import type { CoworkTaskRepository, DriveItem, FileRole } from '@/lib/cowork-domain';
import type { TaskFile, TaskFolder, TaskSummary } from '@/lib/cowork-discovery';
import type { ChangeDetectionService, CompanionMetadata } from '@/lib/cowork-domain';

// ---- Observable change labels -------------------------------------------------------------------
// "New" = this stable item has never been marked seen; "Updated" = it was seen before and its observable
// fingerprint (etag/modified time) has changed since. Nothing here infers Cowork runtime status.
export type ChangeLabel = 'New' | 'Updated' | undefined;
export function changeLabel(state: ReturnType<ChangeDetectionService['state']>): ChangeLabel {
  return state === 'unreviewed' ? 'New' : state === 'modified' ? 'Updated' : undefined;
}
export function labelFor(item: DriveItem, metadata: CompanionMetadata, changes: ChangeDetectionService): ChangeLabel { return changeLabel(changes.state(item, metadata)); }

// ---- List state (what Back must restore) ---------------------------------------------------
// The current section/task comes from the URL hash (cowork-hash-routes.ts); this is only the list UI state Back must restore.
export interface ListState { search: string; taskFilter: 'all' | 'pinned' | 'recent' | 'unseen'; projectFilter: string; sort: 'modified' | 'name'; memoryFilter: string; activityUnseen: boolean; scrollY: number }
export const defaultListState: ListState = { search: '', taskFilter: 'all', projectFilter: '', sort: 'modified', memoryFilter: 'all', activityUnseen: false, scrollY: 0 };
export function encodeListState(state: ListState) { return JSON.stringify(state); }
export function decodeListState(text: string | null | undefined, fallback: ListState = defaultListState): ListState {
  if (!text) return fallback;
  try {
    const value = JSON.parse(text) as Partial<Record<keyof ListState, unknown>>;
    return {
      search: typeof value.search === 'string' ? value.search.slice(0, 200) : fallback.search,
      taskFilter: ['all', 'pinned', 'recent', 'unseen'].includes(value.taskFilter as string) ? value.taskFilter as ListState['taskFilter'] : fallback.taskFilter,
      projectFilter: typeof value.projectFilter === 'string' ? value.projectFilter : fallback.projectFilter,
      sort: value.sort === 'name' ? 'name' : 'modified',
      memoryFilter: typeof value.memoryFilter === 'string' ? value.memoryFilter : fallback.memoryFilter,
      activityUnseen: value.activityUnseen === true,
      scrollY: typeof value.scrollY === 'number' && value.scrollY >= 0 ? value.scrollY : 0,
    };
  } catch { return fallback; }
}

// ---- Local filename search over the last OneDrive read ------------------------------------------
export function searchLocalFiles(items: DriveItem[], term: string): DriveItem[] {
  const needle = term.trim().toLowerCase();
  if (needle.length < 2) return [];
  return items.filter(i => (i.Name ?? '').toLowerCase().includes(needle)).sort((a, b) => Number(!!a.IsFolder) - Number(!!b.IsFolder) || newestFirst(a, b));
}

// ---- Output-first file workspace ------------------------------------------------------------
export interface WorkspaceFiles { outputs: DriveItem[]; inputs: DriveItem[]; other: DriveItem[]; latestOutput?: DriveItem }
export const newestFirst = (a: DriveItem, b: DriveItem) => (b.LastModified ?? '').localeCompare(a.LastModified ?? '') || (a.Name ?? '').localeCompare(b.Name ?? '');
export function partitionTaskFiles(summary: Pick<TaskSummary, 'files'> | undefined): WorkspaceFiles {
  const byRole = (role: FileRole) => (summary?.files ?? []).filter(f => f.role === role).map(f => f.item).sort(newestFirst);
  const outputs = byRole('output');
  return { outputs, inputs: byRole('input'), other: byRole('unclassified'), latestOutput: outputs[0] };
}

// ---- Outputs: Tree and Flat views -----------------------------------------------------------------
// Both views are projections of the same observed files, so every file (and its Open/Preview/seen actions) appears
// exactly once in each. Folders are observable OneDrive structure only.
export type OutputsView = 'tree' | 'flat';
export interface FlatEntry { item: DriveItem; relativePath: string; relativeDir: string }
export interface TreeFolderNode { kind: 'folder'; id: string; name: string; relativePath: string; item?: DriveItem; folders: TreeFolderNode[]; files: FlatEntry[]; fileCount: number; newestModified?: string }
export function flattenRoleFiles(files: TaskFile[], role: FileRole): FlatEntry[] {
  return files.filter(f => f.role === role).map(f => ({ item: f.item, relativePath: f.relativePath || (f.item.Name ?? f.item.Id), relativeDir: f.relativePath.includes('/') ? f.relativePath.slice(0, f.relativePath.lastIndexOf('/')) : '' })).sort((a, b) => newestFirst(a.item, b.item));
}
export function buildRoleTree(files: TaskFile[], folders: TaskFolder[], role: FileRole): TreeFolderNode {
  const root: TreeFolderNode = { kind: 'folder', id: `${role}-root`, name: role === 'output' ? 'Outputs' : role === 'input' ? 'Inputs' : 'Files', relativePath: '', folders: [], files: [], fileCount: 0 };
  const byPath = new Map<string, TreeFolderNode>([['', root]]);
  const ensure = (relativePath: string): TreeFolderNode => {
    const existing = byPath.get(relativePath);
    if (existing) return existing;
    const parentPath = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '';
    const parent = ensure(parentPath);
    const node: TreeFolderNode = { kind: 'folder', id: `${role}:${relativePath}`, name: relativePath.slice(relativePath.lastIndexOf('/') + 1), relativePath, folders: [], files: [], fileCount: 0 };
    parent.folders.push(node);
    byPath.set(relativePath, node);
    return node;
  };
  for (const folder of folders.filter(f => f.role === role).sort((a, b) => a.relativePath.localeCompare(b.relativePath))) { const node = ensure(folder.relativePath); node.item = folder.item; node.id = folder.item.Id; }
  for (const entry of flattenRoleFiles(files, role)) ensure(entry.relativeDir).files.push(entry);
  const finish = (node: TreeFolderNode): TreeFolderNode => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name));
    node.folders.forEach(finish);
    node.files.sort((a, b) => newestFirst(a.item, b.item));
    node.fileCount = node.files.length + node.folders.reduce((n, f) => n + f.fileCount, 0);
    node.newestModified = [node.files[0]?.item.LastModified, ...node.folders.map(f => f.newestModified)].filter((v): v is string => !!v).sort().at(-1);
    return node;
  };
  return finish(root);
}
export function collectTreeFiles(node: TreeFolderNode): FlatEntry[] { return [...node.files, ...node.folders.flatMap(collectTreeFiles)]; }
/** Expand/collapse state is a set of folder node ids; toggling is pure so Back/Forward can restore it from the session. */
export function toggleExpanded(expanded: ReadonlySet<string>, id: string): Set<string> { const next = new Set(expanded); if (next.has(id)) next.delete(id); else next.add(id); return next; }
export function allFolderIds(node: TreeFolderNode): string[] { return node.folders.flatMap(f => [f.id, ...allFolderIds(f)]); }
export function decodeOutputsView(value: string | null | undefined): OutputsView { return value === 'flat' ? 'flat' : 'tree'; }
const typeLabels: Record<string, string> = { md: 'Markdown', txt: 'Text', csv: 'CSV', json: 'JSON', yaml: 'YAML', yml: 'YAML', log: 'Log', pdf: 'PDF', docx: 'Word document', doc: 'Word document', xlsx: 'Excel workbook', xls: 'Excel workbook', pptx: 'PowerPoint deck', ppt: 'PowerPoint deck', png: 'PNG image', jpg: 'JPEG image', jpeg: 'JPEG image', gif: 'GIF image', svg: 'SVG image', webp: 'WebP image', html: 'HTML', htm: 'HTML', zip: 'ZIP archive', mp4: 'Video', mp3: 'Audio', ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', py: 'Python' };
export function fileType(item: Pick<DriveItem, 'Name' | 'MediaType' | 'IsFolder'>) {
  if (item.IsFolder) return 'Folder';
  const ext = (item.Name ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (ext && ext !== item.Name?.toLowerCase() && typeLabels[ext]) return typeLabels[ext];
  if (item.MediaType && item.MediaType !== 'application/octet-stream') return item.MediaType.split('/').pop()?.toUpperCase() ?? item.MediaType;
  return ext && ext !== item.Name?.toLowerCase() ? `${ext.toUpperCase()} file` : 'File';
}
export const isTextPreviewable = (name?: string) => /\.(md|txt|json|csv|yaml|yml|log)$/i.test(name ?? '');

// ---- Direct Open flow -------------------------------------------------------------------------
// Link creation (connector) and browser navigation are two separate steps. The connector resolves a view-only link
// first; only then is a new tab attempted with that real URL. Nothing is pre-opened, so a blocked or sandboxed
// navigation never leaves an about:blank tab behind, and a resolved link is always retained for a user-click anchor.
export interface OpenEnvironment {
  /** Try to open `url` in a new tab. Returns true only when the host actually opened one; false or a throw means blocked. */
  openTab: (url: string) => boolean;
  cache: Map<string, string>;
}
export type OpenResult =
  | { status: 'opened'; url: string }
  | { status: 'blocked'; url: string; reason: 'popup-blocked' | 'navigation-refused' }
  | { status: 'failed'; message: string };
export async function openFileInNewTab(item: DriveItem, repository: Pick<CoworkTaskRepository, 'open'>, env: OpenEnvironment): Promise<OpenResult> {
  let url = env.cache.get(item.Id);
  if (!url) {
    try { url = await repository.open(item); } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : 'The file link could not be created.' };
    }
    env.cache.set(item.Id, url);
  }
  try { return env.openTab(url) ? { status: 'opened', url } : { status: 'blocked', url, reason: 'popup-blocked' }; } catch { return { status: 'blocked', url, reason: 'navigation-refused' }; }
}
