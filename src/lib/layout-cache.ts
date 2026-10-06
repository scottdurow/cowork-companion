// Browser-side performance cache for observable OneDrive metadata (outline, task subtrees, skills, memory).
// Records are scoped by `v<schema>|<root item id>|<part>` so a different root/account never reads another's snapshot,
// and a schema bump orphans old records. Never stores share links, tokens or file bodies.
export const LAYOUT_CACHE_SCHEMA = 1;
export type CacheKind = 'indexeddb' | 'memory';

export interface LayoutCache {
  readonly kind: CacheKind;
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  deleteByPrefix(prefix: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
  clear(): Promise<void>;
}
export class CacheError extends Error { constructor(message: string, readonly cause?: unknown) { super(message); this.name = 'CacheError'; } }

export function rootPrefix(rootId: string) { return `v${LAYOUT_CACHE_SCHEMA}|${rootId}|`; }
export function cacheKey(rootId: string, part: string) { return `${rootPrefix(rootId)}${part}`; }

export class MemoryLayoutCache implements LayoutCache {
  readonly kind = 'memory' as const;
  private store = new Map<string, unknown>();
  /** Test hook: throw on the next N writes (quota / corrupt storage simulation). */
  failWrites = 0;
  async get<T>(key: string) { return structuredClone(this.store.get(key)) as T | undefined; }
  async set<T>(key: string, value: T) { if (this.failWrites > 0) { this.failWrites--; throw new CacheError('Storage quota exceeded (simulated).'); } this.store.set(key, structuredClone(value)); }
  async delete(key: string) { this.store.delete(key); }
  async deleteByPrefix(prefix: string) { for (const k of [...this.store.keys()]) if (k.startsWith(prefix)) this.store.delete(k); }
  async keys(prefix: string) { return [...this.store.keys()].filter(k => k.startsWith(prefix)); }
  async clear() { this.store.clear(); }
  get size() { return this.store.size; }
}

const DB_NAME = 'cowork-companion-cache';
const STORE = 'records';
export class IndexedDbLayoutCache implements LayoutCache {
  readonly kind = 'indexeddb' as const;
  private db?: Promise<IDBDatabase>;
  constructor(private dbName = DB_NAME) {}
  private open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    this.db = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new CacheError('IndexedDB is not available in this browser.')); return; }
      const request = indexedDB.open(this.dbName, LAYOUT_CACHE_SCHEMA);
      request.onupgradeneeded = () => { const db = request.result; if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE); db.createObjectStore(STORE); };
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => db.close(); resolve(db); };
      request.onerror = () => reject(new CacheError('The browser cache could not be opened.', request.error));
      request.onblocked = () => reject(new CacheError('The browser cache is in use by another tab.'));
    });
    return this.db;
  }
  private async tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | Promise<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction;
      try { transaction = db.transaction(STORE, mode); } catch (error) { reject(new CacheError('The browser cache transaction failed.', error)); return; }
      const store = transaction.objectStore(STORE);
      const result = run(store);
      if (result instanceof Promise) { result.then(resolve, e => reject(new CacheError('The browser cache operation failed.', e))); return; }
      result.onsuccess = () => resolve(result.result);
      result.onerror = () => reject(new CacheError(result.error?.name === 'QuotaExceededError' ? 'The browser cache is full (quota exceeded).' : 'The browser cache operation failed.', result.error));
      transaction.onabort = () => reject(new CacheError(transaction.error?.name === 'QuotaExceededError' ? 'The browser cache is full (quota exceeded).' : 'The browser cache transaction was aborted.', transaction.error));
    });
  }
  async get<T>(key: string) { const value = await this.tx<unknown>('readonly', s => s.get(key)); return value as T | undefined; }
  async set<T>(key: string, value: T) { await this.tx('readwrite', s => s.put(value, key)); }
  async delete(key: string) { await this.tx('readwrite', s => s.delete(key)); }
  async keys(prefix: string) {
    const all = await this.tx<IDBValidKey[]>('readonly', s => s.getAllKeys());
    return all.map(String).filter(k => k.startsWith(prefix));
  }
  async deleteByPrefix(prefix: string) { for (const key of await this.keys(prefix)) await this.delete(key); }
  async clear() { await this.tx('readwrite', s => s.clear()); }
}

/**
 * Wraps a persistent cache so that any storage failure degrades to an in-memory cache for the rest of the session and
 * is reported once through `onDegrade` — never silently swallowed, never fatal to the UI.
 */
export class ResilientLayoutCache implements LayoutCache {
  private active: LayoutCache;
  private degraded?: string;
  constructor(private primary: LayoutCache, private fallback: LayoutCache = new MemoryLayoutCache(), private onDegrade?: (reason: string) => void) { this.active = primary; }
  get kind() { return this.active.kind; }
  get degradedReason() { return this.degraded; }
  private async guard<T>(run: (cache: LayoutCache) => Promise<T>, onFail: (cache: LayoutCache) => Promise<T>): Promise<T> {
    if (this.active !== this.primary) return run(this.active);
    try { return await run(this.primary); }
    catch (error) {
      this.degraded = error instanceof Error ? error.message : 'The browser cache failed.';
      this.active = this.fallback;
      this.onDegrade?.(this.degraded);
      return onFail(this.fallback);
    }
  }
  get<T>(key: string) { return this.guard(c => c.get<T>(key), c => c.get<T>(key)); }
  set<T>(key: string, value: T) { return this.guard(c => c.set(key, value), c => c.set(key, value)); }
  delete(key: string) { return this.guard(c => c.delete(key), c => c.delete(key)); }
  deleteByPrefix(prefix: string) { return this.guard(c => c.deleteByPrefix(prefix), c => c.deleteByPrefix(prefix)); }
  keys(prefix: string) { return this.guard(c => c.keys(prefix), c => c.keys(prefix)); }
  async clear() { try { await this.primary.clear(); } catch (error) { this.degraded = error instanceof Error ? error.message : 'The browser cache failed.'; this.onDegrade?.(this.degraded); } await this.fallback.clear(); }
}
