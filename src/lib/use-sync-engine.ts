// React binding for the CoworkSyncEngine: one engine per repository bundle, a persistent (IndexedDB) cache for live
// content and a session-memory cache for Demo, status/layout via useSyncExternalStore, and a small query-shaped
// compatibility view (`isPending`, `isError`, `isFetching`, `dataUpdatedAt`, `refetch`) so the pages keep their contracts.
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { CompanionRepositories } from '@/lib/cowork-repositories';
import type { CoworkLayout } from '@/lib/cowork-discovery';
import { CoworkSyncEngine, type SyncStatus, type SyncMetrics } from '@/lib/cowork-sync';
import { IndexedDbLayoutCache, MemoryLayoutCache, ResilientLayoutCache, type LayoutCache } from '@/lib/layout-cache';

/** Query-shaped projection of the engine state so existing pages keep working unchanged. */
export interface LayoutState {
  data?: CoworkLayout;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  isFetching: boolean;
  dataUpdatedAt: number;
  refetch: () => Promise<void>;
}

export interface SyncHandle {
  status: SyncStatus;
  metrics: SyncMetrics;
  layout?: CoworkLayout;
  layoutQuery: LayoutState;
  refresh: () => Promise<void>;
  prioritizeTasks: (ids: Iterable<string>) => void;
  hydrateTask: (id: string) => Promise<void>;
  ensureSkills: () => Promise<void>;
  ensureMemory: () => Promise<void>;
  fullRescan: () => Promise<void>;
  clearCache: () => Promise<void>;
}

let persistentCache: LayoutCache | undefined;
/** The browser-persistent cache is shared by every live engine in this tab; it degrades to session memory explicitly. */
function livePersistentCache(onDegrade: (reason: string) => void) {
  if (!persistentCache) persistentCache = typeof indexedDB === 'undefined' ? new MemoryLayoutCache() : new ResilientLayoutCache(new IndexedDbLayoutCache(), new MemoryLayoutCache(), onDegrade);
  return persistentCache;
}

export function useSyncEngine(repositories: CompanionRepositories, options: { persistent: boolean; path: string; enabled: boolean; intervalMs: number }): SyncHandle {
  const { persistent, path, enabled, intervalMs } = options;
  const degradeRef = useRef<(reason: string) => void>(() => undefined);
  const engine = useMemo(() => {
    const cache = persistent ? livePersistentCache(reason => degradeRef.current(reason)) : new MemoryLayoutCache();
    return new CoworkSyncEngine(repositories.tasks, cache);
  }, [repositories, persistent]);
  useEffect(() => () => engine.dispose(), [engine]);
  useEffect(() => { degradeRef.current = () => engine.refreshCacheKind(); }, [engine]);

  // The engine mutates in place; snapshot the (status, layout) pair so useSyncExternalStore sees a stable reference per emit.
  const snapshotRef = useRef<{ status: SyncStatus; layout?: CoworkLayout; version: number }>({ status: engine.status, layout: engine.layout, version: -1 });
  const subscribe = useCallback((listener: () => void) => engine.subscribe(listener), [engine]);
  const getSnapshot = useCallback(() => {
    const current = snapshotRef.current;
    if (current.version !== engine.version) snapshotRef.current = { status: engine.status, layout: engine.layout, version: engine.version };
    return snapshotRef.current;
  }, [engine]);
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => { if (enabled && path) void engine.start(path); }, [engine, enabled, path]);
  useEffect(() => {
    if (!enabled || !intervalMs) return;
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void engine.refresh(); }, intervalMs);
    return () => window.clearInterval(timer);
  }, [engine, enabled, intervalMs]);

  const refresh = useCallback(() => engine.refresh(), [engine]);
  const { status, layout } = snap;
  const fetching = status.phase !== 'idle' || status.pendingHydration > 0;
  const layoutQuery = useMemo<LayoutState>(() => ({
    data: layout,
    isPending: !layout && !status.rootError && (!enabled || status.phase === 'authorizing' || status.phase === 'cold-outline' || (status.phase === 'idle' && !status.error && status.source === 'none')),
    isError: !layout && !!(status.rootError || status.error),
    error: !layout && (status.rootError || status.error) ? new Error(status.rootError ?? status.error) : null,
    isFetching: fetching,
    dataUpdatedAt: status.lastSyncedAt ? Date.parse(status.lastSyncedAt) : 0,
    refetch: refresh,
  }), [layout, status, enabled, fetching, refresh]);

  return {
    status, metrics: engine.metrics, layout, layoutQuery, refresh,
    prioritizeTasks: useCallback((ids: Iterable<string>) => engine.prioritize(ids), [engine]),
    hydrateTask: useCallback((id: string) => engine.hydrateTask(id), [engine]),
    ensureSkills: useCallback(() => engine.ensureSkills(), [engine]),
    ensureMemory: useCallback(() => engine.ensureMemory(), [engine]),
    fullRescan: useCallback(() => engine.fullRescan(), [engine]),
    clearCache: useCallback(() => engine.clearCache(), [engine]),
  };
}
