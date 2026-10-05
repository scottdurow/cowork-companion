import { OneDriveforBusinessService } from '../../generated/services/OneDriveforBusinessService';
import type { BlobMetadata } from '../../generated/models/OneDriveforBusinessModel';
import { safeUrl } from '@/lib/safe-url';
import { FolderSkillsRepository, FolderMemoryRepository, parseMetadata, serializeMetadata, validatedCoworkUrl, type DriveItem, type FolderPage, type CoworkTaskRepository, type CompanionMetadataRepository, type CompanionMetadata, type MetadataPage } from '@/lib/cowork-domain';
import { CoworkDiscoveryService } from '@/lib/cowork-discovery';
export * from '@/lib/cowork-domain';

function requireId(item: BlobMetadata): DriveItem {
  if (!item.Id) throw new Error('A returned item has no stable ID.');
  return { ...item, Id: item.Id };
}
// Surface a short, path-neutral reason from the connector result (HTTP status / message) without leaking payloads.
function failed(error: unknown, context = 'The OneDrive request failed'): never {
  console.error('OneDrive request failed', error);
  const detail = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const status = typeof detail.status === 'number' ? detail.status : typeof detail.statusCode === 'number' ? detail.statusCode : undefined;
  const text = typeof detail.message === 'string' ? detail.message : typeof error === 'string' ? error : '';
  const reason = status === 404 || /not ?found|does not exist/i.test(text) ? 'not found (404)' : status === 403 || /forbidden|access denied/i.test(text) ? 'access denied (403)' : status ? `HTTP ${status}` : text ? text.slice(0, 120) : 'no further detail from the connector';
  throw new Error(`${context}: ${reason}.`);
}
// Normalise whatever shape the connector hands back for file content into the raw text the app expects.
// Shapes seen or possible from the generated client: plain text; already-parsed JSON (object); raw bytes as an
// ArrayBuffer / typed array / number[] / Blob; a JSON-serialised byte map { "0": 123, "1": 10, ... } (what the
// live preview returned for cowork-companion.json); a Power Platform binary envelope { "$content-type", "$content" };
// or a bare base64 string for octet-stream bodies.
const utf8 = new TextDecoder('utf-8');
function bytesToText(bytes: Uint8Array) { return utf8.decode(bytes).replace(/^\uFEFF/, ''); }
function byteMapToBytes(value: Record<string, unknown>): Uint8Array | undefined {
  const keys = Object.keys(value);
  if (!keys.length || keys.length > 512_000) return undefined;
  const bytes = new Uint8Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const v = value[String(i)];
    if (typeof v !== 'number' || v < 0 || v > 255 || !Number.isInteger(v)) return undefined;
    bytes[i] = v;
  }
  return bytes;
}
export async function decodeFileContent(data: unknown): Promise<string> {
  if (data === undefined || data === null) return '';
  if (typeof data === 'string') return decodeStringContent(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return decodeStringContent(await data.text());
  if (data instanceof ArrayBuffer) return bytesToText(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return bytesToText(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  if (Array.isArray(data)) {
    if (data.every(v => typeof v === 'number')) return bytesToText(Uint8Array.from(data as number[]));
    return JSON.stringify(data, null, 2);
  }
  if (typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (typeof record.$content === 'string') return decodeStringContent(record.$content);
    if (typeof record.data === 'string' && Object.keys(record).length <= 3) return decodeStringContent(record.data);
    const bytes = byteMapToBytes(record);
    if (bytes) return bytesToText(bytes);
    return JSON.stringify(data, null, 2); // JSON the connector already parsed
  }
  return String(data);
}
function decodeStringContent(text: string): string {
  // A JSON-serialised envelope or byte map may itself arrive as a string: unwrap it once.
  if (/^\s*\{\s*"(\$content|0)"\s*:/.test(text)) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed.$content === 'string') return decodeStringContent(parsed.$content);
      const bytes = byteMapToBytes(parsed);
      if (bytes) return bytesToText(bytes);
    } catch { /* fall through: treat as ordinary text */ }
  }
  // A JSON document or ordinary text is returned as-is; only a plausible base64 blob is decoded.
  if (/^\s*[{[]/.test(text) || !/^[A-Za-z0-9+/=\r\n]+$/.test(text) || text.replace(/\s+/g, '').length % 4 !== 0 || text.length < 8) return text.replace(/^\uFEFF/, '');
  try {
    const bytes = Uint8Array.from(atob(text.replace(/\s+/g, '')), c => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch { return text; }
}
async function requireText(content: unknown) {
  const text = await decodeFileContent(content);
  if (text.length > 256_000) throw new Error('Text must be 256 KB or less.');
  return text;
}
export class OneDriveCoworkTaskRepository implements CoworkTaskRepository {
  async get(id: string) {
    const result = await OneDriveforBusinessService.GetFileMetadata(id);
    if (!result.success) return failed(result.error, 'Item metadata could not be read');
    return requireId(result.data);
  }
  async resolve(path: string) {
    const result = await OneDriveforBusinessService.GetFileMetadataByPath(path);
    if (!result.success) return failed(result.error, `Folder ${path} could not be resolved`);
    const item = requireId(result.data);
    if (!item.IsFolder) throw new Error(`${path} is a file, not a folder.`);
    return item;
  }
  async list(id: string, token?: string): Promise<FolderPage> {
    const result = await OneDriveforBusinessService.ListFolderV2(id, token, 100);
    if (!result.success) return failed(result.error, 'Folder contents could not be listed');
    const next = result.data.nextLink;
    let nextToken: string | undefined;
    if (next) {
      const params = new URL(next, 'https://example.com/').searchParams;
      nextToken = params.get('skipToken') ?? params.get('$skiptoken') ?? params.get('$skipToken') ?? undefined;
      if (!nextToken) throw new Error('More results exist, but the continuation format is unsupported. Narrow the folder scope.');
    }
    return { items: (result.data.value ?? []).map(requireId), nextToken };
  }
  async read(item: DriveItem) {
    if (item.IsFolder) throw new Error('Select a file.');
    if (item.Size === undefined || item.Size > 256_000) throw new Error('Content preview requires a known file size of 256 KB or less.');
    if (!/\.(md|txt|json|csv|yaml|yml|log)$/i.test(item.Name ?? '')) throw new Error('Content preview supports text, Markdown, JSON, CSV, YAML, and log files.');
    const result = await OneDriveforBusinessService.GetFileContent(item.Id, false);
    if (!result.success) return failed(result.error, `${item.Name ?? 'File'} could not be read`);
    return await requireText(result.data);
  }
  private links = new Map<string, string>();
  async open(item: DriveItem) {
    // The connector's metadata carries no browser URL, so a view-only, organisation-scoped link is created on demand
    // (the least-privileged scope the operation offers) and cached per item for the session. Called only from a user click.
    const cached = this.links.get(item.Id);
    if (cached) return cached;
    const result = await OneDriveforBusinessService.CreateShareLinkV2(item.Id, 'view', 'organization');
    if (!result.success) return failed(result.error, `A browser link for ${item.Name ?? 'this item'} could not be created`);
    const url = validatedCoworkUrl(result.data.WebUrl ?? '');
    if (!url || !safeUrl(url)) throw new Error('OneDrive did not return a usable HTTPS link.');
    this.links.set(item.Id, url);
    return url;
  }
  async search(path: string, text: string) {
    if (!text.trim()) return [];
    // findMode is an untyped string in the generated client; the connector's documented values are 'OneDriveSearch' and
    // 'Regex' ('Search' is rejected as an invalid find file mode). This is only called from the explicit opt-in action.
    const result = await OneDriveforBusinessService.FindFilesByPath(text.trim(), path, 'OneDriveSearch', 100);
    if (!result.success) return failed(result.error, 'Filename search failed');
    return (result.data ?? []).map(requireId);
  }
}
export class OneDriveCompanionMetadataRepository implements CompanionMetadataRepository {
  readonly location = '/Documents/cowork-companion.json';
  private id?: string;
  private revision?: string;
  private absent = false;
  private folderId?: string;
  constructor(private files: CoworkTaskRepository) {}
  async load(token?: string): Promise<MetadataPage> {
    this.absent = false;
    this.id = undefined;
    this.revision = undefined;
    const parent = await this.files.resolve('/Documents');
    this.folderId = parent.Id;
    const page = await this.files.list(parent.Id, token);
    const file = page.items.find(i => i.Name?.toLowerCase() === 'cowork-companion.json');
    if (file) {
      if (file.IsFolder) throw new Error('The companion metadata path is a folder. Nothing was changed.');
      const text = await this.files.read(file);
      const document = parseMetadata(text);
      this.id = file.Id;
      this.revision = text;
      return { document };
    }
    this.absent = !page.nextToken;
    return { nextToken: page.nextToken, absent: this.absent };
  }
  async initialize(document: CompanionMetadata) {
    if (!this.absent || !this.folderId || this.id) throw new Error('Finish checking the metadata folder before creating the companion file.');
    const body = serializeMetadata(document);
    if (body.length > 256_000) throw new Error('Companion metadata exceeds the 256 KB limit.');
    const result = await OneDriveforBusinessService.CreateFile('/Documents', 'cowork-companion.json', body);
    if (!result.success) return failed(result.error, `${this.location} could not be created`);
    this.id = requireId(result.data).Id;
    this.revision = body;
    this.absent = false;
    return parseMetadata(body);
  }
  async save(document: CompanionMetadata) {
    if (!this.id || this.revision === undefined) throw new Error('Load or create the companion metadata file before saving.');
    // There is no conditional-write parameter in UpdateFile. Detect stale reads before writing;
    // do not claim atomic concurrency protection against another simultaneous writer.
    const current = await OneDriveforBusinessService.GetFileContent(this.id, false);
    if (!current.success) return failed(current.error, `${this.location} could not be re-read before saving`);
    // Compare canonical forms so formatting differences between connector response shapes never look like a conflict.
    if (serializeMetadata(parseMetadata(await requireText(current.data))) !== serializeMetadata(parseMetadata(this.revision))) throw new Error('Companion metadata changed elsewhere. Reload settings before saving; no changes were written.');
    const body = serializeMetadata(document);
    if (body.length > 256_000) throw new Error('Companion metadata exceeds the 256 KB limit.');
    const result = await OneDriveforBusinessService.UpdateFile(this.id, body);
    if (!result.success) return failed(result.error, `${this.location} could not be saved`);
    this.revision = body;
    return parseMetadata(body);
  }
}
export interface CompanionRepositories {
  tasks: CoworkTaskRepository;
  metadata: CompanionMetadataRepository;
  skills: FolderSkillsRepository;
  memory: FolderMemoryRepository;
  discovery: CoworkDiscoveryService;
}
export function createRepositories(tasks: CoworkTaskRepository, metadata: CompanionMetadataRepository): CompanionRepositories {
  return { tasks, metadata, skills: new FolderSkillsRepository(tasks), memory: new FolderMemoryRepository(tasks), discovery: new CoworkDiscoveryService(tasks) };
}
export const taskRepository: CoworkTaskRepository = new OneDriveCoworkTaskRepository();
export const liveRepositories = createRepositories(taskRepository, new OneDriveCompanionMetadataRepository(taskRepository));
