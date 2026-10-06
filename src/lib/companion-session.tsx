// Shared Companion session: data source mode, repositories, companion metadata, layout discovery and the
// task-list UI state. It lives above the router outlet so navigating between the task list and a task page
// never re-reads OneDrive and Back restores the exact list state (view, search, filters, sort, scroll).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useConfirm } from '@/hooks/use-confirm';
import { MetadataBootstrapController, settingsReadiness, shouldBootstrap, type BootstrapPhase, type SettingsReadiness } from '@/lib/metadata-bootstrap';
import { liveRepositories, type CompanionRepositories } from '@/lib/cowork-repositories';
import { createDemoRepositories } from '@/lib/cowork-demo';
import { ChangeDetectionService, demoModeOf, emptyMetadata, patchTask, putProject, withAppearance, withDemoMode, type CompanionMetadata, type DriveItem, type MetadataPage, type Project, type TaskPreferences } from '@/lib/cowork-domain';
import { AppearanceController, appearanceOf, rootClassesFor, type Appearance, type Scheme } from '@/lib/appearance';
import { FileLinkService } from '@/lib/file-links';
import { FocusReturn, resolveFocusKey, type FocusOrigin } from '@/lib/focus-return';
import { archiveRequest, assignRequest, runConfirmedMutation, type ConfirmedOutcome } from '@/lib/confirm-mutation';
import { assignTasks, createProjectAndAssign, pruneSelection, toggleSelected, selectAll as selectAllIds, deselectAll as deselectAllIds } from '@/lib/cowork-assignment';
import type { CoworkLayout, TaskSummary } from '@/lib/cowork-discovery';
import { useSyncEngine, type LayoutState, type SyncHandle } from '@/lib/use-sync-engine';
import { decodeListState, decodeOutputsView, defaultListState, encodeListState, toggleExpanded, type ListState, type OutputsView } from '@/lib/cowork-workspace';

export type Mode = 'live' | 'demo';
const LIST_KEY = 'cowork-companion.list';
const OUTPUTS_VIEW_KEY = 'cowork-companion.outputs-view';
function readStored(key: string) { try { return window.localStorage.getItem(key); } catch { return null; } }
function store(key: string, value: string) { try { window.localStorage.setItem(key, value); } catch { /* storage unavailable: state simply is not remembered */ } }

export interface CompanionSession {
  /** 'demo' while preferences.demoMode is true or missing (first-run default); 'live' only after an explicit false was saved. */
  mode: Mode;
  /** True once the live companion metadata answered (success, absent or error) and the mode is therefore known. */
  modeResolved: boolean;
  demoMode: boolean;
  setDemoMode: (value: boolean) => Promise<boolean>;
  /** The live (OneDrive) companion metadata query — the only OneDrive access that continues in Demo mode. */
  preferencesQuery: ReturnType<typeof useQuery<MetadataPage>>;
  /** First-run creation of the live companion file (independent of Demo/Live content mode). */
  bootstrap: BootstrapPhase;
  retryBootstrap: () => void;
  readiness: SettingsReadiness;
  repositories: CompanionRepositories;
  scopeKey: string;
  changes: ChangeDetectionService;
  index: Map<string, DriveItem>;
  observe: (items: DriveItem[]) => void;
  metadata: CompanionMetadata;
  metadataQuery: ReturnType<typeof useQuery<MetadataPage>>;
  metaToken?: string;
  setMetaToken: (token?: string) => void;
  save: ReturnType<typeof useMutation<CompanionMetadata, Error, CompanionMetadata>>;
  initialize: ReturnType<typeof useMutation<CompanionMetadata, Error, void>>;
  writable: boolean;
  update: (id: string, patch: Partial<TaskPreferences>) => void;
  /** Keyed, one-at-a-time metadata actions: `pendingKey` names the control that is saving; `lastResult` lets it show a brief ✓/! */
  pendingKey?: string;
  lastResult?: { key: string; status: 'success' | 'error'; message?: string; at: number };
  runAction: (key: string, next: () => CompanionMetadata, options?: { successMessage?: string; onSuccess?: () => void }) => Promise<boolean>;
  assign: (taskIds: Iterable<string>, projectId: string | undefined, key?: string) => Promise<boolean>;
  /** Confirmed flows: dialog first, exactly one write, focus back on the current equivalent trigger. */
  confirmAssign: (taskIds: string[], projectId: string | undefined, origin: FocusOrigin<HTMLElement> | HTMLElement | null, key?: string) => Promise<ConfirmedOutcome>;
  confirmArchive: (taskId: string, origin: FocusOrigin<HTMLElement> | HTMLElement | null) => Promise<ConfirmedOutcome>;
  taskName: (taskId: string) => string;
  /** Appearance preference (system | light | dark) and the resolved scheme that follows prefers-color-scheme live. */
  appearance: Appearance;
  scheme: Scheme;
  setAppearance: (value: Appearance) => Promise<boolean>;
  /** Browser links for files, resolved through the active repository bundle and cached for the session. */
  fileLinks: FileLinkService;
  createProject: (project: Project, assignTo?: Iterable<string>, key?: string) => Promise<boolean>;
  selection: ReadonlySet<string>;
  toggleSelection: (id: string) => void;
  selectVisible: (ids: Iterable<string>) => void;
  deselectVisible: (ids: Iterable<string>) => void;
  clearSelection: () => void;
  markSeen: (item: DriveItem) => void;
  markAllSeen: (items: DriveItem[]) => void;
  createMetadata: () => Promise<void>;
  path: string;
  setPath: (path: string) => void;
  interval: number;
  setInterval: (ms: number) => void;
  /** Query-shaped view of the sync engine (cached → revalidating → live); pages keep reading isPending/isFetching/dataUpdatedAt. */
  layoutQuery: LayoutState;
  layout?: CoworkLayout;
  summaryById: Map<string, TaskSummary>;
  /** Incremental revalidation (outline + fingerprint diff) — never a whole-tree walk. */
  refresh: () => void;
  /** OneDrive-first sync engine: status slot data, prioritisation, lazy sections, full rescan and cache clearing. */
  sync: SyncHandle;
  list: ListState;
  setList: (patch: Partial<ListState>) => void;
  /** Outputs Tree/Flat choice and expanded folders, kept for the session across hash navigation and Back/Forward. */
  outputsView: OutputsView;
  setOutputsView: (view: OutputsView) => void;
  expanded: ReadonlySet<string>;
  toggleFolder: (id: string) => void;
  setExpanded: (ids: Iterable<string>) => void;
}

const SessionContext = createContext<CompanionSession | null>(null);

export function CompanionProvider({ children, repositories: injected }: { children: ReactNode; repositories?: CompanionRepositories }) {
  const client = useQueryClient();
  const confirm = useConfirm();
  const [path, setPath] = useState('/Documents/Cowork');
  const [interval, setIntervalValue] = useState(300_000);
  const [metaToken, setMetaToken] = useState<string>();
  // Demo mode is a persisted preference in the app-owned companion file (missing = true). The live metadata is read first so
  // the mode is known before any Cowork content is read; while saving a change the switch shows the target value optimistically.
  const liveMetadataKey = ['cowork', 'live', 'metadata', metaToken];
  const preferencesQuery = useQuery({ queryKey: liveMetadataKey, queryFn: () => liveRepositories.metadata.load(metaToken), retry: false, staleTime: Infinity, refetchOnWindowFocus: false, enabled: !injected });
  // Live bootstrap: when the live scan conclusively reports the file absent, create it exactly once through the LIVE
  // repository — regardless of the effective content mode — and put the created document into the live query cache.
  const [bootstrapController] = useState(() => new MetadataBootstrapController(liveRepositories.metadata, document => { client.setQueryData<MetadataPage>(['cowork', 'live', 'metadata', undefined], { document }); }));
  const [bootstrap, setBootstrap] = useState<BootstrapPhase>(() => bootstrapController.state);
  useEffect(() => bootstrapController.subscribe(() => setBootstrap(bootstrapController.state)), [bootstrapController]);
  useEffect(() => {
    if (injected) return;
    if (preferencesQuery.data?.document) { bootstrapController.observeExisting(); return; }
    if (shouldBootstrap({ page: preferencesQuery.data, queryStatus: preferencesQuery.status, phase: bootstrapController.state })) void bootstrapController.start();
  }, [injected, preferencesQuery.data, preferencesQuery.status, bootstrapController]);
  const retryBootstrap = useCallback(() => { void bootstrapController.retry(); }, [bootstrapController]);
  const readiness = settingsReadiness({ page: preferencesQuery.data, queryStatus: preferencesQuery.status, queryError: preferencesQuery.error instanceof Error ? preferencesQuery.error.message : undefined, phase: bootstrap });
  const [optimisticDemo, setOptimisticDemo] = useState<boolean>();
  const savedDemoMode = injected ? false : demoModeOf(preferencesQuery.data?.document);
  const demoMode = optimisticDemo ?? savedDemoMode;
  const modeResolved = !!injected || preferencesQuery.isSuccess || preferencesQuery.isError;
  const mode: Mode = demoMode ? 'demo' : 'live';
  const session = useMemo(() => ({ demo: mode === 'demo' ? createDemoRepositories() : undefined, changes: new ChangeDetectionService() }), [mode]);
  const repositories = injected ?? session.demo ?? liveRepositories;
  const fileLinks = useMemo(() => new FileLinkService(repositories.tasks), [repositories]);
  const changes = session.changes;
  const scopeKey = mode;
  const [index, setIndex] = useState<Map<string, DriveItem>>(new Map());
  const [list, setListState] = useState<ListState>(() => decodeListState(readStored(LIST_KEY)));
  const [outputsView, setOutputsViewState] = useState<OutputsView>(() => decodeOutputsView((() => { try { return window.sessionStorage.getItem(OUTPUTS_VIEW_KEY); } catch { return null; } })()));
  const setOutputsView = useCallback((view: OutputsView) => { setOutputsViewState(view); try { window.sessionStorage.setItem(OUTPUTS_VIEW_KEY, view); } catch { /* session storage unavailable */ } }, []);
  const [expanded, setExpandedState] = useState<ReadonlySet<string>>(() => new Set());
  const toggleFolder = useCallback((id: string) => setExpandedState(prev => toggleExpanded(prev, id)), []);
  const setExpanded = useCallback((ids: Iterable<string>) => setExpandedState(new Set(ids)), []);
  const setList = useCallback((patch: Partial<ListState>) => setListState(prev => { const next = { ...prev, ...patch }; store(LIST_KEY, encodeListState(next)); return next; }), []);
  useEffect(() => { setIndex(new Map()); setList({ projectFilter: '', memoryFilter: 'all' }); }, [mode, setList]);

  // Content metadata: in Live mode this is the same query as the preferences (same key → deduplicated); in Demo mode it is the in-memory demo document.
  const metadataKey = ['cowork', scopeKey, 'metadata', metaToken];
  const metadataQuery = useQuery({ queryKey: metadataKey, queryFn: () => repositories.metadata.load(metaToken), retry: false, staleTime: Infinity, refetchOnWindowFocus: false, enabled: modeResolved });
  const metadata = metadataQuery.data?.document ?? defaultMetadata;
  const save = useMutation({ mutationFn: (next: CompanionMetadata) => repositories.metadata.save(next), onSuccess: document => client.setQueryData<MetadataPage>(metadataKey, { document }) });
  // Explicit (confirmed) creation from Settings uses the LIVE repository too; the automatic first-run path is the bootstrap controller above.
  const initialize = useMutation({ mutationFn: () => liveRepositories.metadata.initialize(emptyMetadata()), onSuccess: document => client.setQueryData<MetadataPage>(['cowork', 'live', 'metadata', undefined], { document }) });
  const writable = !!metadataQuery.data?.document && !save.isPending && !initialize.isPending && bootstrap.status !== 'creating' && !metadataQuery.isFetching;

  // OneDrive-first sync: cheap root authorization → cached layout (IndexedDB, scoped by root item id) → outline revalidation →
  // prioritised, bounded (≤3 in flight) task hydration; Skills/Memory only when opened or idle. Demo uses a session-memory cache
  // over the in-memory repository, so Demo still makes zero live content reads. Refresh is incremental; Full rescan lives in Settings.
  const sync = useSyncEngine(repositories, { persistent: !injected && mode === 'live', path, enabled: modeResolved, intervalMs: interval });
  const layoutQuery = sync.layoutQuery;
  const layout = sync.layout;
  const summaryById = useMemo(() => new Map((layout?.tasks ?? []).map(t => [t.folder.Id, t])), [layout]);
  const observe = useCallback((items: DriveItem[]) => { changes.observe(items); setIndex(old => { const next = new Map(old); for (const item of items) next.set(item.Id, item); return next; }); }, [changes]);
  useEffect(() => { if (layout) observe(layout.observed); }, [layout, observe]);

  const update = useCallback((id: string, patch: Partial<TaskPreferences>) => { if (writable) save.mutate(patchTask(metadata, id, patch)); }, [writable, save, metadata]);
  // Keyed actions: exactly one metadata write per action, no duplicate while pending, pending always cleared, result kept 2.5 s for in-control feedback.
  const [pendingKey, setPendingKey] = useState<string>();
  const [lastResult, setLastResult] = useState<CompanionSession['lastResult']>();
  const runAction = useCallback(async (key: string, next: () => CompanionMetadata, options?: { successMessage?: string; onSuccess?: () => void }) => {
    if (pendingKey || !metadataQuery.data?.document) return false;
    setPendingKey(key);
    try {
      await save.mutateAsync(next());
      setLastResult({ key, status: 'success', at: Date.now() });
      if (options?.successMessage) toast.success(options.successMessage);
      options?.onSuccess?.();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The change could not be saved.';
      setLastResult({ key, status: 'error', message, at: Date.now() });
      toast.error(message);
      return false;
    } finally { setPendingKey(undefined); }
  }, [pendingKey, metadataQuery.data?.document, save]);
  useEffect(() => { if (!lastResult) return; const t = window.setTimeout(() => setLastResult(undefined), 2500); return () => window.clearTimeout(t); }, [lastResult]);
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => { if (layout) setSelection(prev => { const present = new Set(layout.tasks.map(t => t.folder.Id)); const next = pruneSelection(prev, present); return next.size === prev.size ? prev : next; }); }, [layout]);
  const toggleSelection = useCallback((id: string) => setSelection(prev => toggleSelected(prev, id)), []);
  const selectVisible = useCallback((ids: Iterable<string>) => setSelection(prev => selectAllIds(prev, ids)), []);
  const deselectVisible = useCallback((ids: Iterable<string>) => setSelection(prev => deselectAllIds(prev, ids)), []);
  const clearSelection = useCallback(() => setSelection(new Set()), []);
  const assign = useCallback((taskIds: Iterable<string>, projectId: string | undefined, key = 'assign') => {
    const ids = [...taskIds];
    const target = projectId ? metadata.projects.find(p => p.id === projectId)?.name : 'Unassigned';
    return runAction(key, () => assignTasks(metadata, ids, projectId), { successMessage: ids.length > 1 ? `${ids.length} tasks → ${target ?? 'project'}` : undefined, onSuccess: () => { if (ids.length > 1) setSelection(new Set()); } });
  }, [metadata, runAction]);
  const createProject = useCallback((project: Project, assignTo?: Iterable<string>, key = 'create-project') => {
    const ids = assignTo ? [...assignTo] : [];
    return runAction(key, () => (ids.length ? createProjectAndAssign(metadata, project, ids) : putProject(metadata, project)), { successMessage: ids.length ? `Created ${project.name} · ${ids.length} task${ids.length === 1 ? '' : 's'} assigned` : undefined, onSuccess: () => { if (ids.length > 1) setSelection(new Set()); } });
  }, [metadata, runAction]);
  const markSeen = useCallback((item: DriveItem) => { if (writable) save.mutate(changes.markSeen(item, metadata)); }, [writable, save, changes, metadata]);
  const markAllSeen = useCallback((items: DriveItem[]) => { if (writable && items.length) save.mutate(items.reduce((doc, item) => changes.markSeen(item, doc), metadata)); }, [writable, save, changes, metadata]);
  const createMetadata = useCallback(async () => {
    if (await confirm({ title: 'Create companion settings?', description: `Create ${repositories.metadata.location}. Only app-owned metadata will be written; Cowork files stay untouched.`, confirmLabel: 'Create settings file' })) initialize.mutate();
  }, [confirm, initialize, repositories.metadata.location]);
  const setDemoMode = useCallback(async (value: boolean) => {
    const current = preferencesQuery.data?.document;
    if (!current) { toast.error('Companion settings have not loaded yet, so Demo mode cannot be changed.'); return false; }
    if (pendingKey) return false;
    if (value === demoModeOf(current)) return true;
    setPendingKey('demo-mode');
    setOptimisticDemo(value);
    try {
      const saved = await liveRepositories.metadata.save(withDemoMode(current, value));
      client.setQueryData<MetadataPage>(liveMetadataKey, { document: saved });
      setLastResult({ key: 'demo-mode', status: 'success', at: Date.now() });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Demo mode could not be saved.';
      setLastResult({ key: 'demo-mode', status: 'error', message, at: Date.now() });
      toast.error(`Demo mode was not changed: ${message}`);
      return false; // the switch falls back to the saved value below
    } finally { setOptimisticDemo(undefined); setPendingKey(undefined); }
  }, [preferencesQuery.data?.document, pendingKey, client, liveMetadataKey]);
  // Appearance: preference from the live companion file (missing/invalid → system); the controller tracks the OS media query
  // and the resolved scheme toggles .light/.dark on <html> so the token set follows without a reload.
  const savedAppearance = appearanceOf(preferencesQuery.data?.document);
  const [optimisticAppearance, setOptimisticAppearance] = useState<Appearance>();
  const appearance = optimisticAppearance ?? savedAppearance;
  const [controller] = useState(() => new AppearanceController('system', typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches));
  const [scheme, setScheme] = useState<Scheme>(() => controller.scheme);
  useEffect(() => controller.subscribe(next => setScheme(next)), [controller]);
  useEffect(() => { controller.setAppearance(appearance); setScheme(controller.scheme); }, [appearance, controller]);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => controller.onSystemChange(e.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [controller]);
  useEffect(() => { const { add, remove } = rootClassesFor(appearance); const root = document.documentElement; root.classList.remove(...remove); if (add.length) root.classList.add(...add); root.style.colorScheme = appearance === 'system' ? '' : appearance; }, [appearance]);
  const setAppearance = useCallback(async (value: Appearance) => {
    const current = preferencesQuery.data?.document;
    if (!current) { toast.error('Companion settings have not loaded yet, so the appearance cannot be saved.'); return false; }
    if (pendingKey) return false;
    if (value === appearanceOf(current)) return true;
    setPendingKey('appearance');
    setOptimisticAppearance(value);
    try {
      const saved = await liveRepositories.metadata.save(withAppearance(current, value));
      client.setQueryData<MetadataPage>(liveMetadataKey, { document: saved });
      setLastResult({ key: 'appearance', status: 'success', at: Date.now() });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The appearance could not be saved.';
      setLastResult({ key: 'appearance', status: 'error', message, at: Date.now() });
      toast.error(`Appearance was not changed: ${message}`);
      return false;
    } finally { setOptimisticAppearance(undefined); setPendingKey(undefined); }
  }, [preferencesQuery.data?.document, pendingKey, client, liveMetadataKey]);

  // Confirmed mutations (archive, assign/unassign): the dialog states the task name or count and the destination.
  const [mutationFocus] = useState(() => new FocusReturn<HTMLElement>());
  const taskName = useCallback((taskId: string) => summaryById.get(taskId)?.folder.Name ?? taskId, [summaryById]);
  const deferToFrame = (run: () => void) => { window.requestAnimationFrame(run); };
  const confirmAssign = useCallback((taskIds: string[], projectId: string | undefined, origin: FocusOrigin<HTMLElement> | HTMLElement | null, key = 'assign') => {
    const ids = [...new Set(taskIds)];
    const currentIds = [...new Set(ids.map(id => metadata.tasks[id]?.projectId))];
    const unchanged = currentIds.length === 1 && currentIds[0] === projectId;
    const from = currentIds.length === 1 ? metadata.projects.find(p => p.id === currentIds[0])?.name : undefined;
    const to = projectId ? metadata.projects.find(p => p.id === projectId)?.name : undefined;
    const request = unchanged ? null : assignRequest(ids.map(id => taskName(id) ?? id), from, projectId ? to ?? 'project' : undefined);
    return runConfirmedMutation(request, origin, { confirm, perform: () => assign(ids, projectId, key), isBusy: () => !!pendingKey, focusReturn: mutationFocus, resolveByKey: k => resolveFocusKey(k), fallback: () => document.getElementById('companion-content'), defer: deferToFrame });
  }, [metadata, taskName, confirm, assign, pendingKey, mutationFocus]);
  const confirmArchive = useCallback((taskId: string, origin: FocusOrigin<HTMLElement> | HTMLElement | null) => {
    return runConfirmedMutation(archiveRequest(taskName(taskId) ?? taskId), origin, { confirm, perform: () => runAction(`archive:${taskId}`, () => patchTask(metadata, taskId, { archived: true })), isBusy: () => !!pendingKey, focusReturn: mutationFocus, resolveByKey: k => resolveFocusKey(k), fallback: () => document.getElementById('companion-content'), defer: deferToFrame });
  }, [taskName, confirm, runAction, metadata, pendingKey, mutationFocus]);

  const syncRefresh = sync.refresh; // stable per engine; the handle itself changes on every engine emit
  const refresh = useCallback(() => { void syncRefresh(); void client.invalidateQueries({ queryKey: ['cowork', scopeKey], predicate: q => !q.queryKey.includes('metadata') && !q.queryKey.includes('text') && !q.queryKey.includes('layout') }); }, [syncRefresh, client, scopeKey]);

  const value: CompanionSession = {
    mode, modeResolved, demoMode, setDemoMode, preferencesQuery, bootstrap, retryBootstrap, readiness, repositories, scopeKey, changes, index, observe, metadata, metadataQuery, metaToken, setMetaToken, save, initialize, writable,
    update, pendingKey, lastResult, runAction, assign, confirmAssign, confirmArchive, taskName, appearance, scheme, setAppearance, fileLinks, createProject, selection, toggleSelection, selectVisible, deselectVisible, clearSelection, markSeen, markAllSeen, createMetadata, path, setPath, interval, setInterval: setIntervalValue, layoutQuery, layout, summaryById, refresh, sync, list, setList,
    outputsView, setOutputsView, expanded, toggleFolder, setExpanded,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
const defaultMetadata = emptyMetadata();

export function useCompanion(): CompanionSession {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useCompanion must be used within <CompanionProvider>');
  return value;
}
export { defaultListState };
