import type { BlobMetadata } from '../../generated/models/OneDriveforBusinessModel';

export type DriveItem = BlobMetadata & { Id: string };
export interface FolderPage { items: DriveItem[]; nextToken?: string }
export type FileRole = 'input' | 'output' | 'unclassified';
export interface TaskPreferences { projectId?: string; pinned?: boolean; archived?: boolean; coworkUrl?: string }
export const projectColors = ['green', 'blue', 'amber', 'rose', 'purple'] as const;
export type ProjectColor = typeof projectColors[number];
export interface Project { id: string; name: string; color: ProjectColor }
/** App-owned preferences. `demoMode` missing means true (first-run default); it is written only when the user changes it. */
export interface CompanionPreferences { demoMode?: boolean; /** 'system' | 'light' | 'dark'; anything else resolves to system at read time. */ appearance?: string; [key: string]: unknown }
export interface CompanionMetadata {
  schemaVersion: 2;
  projects: Project[];
  tasks: Record<string, TaskPreferences>;
  seen: Record<string, string>;
  preferences?: CompanionPreferences;
  /** Unknown top-level properties from newer/other writers are preserved verbatim. */
  [extra: string]: unknown;
}
const knownKeys = new Set(['schemaVersion', 'version', 'projects', 'tasks', 'seen', 'preferences']);
export interface CoworkTaskRepository {
  get(id: string): Promise<DriveItem>;
  resolve(path: string): Promise<DriveItem>;
  list(id: string, token?: string): Promise<FolderPage>;
  read(item: DriveItem): Promise<string>;
  open(item: DriveItem): Promise<string>;
  search(path: string, text: string): Promise<DriveItem[]>;
}
export interface MetadataPage { document?: CompanionMetadata; nextToken?: string; absent?: boolean }
export interface CompanionMetadataRepository {
  readonly location: string;
  load(token?: string): Promise<MetadataPage>;
  initialize(document: CompanionMetadata): Promise<CompanionMetadata>;
  save(document: CompanionMetadata): Promise<CompanionMetadata>;
}
export interface Skill { folder: DriveItem; definition?: DriveItem; summary: string; nextToken?: string }
export interface SkillsRepository {
  list(path: string, token?: string): Promise<FolderPage>;
  inspect(folder: DriveItem): Promise<Skill>;
  versions: SkillVersionExtension;
}
export interface MemoryRepository { list(path: string, token?: string): Promise<FolderPage>; read(item: DriveItem): Promise<string> }
export interface SkillVersionExtension {
  history: boolean; restore: boolean; lifecycle: boolean;
  reason: string;
}
export function emptyMetadata(): CompanionMetadata { return { schemaVersion: 2, projects: [], tasks: {}, seen: {} }; }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function key(id: string) { return id.length > 0 && id.length <= 2048 && !['__proto__', 'prototype', 'constructor'].includes(id); }
export function validatedCoworkUrl(value: string): string | undefined {
  try { const url = new URL(value.trim()); return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && value.length <= 4096 ? url.href : undefined; } catch { return undefined; }
}
export function parseMetadata(text: string): CompanionMetadata {
  if (text.length > 256_000) throw new Error('Companion metadata exceeds the 256 KB limit.');
  const value: unknown = JSON.parse(text);
  if (!object(value)) throw new Error('Companion metadata must be a JSON object.');
  const version = value.schemaVersion ?? value.version;
  if (version !== 1 && version !== 2) throw new Error(`Unsupported companion schema version (found ${version === undefined ? 'no schemaVersion field; top-level keys: ' + Object.keys(value).slice(0, 5).join(', ') : JSON.stringify(version)}). This file will not be overwritten.`);
  const result = emptyMetadata();
  if (value.projects !== undefined) {
    if (!Array.isArray(value.projects) || value.projects.length > 500) throw new Error('Invalid projects collection.');
    for (const row of value.projects) {
      if (!object(row) || typeof row.id !== 'string' || !key(row.id) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 160 || typeof row.color !== 'string' || !projectColors.some(c => c === row.color)) throw new Error('Invalid project record.');
      if (result.projects.some(p => p.id === row.id)) throw new Error('Duplicate project ID.');
      const color = projectColors.find(c => c === row.color);
      if (color) result.projects.push({ id: row.id, name: row.name.trim(), color });
    }
  }
  for (const field of ['tasks', 'seen'] as const) {
    if (value[field] !== undefined && !object(value[field])) throw new Error(`Invalid ${field} collection.`);
  }
  if (object(value.tasks)) for (const [id, prefs] of Object.entries(value.tasks)) {
    if (!key(id) || !object(prefs)) throw new Error('Invalid task preference record.');
    const clean: TaskPreferences = {};
    for (const flag of ['pinned', 'archived'] as const) {
      if (prefs[flag] !== undefined && typeof prefs[flag] !== 'boolean') throw new Error('Invalid task preference.');
      if (typeof prefs[flag] === 'boolean') clean[flag] = prefs[flag];
    }
    if (prefs.projectId !== undefined) {
      if (typeof prefs.projectId !== 'string') throw new Error('Invalid assignment.');
      if (result.projects.some(p => p.id === prefs.projectId)) clean.projectId = prefs.projectId;
    }
    if (prefs.coworkUrl !== undefined && prefs.coworkUrl !== '') {
      if (typeof prefs.coworkUrl !== 'string') throw new Error('Invalid saved URL.');
      const url = validatedCoworkUrl(prefs.coworkUrl);
      if (!url) throw new Error('Invalid saved URL.');
      clean.coworkUrl = url;
    }
    result.tasks[id] = clean;
  }
  if (object(value.seen)) for (const [id, stamp] of Object.entries(value.seen)) {
    if (!key(id) || typeof stamp !== 'string' || stamp.length > 4096) throw new Error('Invalid seen-change record.');
    // Migrate v1's raw etag/timestamp to a fingerprint; never persist source timestamps.
    result.seen[id] = version === 1 ? fingerprintValue(stamp) : stamp;
  }
  if (value.preferences !== undefined) {
    if (!object(value.preferences)) throw new Error('Invalid preferences.');
    const prefs: CompanionPreferences = {};
    for (const [name, raw] of Object.entries(value.preferences)) {
      if (!key(name)) throw new Error('Invalid preference name.');
      if (name === 'demoMode') { if (typeof raw !== 'boolean') throw new Error('demoMode must be true or false.'); prefs.demoMode = raw; }
      else if (name === 'appearance') { if (typeof raw !== 'string') throw new Error('appearance must be a string.'); prefs.appearance = raw; } // invalid strings resolve to system at read time, never rewritten here
      else prefs[name] = raw; // unknown preferences are preserved verbatim
    }
    result.preferences = prefs;
  }
  for (const [name, raw] of Object.entries(value)) if (!knownKeys.has(name) && key(name)) result[name] = raw; // preserve unknown top-level properties
  return result;
}
/** Demo mode is the first-run default: a missing preference means true. Nothing is written to materialise the default. */
export function demoModeOf(document: Pick<CompanionMetadata, 'preferences'> | undefined): boolean { return document?.preferences?.demoMode ?? true; }
export function withAppearance(document: CompanionMetadata, appearance: 'system' | 'light' | 'dark'): CompanionMetadata {
  return parseMetadata(JSON.stringify({ ...document, preferences: { ...document.preferences, appearance } }));
}
export function withDemoMode(document: CompanionMetadata, demoMode: boolean): CompanionMetadata {
  return parseMetadata(JSON.stringify({ ...document, preferences: { ...document.preferences, demoMode } }));
}
export function serializeMetadata(document: CompanionMetadata) { return JSON.stringify(parseMetadata(JSON.stringify(document)), null, 2); }
export function patchTask(document: CompanionMetadata, id: string, patch: Partial<TaskPreferences>): CompanionMetadata {
  if (!key(id)) throw new Error('A stable task ID is required.');
  const next = { ...document, tasks: { ...document.tasks, [id]: { ...document.tasks[id], ...patch } } };
  return parseMetadata(JSON.stringify(next));
}
export function putProject(document: CompanionMetadata, project: Project): CompanionMetadata {
  return parseMetadata(JSON.stringify({ ...document, projects: [...document.projects.filter(p => p.id !== project.id), project] }));
}
export function deleteProject(document: CompanionMetadata, id: string): CompanionMetadata {
  const tasks = Object.fromEntries(Object.entries(document.tasks).map(([taskId, prefs]) => [taskId, prefs.projectId === id ? { ...prefs, projectId: undefined } : prefs]));
  return { ...document, projects: document.projects.filter(p => p.id !== id), tasks };
}
export function fingerprintValue(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `fp:${(hash >>> 0).toString(16)}`;
}
export function fingerprint(item: DriveItem) { const value = item.ETag ?? item.LastModified; return value ? fingerprintValue(value) : undefined; }
export class ChangeDetectionService {
  private observed = new Map<string, DriveItem>();
  observe(items: DriveItem[]) { for (const item of items) this.observed.set(item.Id, item); }
  state(item: DriveItem, metadata: CompanionMetadata): 'unreviewed' | 'modified' | 'seen' | 'unknown' {
    const stamp = fingerprint(item);
    if (!stamp) return 'unknown';
    const before = metadata.seen[item.Id];
    return !before ? 'unreviewed' : before === stamp ? 'seen' : 'modified';
  }
  isUnseen(item: DriveItem, metadata: CompanionMetadata) { const state = this.state(item, metadata); return state === 'unreviewed' || state === 'modified'; }
  markSeen(item: DriveItem, metadata: CompanionMetadata): CompanionMetadata {
    const stamp = fingerprint(item);
    return stamp ? { ...metadata, seen: { ...metadata.seen, [item.Id]: stamp } } : metadata;
  }
  activity() { return [...this.observed.values()].sort((a, b) => (b.LastModified ?? '').localeCompare(a.LastModified ?? '')); }
}
export function classify(item: DriveItem, taskPath?: string): FileRole {
  if (!item.Path || !taskPath) return 'unclassified';
  const base = taskPath.replace(/\/+$/, '').toLowerCase();
  const path = item.Path.replace(/\/+$/, '').toLowerCase();
  if (!path.startsWith(base + '/')) return 'unclassified';
  const directory = path.slice(base.length + 1).split('/')[0];
  if (/^inputs?$/.test(directory)) return 'input';
  if (/^outputs?$/.test(directory)) return 'output';
  return 'unclassified';
}
export function classifyFolder(name?: string): FileRole { return /^inputs?$/i.test(name ?? '') ? 'input' : /^outputs?$/i.test(name ?? '') ? 'output' : 'unclassified'; }
export function skillSummary(text: string) {
  const description = text.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^['"]|['"]$/g, '');
  if (description && !/^[>|]/.test(description)) return description;
  return text.replace(/^---[\s\S]*?---\s*/, '').split(/\n\s*\n/).find(p => p.trim() && !p.trim().startsWith('#'))?.replace(/\s+/g, ' ').trim() ?? 'No summary in SKILL.md.';
}
export function compareText(before: string, after: string) {
  const left = before.split('\n'), right = after.split('\n');
  if (left.length > 5000 || right.length > 5000) throw new Error('Compare is limited to 5,000 lines per version.');
  return Array.from({ length: Math.max(left.length, right.length) }, (_, i) => ({ line: i + 1, before: left[i] ?? '', after: right[i] ?? '' })).filter(row => row.before !== row.after);
}
export class InMemoryCompanionMetadataRepository implements CompanionMetadataRepository {
  readonly location = 'Session memory';
  private document: CompanionMetadata;
  constructor(document = emptyMetadata()) { this.document = parseMetadata(JSON.stringify(document)); }
  async load() { return { document: structuredClone(this.document) }; }
  async initialize(document: CompanionMetadata) { return this.save(document); }
  async save(document: CompanionMetadata) { this.document = parseMetadata(serializeMetadata(document)); return structuredClone(this.document); }
}
export class InMemoryCoworkTaskRepository implements CoworkTaskRepository {
  constructor(private items: DriveItem[] = [], private contents: Record<string, string> = {}) {}
  async get(id: string) { const item = this.items.find(i => i.Id === id); if (!item) throw new Error('Item not available.'); return structuredClone(item); }
  async resolve(path: string) { const item = this.items.find(i => i.Path?.replace(/\/+$/, '').toLowerCase() === path.replace(/\/+$/, '').toLowerCase() && i.IsFolder); if (!item) throw new Error('Folder not available in this repository.'); return structuredClone(item); }
  async list(id: string, token?: string): Promise<FolderPage> {
    const folder = this.items.find(i => i.Id === id); if (!folder?.IsFolder || !folder.Path) throw new Error('Folder not available.');
    const base = folder.Path.replace(/\/+$/, ''); const children = this.items.filter(i => i.Id !== folder.Id && i.Path?.replace(/\/+$/, '').slice(0, i.Path.replace(/\/+$/, '').lastIndexOf('/')) === base);
    const offset = token ? Number(token) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid continuation.');
    return { items: structuredClone(children.slice(offset, offset + 40)), nextToken: offset + 40 < children.length ? String(offset + 40) : undefined };
  }
  async read(item: DriveItem) { if (this.contents[item.Id] === undefined) throw new Error('No content available.'); return this.contents[item.Id]; }
  // Demo/in-memory mode: open the sample file's own content in a new tab via a blob: URL. No OneDrive URL is invented.
  async open(item: DriveItem): Promise<string> {
    const text = this.contents[item.Id];
    if (text === undefined) throw new Error('Demo mode has no content for this sample file, so there is nothing to open.');
    if (typeof URL.createObjectURL !== 'function') throw new Error('Opening files is not available in this environment.');
    const type = /\.(md|txt|csv|yaml|yml|log)$/i.test(item.Name ?? '') ? 'text/plain;charset=utf-8' : /\.json$/i.test(item.Name ?? '') ? 'application/json' : 'text/plain;charset=utf-8';
    return URL.createObjectURL(new Blob([text], { type }));
  }
  async search(path: string, text: string) { return structuredClone(this.items.filter(i => i.Path?.startsWith(path + '/') && i.Name?.toLowerCase().includes(text.toLowerCase())).slice(0, 100)); }
}
export class FolderSkillsRepository implements SkillsRepository {
  readonly versions: SkillVersionExtension = { history: false, restore: false, lifecycle: false, reason: 'The bound client has no list-versions, read-version, or restore-version operation. Cowork skill activation semantics are not exposed. Source files are read-only here.' };
  constructor(private files: CoworkTaskRepository) {}
  async list(path: string, token?: string) { const parent = await this.files.resolve(path); return this.files.list(parent.Id, token); }
  async inspect(folder: DriveItem): Promise<Skill> {
    const page = await this.files.list(folder.Id);
    const definition = page.items.find(i => !i.IsFolder && /^skill\.md$/i.test(i.Name ?? ''));
    return { folder, definition, nextToken: page.nextToken, summary: definition ? skillSummary(await this.files.read(definition)) : page.nextToken ? 'SKILL.md not on the first page. Browse additional files.' : 'SKILL.md not found in this folder.' };
  }
}
export class FolderMemoryRepository implements MemoryRepository {
  constructor(private files: CoworkTaskRepository) {}
  async list(path: string, token?: string) { const parent = await this.files.resolve(path); return this.files.list(parent.Id, token); }
  read(item: DriveItem) { return this.files.read(item); }
}
