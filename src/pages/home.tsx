import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Archive, ArrowLeft, BookOpen, Check, ChevronRight, Files, Folder, FolderOpen, Home, Layers, Pin, Plus, RefreshCw, Search, Settings, Trash2, ExternalLink, FileText, Brain } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { EmptyState, ErrorState } from '@/components/states';
import { Spinner } from '@/components/ui/spinner';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MoreHorizontal } from 'lucide-react';
import { splitNavigation } from '@/lib/cowork-hash-routes';
import { appearanceLabels } from '@/lib/appearance';
import { ActionStatus, ProjectPill } from '@/components/cowork-assign';
import { visibleSelectionState } from '@/lib/cowork-assignment';
import { SectionSkeleton, TaskListSkeleton } from '@/components/cowork-skeletons';
import { SyncStatusSlot, agoShort } from '@/components/cowork-sync-status';
import { TaskPage } from '@/pages/task';
import { useHashRoute } from '@/lib/use-hash-route';
import { useOverflowGuard } from '@/lib/overflow-guard';
import { FocusReturn, pillFocusKey, resolveFocusKey, type FocusOrigin } from '@/lib/focus-return';
import type { CompanionSession } from '@/lib/companion-session';
import type { FileLinkService } from '@/lib/file-links';
import type { TaskSummary } from '@/lib/cowork-discovery';
import { listSectionFor, sectionHash, sectionLabels, sections, taskHash, type Section } from '@/lib/cowork-hash-routes';
import { FileExplorer, RecentState, modified, ago, isRecent } from '@/components/cowork-file-explorer';
import { FileLink, useFileLinks } from '@/components/cowork-file-link';
import { normalizePath, type SkillSummary } from '@/lib/cowork-discovery';
import { useConfirm } from '@/hooks/use-confirm';
import { safeUrl } from '@/lib/safe-url';
import type { CompanionRepositories } from '@/lib/cowork-repositories';
import { useCompanion } from '@/lib/companion-session';
import { searchLocalFiles } from '@/lib/cowork-workspace';
import { ChangeDetectionService, deleteProject, projectColors, classify, compareText, validatedCoworkUrl, type DriveItem, type Project, type CompanionMetadata, type SkillsRepository } from '@/lib/cowork-domain';

const navIcons: Record<Section, typeof Home> = { dashboard: Home, tasks: Files, projects: Layers, skills: BookOpen, memory: Brain, archived: Archive, settings: Settings };
const navigation = sections.map(section => ({ section, label: sectionLabels[section], icon: navIcons[section] }));
// Task details are a full page (see pages/task.tsx); this dialog is only for skill, memory and loose file items.
type Selection = { item: DriveItem; kind: 'skill' | 'file' | 'memory' };
const colorClass = { green: 'bg-[#0E700E]', blue: 'bg-[#0F6CBD]', amber: 'bg-[#BC4B09]', rose: 'bg-[#C50F1F]', purple: 'bg-[#8764B8]' };
const colorLabel = { green: 'Green', blue: 'Blue', amber: 'Amber', rose: 'Rose', purple: 'Purple' };
function ProjectDot({ project, className = '' }: { project?: Project; className?: string }) { return <span aria-hidden="true" className={`inline-block size-2 shrink-0 rounded-full ${project ? colorClass[project.color] : 'border border-input bg-transparent'} ${className}`} />; }
function parentPath(path?: string) { const p = normalizePath(path); return p ? p.slice(0, p.lastIndexOf('/')) : ''; }
function kb(size?: number) { return size === undefined ? 'size n/a' : `${Math.max(1, Math.round(size / 1024))} KB`; }
// Observable description of an item from its path only: input/output folder, skill, memory, or plain file/folder.
function describeChange(item: DriveItem, taskPaths: string[]) {
  const path = (item.Path ?? '').toLowerCase();
  const segments = path.split('/').filter(Boolean);
  if (segments.includes('skills')) return item.Name === 'SKILL.md' ? 'Skill definition modified' : 'Skill file modified';
  if (segments.includes('memory') || segments.includes('config')) return 'Memory/config file modified';
  const task = taskPaths.find(t => path.startsWith(t.toLowerCase() + '/'));
  if (task) {
    const role = classify(item, task);
    if (role === 'output') return isRecent(item.LastModified, 24) ? 'New output' : 'Output file';
    if (role === 'input') return isRecent(item.LastModified, 24) ? 'New input' : 'Input file';
  }
  return item.IsFolder ? 'Folder modified' : 'File modified';
}

// Data, metadata and list state come from the shared Companion session so a task page visit and Back
// return to exactly this list state without re-reading OneDrive.
export function HomePage() {
  // The URL hash is the only route state: sections, the task page and not-found all derive from it.
  const { route, back, hasHistory } = useHashRoute();
  useOverflowGuard(`${route.kind}:${route.kind === 'task' ? route.taskId : route.kind === 'section' ? route.section : ''}`);
  const confirm = useConfirm();
  const session = useCompanion();
  const { mode, modeResolved, demoMode, setDemoMode, preferencesQuery, bootstrap, retryBootstrap, readiness, fileLinks, appearance, setAppearance, repositories, scopeKey, changes, index, observe, metadata, metadataQuery, metaToken, setMetaToken, save, initialize, writable, markSeen, createMetadata, path, setPath, interval, setInterval: setIntervalValue, layoutQuery, layout, summaryById, refresh, sync, list, setList, selection, toggleSelection, selectVisible, deselectVisible, clearSelection, assign, createProject, pendingKey, lastResult } = session;
  const { search, taskFilter, projectFilter, sort, memoryFilter, activityUnseen } = list;
  const liveLocation = '/Documents/cowork-companion.json';
  const section: Section | undefined = route.kind === 'section' ? route.section : undefined;
  const setSearch = (next: string) => setList({ search: next });
  const setTaskFilter = (next: string) => setList({ taskFilter: next as typeof taskFilter });
  const setProjectFilter = (next: string) => setList({ projectFilter: next });
  const setSort = (next: string) => setList({ sort: next === 'name' ? 'name' : 'modified' });
  const setMemoryFilter = (next: string) => setList({ memoryFilter: next });
  const setActivityUnseen = (next: boolean) => setList({ activityUnseen: next });
  const [pathInput, setPathInput] = useState(path);
  const [searchTerm, setSearchTerm] = useState(search.trim());
  const [selected, setSelected] = useState<Selection>();
  const [editingProject, setEditingProject] = useState<Project>();
  const [projectOpen, setProjectOpen] = useState(false);
  const [assignAfterCreate, setAssignAfterCreate] = useState<string[]>([]);
  // The control that opened the project dialog (row pill, bulk pill, header pill or a "New project" button) gets focus back on close.
  const [focusReturn] = useState(() => new FocusReturn<HTMLElement>());
  const [activityPage, setActivityPage] = useState(0);
  const [metaPrevious, setMetaPrevious] = useState<(string | undefined)[]>([]);
  // Restore the saved list scroll position whenever the hash returns to a list section (Back from a task page).
  const listSection = listSectionFor(route);
  const contentRef = useRef<HTMLElement>(null);
  useEffect(() => { if (route.kind === 'section' && list.scrollY > 0) window.requestAnimationFrame(() => contentRef.current?.scrollTo({ top: list.scrollY })); }, [route, list.scrollY]);
  useEffect(() => { if (route.kind === 'task') contentRef.current?.scrollTo({ top: 0 }); }, [route]);
  // Filename search is local-only by default: it matches every item in the last OneDrive read (tasks, their input/output
  // files, skills, memory). A remote OneDrive search is a separate explicit action — never issued automatically.
  const [remoteSearch, setRemoteSearch] = useState('');
  const searchQuery = useQuery({ queryKey: ['cowork', scopeKey, 'search', remoteSearch], queryFn: () => repositories.tasks.search(path, remoteSearch), enabled: remoteSearch.length >= 2 && remoteSearch === searchTerm, retry: false });
  useEffect(() => { const timer = window.setTimeout(() => setSearchTerm(search.trim()), 300); return () => window.clearTimeout(timer); }, [search]);
  useEffect(() => { if (searchQuery.data) observe(searchQuery.data); }, [searchQuery.data, observe]);
  const localMatches = searchTerm.length >= 2 ? searchLocalFiles([...index.values()], searchTerm) : [];
  // Opening a task is a real hash link (history entry); the click just records the scroll position so Back lands on the same spot.
  const rememberScroll = () => setList({ scrollY: contentRef.current?.scrollTop ?? 0 });
  function openProject(project?: Project, assignTo: string[] = [], origin?: FocusOrigin<HTMLElement>) {
    focusReturn.capture(origin ?? { node: document.activeElement instanceof HTMLElement ? document.activeElement : null }, () => document.getElementById('companion-content'));
    setEditingProject(project); setAssignAfterCreate(assignTo); setProjectOpen(true);
  }
  const createFromPill = (ids: string[], origin: FocusOrigin<HTMLElement>) => openProject(undefined, ids, origin);
  function closeProjectDialog() { setProjectOpen(false); }
  // Restore focus only after React has committed the post-close render, resolving the current node by its stable key.
  const [restoreTick, setRestoreTick] = useState(0);
  useEffect(() => {
    if (!restoreTick) return;
    const frame = window.requestAnimationFrame(() => { focusReturn.restore(key => resolveFocusKey(key)); });
    return () => window.cancelAnimationFrame(frame);
  }, [restoreTick, focusReturn]);
  function showProject(id: string) { setList({ projectFilter: id, search: '' }); if (section !== 'tasks') window.location.hash = sectionHash('tasks'); }
  async function removeProject(project: Project) {
    if (await confirm({ title: `Delete project ${project.name}?`, description: 'Tasks and files are preserved. Assigned tasks become unassigned.', destructive: true, confirmLabel: 'Delete project' })) save.mutate(deleteProject(metadata, project.id));
  }
  function resetTasks() { /* discovery reads every page; nothing to reset */ }
  const summaries = layout?.tasks ?? [];
  const currentFolders = summaries.map(t => t.folder);
  const taskPaths = currentFolders.map(t => normalizePath(t.Path)).filter(Boolean);
  const visibleTasks = currentFolders.filter(item => {
    const prefs = metadata.tasks[item.Id] ?? {};
    const project = metadata.projects.find(p => p.id === prefs.projectId);
    const latest = summaryById.get(item.Id)?.newestOutput?.LastModified ?? item.LastModified;
    return (section === 'archived' ? !!prefs.archived : !prefs.archived) && (taskFilter !== 'pinned' || prefs.pinned) && (taskFilter !== 'recent' || isRecent(latest, 24)) && (taskFilter !== 'unseen' || changes.isUnseen(item, metadata)) && (!projectFilter || (projectFilter === 'unassigned' ? !prefs.projectId : prefs.projectId === projectFilter)) && `${item.Name ?? ''} ${project?.name ?? ''}`.toLowerCase().includes(search.toLowerCase());
  }).sort((a, b) => Number(!!metadata.tasks[b.Id]?.pinned) - Number(!!metadata.tasks[a.Id]?.pinned) || (sort === 'name' ? (a.Name ?? '').localeCompare(b.Name ?? '') : (b.LastModified ?? '').localeCompare(a.LastModified ?? '')));
  const pinnedTasks = visibleTasks.filter(t => metadata.tasks[t.Id]?.pinned && section !== 'archived');
  const otherTasks = visibleTasks.filter(t => !pinnedTasks.includes(t));
  const visibleIds = visibleTasks.map(t => t.Id);
  const selectionState = visibleSelectionState(selection, visibleIds);
  const selectedIds = [...selection];
  const selectedCount = selectedIds.length;
  const selectedHidden = selectedIds.filter(id => !visibleIds.includes(id)).length;
  const bulkProjects = [...new Set(selectedIds.map(id => metadata.tasks[id]?.projectId))];
  const bulkLabel = bulkProjects.length > 1 ? 'Assign to project…' : `Assign to: ${bulkProjects[0] ? metadata.projects.find(p => p.id === bulkProjects[0])?.name ?? 'project' : 'Unassigned'}`;
  const missingSaved = layout ? Object.entries(metadata.tasks).filter(([id, p]) => (p.pinned || p.archived || p.projectId || p.coworkUrl) && !summaryById.has(id)).length : 0;
  const memoryEntries = (layout?.memory ?? []).filter(e => memoryFilter === 'all' || e.container.Id === memoryFilter);
  const rootFiles = layout?.rootFiles ?? [];
  useFileLinks(fileLinks, section === 'memory' ? [...memoryEntries.map(e => e.item), ...rootFiles] : searchTerm.length >= 2 ? [...localMatches.filter(i => !i.IsFolder).slice(0, 100), ...(searchQuery.data ?? [])] : []);
  const containerCount = layout ? Object.values(layout.containers).flat().length : 0;
  const activity = changes.activity().filter(i => !activityUnseen || changes.isUnseen(i, metadata));
  const unseenCount = changes.activity().filter(i => changes.isUnseen(i, metadata)).length;
  const projectCounts = Object.fromEntries(metadata.projects.map(p => [p.id, Object.values(metadata.tasks).filter(t => t.projectId === p.id && !t.archived).length]));
  const archivedCount = Object.values(metadata.tasks).filter(t => t.archived).length;
  const showTasks = section === 'dashboard' || section === 'tasks' || section === 'archived';
  // Progressive priorities: pinned + visible task shells are inspected first (bounded concurrency in the engine); Skills and
  // Memory are discovered only when their route opens (or in the engine's low-priority idle slot) — the dashboard never waits for them.
  const priorityIds = showTasks ? [...pinnedTasks, ...visibleTasks].slice(0, 40).map(i => i.Id).join('|') : '';
  useEffect(() => { if (priorityIds) sync.prioritizeTasks(priorityIds.split('|')); }, [sync, priorityIds]);
  useEffect(() => { if (layout && section === 'skills') void sync.ensureSkills(); }, [sync, layout, section]);
  useEffect(() => { if (layout && section === 'memory') void sync.ensureMemory(); }, [sync, layout, section]);
  const [rescanBusy, setRescanBusy] = useState<'rescan' | 'clear'>();
  const runFullRescan = async () => {
    if (rescanBusy || !(await confirm({ title: 'Rescan every Cowork folder?', description: 'Re-reads every task, skill and memory folder from OneDrive, ignoring the browser cache. Cached content stays visible while it runs; on a large folder this can take several minutes.', confirmLabel: 'Full rescan' }))) return;
    setRescanBusy('rescan'); try { await sync.fullRescan(); } finally { setRescanBusy(undefined); }
  };
  const runClearCache = async () => {
    if (rescanBusy || !(await confirm({ title: 'Clear cached data?', description: 'Removes the browser-side copy of folder metadata for this app and reads the Cowork folder again from scratch. Nothing in OneDrive changes.', confirmLabel: 'Clear cached data', destructive: true }))) return;
    setRescanBusy('clear'); try { await sync.clearCache(); } finally { setRescanBusy(undefined); }
  };
  const taskError = layoutQuery.error instanceof Error ? layoutQuery.error.message : 'Unable to read the Cowork folder.';
  const mutationError = save.error ?? initialize.error;
  const selectedProject = metadata.projects.find(p => p.id === projectFilter);

  const compactNav = splitNavigation(sections, 3);
  const overflowCurrent = section && compactNav.overflow.includes(section) ? section : undefined;
  function NavLink({ target, compact = false }: { target: Section; compact?: boolean }) {
    const Icon = navIcons[target]; const label = sectionLabels[target];
    const count = target === 'archived' ? archivedCount : undefined;
    return <a href={sectionHash(target)} className={`fl-nav-item fl-focus flex items-center gap-2 text-sm ${compact ? 'shrink-0 px-2.5 py-1.5' : 'w-full px-3 py-1.5'}`} aria-current={section === target ? 'page' : undefined} aria-label={count ? `${label}, ${count} archived` : undefined} onClick={() => { setSelected(undefined); if (target !== 'tasks') setProjectFilter(''); }}><Icon className="size-4 shrink-0" aria-hidden="true" /><span className="truncate">{label}</span>{!compact && count !== undefined && count > 0 && <span className="fl-badge ml-auto" aria-hidden="true">{count}</span>}</a>;
  }
  function NavItems() { return <>{navigation.map(({ section: target }) => <NavLink key={target} target={target} />)}</>; }

  // Stable shell: header and left nav are sized by the host, never by route content; only the content column scrolls.
  return <div className="companion-shell flex h-full min-h-0 flex-col">
    <a href="#companion-content" className="sr-only rounded bg-card p-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50">Skip to content</a>
    <header className="z-20 shrink-0 border-b bg-card">
      <div className="mx-auto flex h-12 w-full max-w-[1400px] items-center gap-3 px-3">
        <div className="flex min-w-0 shrink items-center gap-2"><span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground"><Layers className="size-4" /></span><h1 className="truncate text-base font-semibold tracking-tight">Cowork Companion</h1></div>
        <div className="relative mx-auto hidden w-full max-w-md sm:block"><Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" /><Input aria-label="Search tasks, projects, files, or skills" className="h-8 border-transparent bg-muted pl-8 focus-visible:border-input focus-visible:bg-card" placeholder="Search tasks, files, or projects…" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {mode === 'demo' && <span className="fl-badge fl-badge-warning shrink-0" title="Demo mode: built-in sample content held in memory. Nothing shown comes from OneDrive." aria-label="Demo mode: sample content, not OneDrive"><span className="sm:hidden">Demo</span><span className="hidden sm:inline">Demo mode · sample content</span></span>}
          {modeResolved && <span className="hidden md:block"><SyncStatusSlot status={sync.status} onRetry={refresh} /></span>}
          <Button variant="ghost" size="icon-sm" className="fl-focus" aria-label={layoutQuery.isFetching ? 'Checking OneDrive for changes' : 'Check OneDrive for changes (incremental refresh)'} aria-busy={layoutQuery.isFetching || undefined} disabled={sync.status.phase !== 'idle'} onClick={refresh}>{layoutQuery.isFetching ? <Spinner className="size-4" role="presentation" aria-label={undefined} aria-hidden="true" /> : <RefreshCw aria-hidden="true" className="size-4" />}</Button>
          <Button asChild variant="ghost" size="icon-sm" className="fl-focus"><a href={sectionHash('settings')} aria-label="Settings" aria-current={section === 'settings' ? 'page' : undefined}><Settings aria-hidden="true" className="size-4" /></a></Button>
        </div>
      </div>
      <div className="px-3 pb-2 sm:hidden"><div className="relative"><Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" /><Input aria-label="Search tasks, projects, files, or skills" className="h-8 bg-muted pl-8" placeholder="Search tasks, files, or projects…" value={search} onChange={e => setSearch(e.target.value)} /></div></div>
      <nav aria-label="Companion navigation" className="flex min-w-0 items-center gap-1 border-t px-2 py-1 md:hidden">
        {compactNav.primary.map(target => <NavLink key={target} target={target} compact />)}
        <span className="hidden sm:contents">{compactNav.overflow.map(target => <NavLink key={target} target={target} compact />)}</span>
        <span className="ml-auto sm:hidden"><DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" className="fl-nav-item fl-focus flex shrink-0 items-center gap-1 px-2.5 py-1.5 text-sm" aria-label={`More sections${overflowCurrent ? ` (current: ${sectionLabels[overflowCurrent]})` : ''}`} aria-current={overflowCurrent ? 'page' : undefined}><MoreHorizontal className="size-4" aria-hidden="true" />More</button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">{compactNav.overflow.map(target => { const Icon = navIcons[target]; return <DropdownMenuItem key={target} asChild><a href={sectionHash(target)} aria-current={section === target ? 'page' : undefined} className={section === target ? 'font-semibold' : undefined}><Icon className="size-4" aria-hidden="true" />{sectionLabels[target]}{target === 'archived' && archivedCount > 0 ? <span className="fl-badge ml-auto">{archivedCount}</span> : null}</a></DropdownMenuItem>; })}</DropdownMenuContent>
        </DropdownMenu></span>
      </nav>
    </header>
    <div className="mx-auto flex w-full min-h-0 max-w-[1400px] flex-1 gap-3 px-3 pt-3">
      <nav aria-label="Companion navigation" className="hidden w-[200px] shrink-0 self-stretch overflow-y-auto pb-3 md:block">
        <div className="space-y-1">
          <NavItems />
          <div className="pt-3">
            <div className="flex items-center justify-between px-3 pb-1"><h2 className="text-xs font-semibold text-muted-foreground">My projects</h2><Button variant="ghost" size="icon-xs" className="fl-focus" aria-label="New project" disabled={!writable} onClick={() => openProject()}><Plus className="size-3.5" aria-hidden="true" /></Button></div>
            <a href={sectionHash('tasks')} className="fl-nav-item fl-focus flex w-full items-center gap-2 px-3 py-1.5 text-sm" aria-current={showTasks && !projectFilter ? 'true' : undefined} onClick={() => { setProjectFilter(''); resetTasks(); }}><Layers className="size-4 shrink-0" aria-hidden="true" /><span className="truncate">All projects</span><span className="fl-badge ml-auto">{currentFolders.filter(t => !metadata.tasks[t.Id]?.archived).length}</span></a>
            {metadata.projects.map(project => <a key={project.id} href={sectionHash('tasks')} className="fl-nav-item fl-focus flex w-full items-center gap-2 px-3 py-1.5 text-sm" aria-current={showTasks && projectFilter === project.id ? 'true' : undefined} onClick={() => setList({ projectFilter: project.id, search: '' })}><ProjectDot project={project} className="ml-1 mr-1" /><span className="truncate">{project.name}</span><span className="fl-badge ml-auto">{projectCounts[project.id] ?? 0}</span></a>)}
            <a href={sectionHash('tasks')} className="fl-nav-item fl-focus flex w-full items-center gap-2 px-3 py-1.5 text-sm" aria-current={showTasks && projectFilter === 'unassigned' ? 'true' : undefined} onClick={() => setList({ projectFilter: 'unassigned', search: '' })}><ProjectDot className="ml-1 mr-1" /><span className="truncate">Unassigned</span></a>
          </div>
        </div>
      </nav>
      <main id="companion-content" tabIndex={-1} ref={contentRef} className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto pb-3 outline-none">
        {!metadataQuery.data?.document && section !== 'settings' && !metadataQuery.isPending && !initialize.isPending && <div className="fl-card flex flex-wrap items-center gap-2 p-2 text-xs"><p className="min-w-0 flex-1">Companion settings could not be loaded, so projects, pins, archives, saved links and seen-state are read-only for now.</p><Button asChild variant="outline" size="xs" className="fl-focus"><a href={sectionHash('settings')}>Review settings</a></Button></div>}
        {(save.isPending || initialize.isPending) && <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-xs text-muted-foreground"><Spinner className="size-3" role="presentation" aria-label={undefined} aria-hidden="true" />{initialize.isPending ? `Creating ${repositories.metadata.location}…` : 'Saving companion metadata…'}</p>}
        {layout && layout.issues.length > 0 && <details className="fl-card p-2 text-xs"><summary className="fl-focus cursor-pointer rounded font-medium text-[var(--fl-warning)]">{layout.issues.length} folder{layout.issues.length === 1 ? '' : 's'} could not be fully read</summary><ul className="mt-1 space-y-1">{layout.issues.map((issue, i) => <li key={i} className="break-all"><span className="font-medium">{issue.path}</span> — {issue.message}</li>)}</ul></details>}
        {mutationError && <div role="alert" className="fl-card border-destructive/40 p-3 text-sm"><p>{mutationError instanceof Error ? mutationError.message : 'Companion metadata could not be saved.'}</p><Button asChild variant="outline" size="xs" className="fl-focus mt-2"><a href={sectionHash('settings')} onClick={() => { save.reset(); initialize.reset(); }}>Review save settings</a></Button></div>}
        {route.kind === 'task' && <TaskPage key={route.taskId} taskId={route.taskId} listSection={listSection} onBack={back} hasHistory={hasHistory} onCreateProject={createFromPill} />}
        {route.kind === 'not-found' && <EmptyState title="Page not found" description={route.reason === 'malformed-task-id' ? 'This task link is malformed.' : `There is no “${route.hash.replace(/^#\//, '')}” section in Cowork Companion.`} action={<Button asChild size="sm"><a href={sectionHash('tasks')}><ArrowLeft className="size-4" aria-hidden="true" />Go to Tasks</a></Button>} className="fl-card py-10" />}
        {route.kind === 'section' && searchTerm.length >= 2 && <section aria-labelledby="search-heading" className="fl-card space-y-2 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="search-heading" className="font-semibold">Search results for “{searchTerm}”</h2>{sync.status.pendingHydration > 0 && <span role="status" className="text-xs text-muted-foreground">Still indexing {sync.status.pendingHydration} task folder{sync.status.pendingHydration === 1 ? '' : 's'} — file matches may be incomplete</span>}<Button size="xs" variant="ghost" className="fl-focus" onClick={() => setSearch('')}>Clear</Button></div>
          <p className="text-xs text-muted-foreground">Matching tasks are filtered in the list below. Projects match companion settings. Filenames match the {index.size.toLocaleString()} items in the last OneDrive read{layout ? ` (${modified(layout.completedAt)})` : ''}.</p>
          <div className="flex flex-wrap gap-1">{metadata.projects.filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase())).map(project => <Button key={project.id} size="xs" variant="outline" className="fl-focus h-auto whitespace-normal" onClick={() => showProject(project.id)}><ProjectDot project={project} />{project.name}</Button>)}</div>
          {!localMatches.length && <EmptyState icon={Search} title="No filename matches in the last read" className="py-3" />}
          <ul className="divide-y">{localMatches.slice(0, 100).map(item => <li key={item.Id} className="fl-row flex flex-wrap items-center gap-2 px-1 py-1.5">{summaryById.has(item.Id) ? <a href={taskHash(item.Id)} className="fl-focus block min-w-0 flex-1 rounded text-left" onClick={rememberScroll}><span className="block truncate text-sm font-medium">{item.Name}</span><span className="block truncate text-xs text-muted-foreground">{item.Path ?? 'Path not provided'} · {ago(item.LastModified)}</span></a> : <span className="min-w-0 flex-1"><span className="flex items-center gap-2">{item.IsFolder ? <button className="fl-focus truncate rounded text-left text-sm font-medium" onClick={() => setSelected({ item, kind: 'file' })}>{item.Name}</button> : <FileLink item={item} links={fileLinks} />}<RecentState item={item} metadata={metadata} changes={changes} /></span><span className="block truncate text-xs text-muted-foreground">{item.Path ?? 'Path not provided'} · {ago(item.LastModified)}</span></span>}{!item.IsFolder && /\.(md|txt|json|csv|yaml|yml|log)$/i.test(item.Name ?? '') && <Button size="xs" variant="ghost" className="fl-focus" aria-label={`Preview ${item.Name} as text`} onClick={() => setSelected({ item, kind: 'file' })}>Preview</Button>}</li>)}</ul>
          {localMatches.length > 100 && <p className="text-xs text-muted-foreground">Showing 100 of {localMatches.length} matches; narrow the search.</p>}
          {mode === 'live' && <div className="space-y-1 border-t pt-2">
            {remoteSearch !== searchTerm && <Button size="xs" variant="ghost" className="fl-focus" onClick={() => setRemoteSearch(searchTerm)}>Also search OneDrive by name (one connector call)</Button>}
            {remoteSearch === searchTerm && searchQuery.isPending && <Button size="xs" variant="ghost" className="fl-focus" disabled aria-busy="true" aria-label="Searching OneDrive by name"><Spinner className="size-3" role="presentation" aria-label={undefined} aria-hidden="true" />Searching OneDrive…</Button>}
            {remoteSearch === searchTerm && searchQuery.isPending && <span role="status" aria-live="polite" className="sr-only">Searching OneDrive by name</span>}
            {remoteSearch === searchTerm && searchQuery.isError && <p role="alert" className="text-xs text-destructive">OneDrive search unavailable: {searchQuery.error instanceof Error ? searchQuery.error.message : 'the connector rejected the request.'} Local results above are unaffected.</p>}
            {remoteSearch === searchTerm && searchQuery.isSuccess && <><p className="text-xs text-muted-foreground">OneDrive returned {searchQuery.data.length} name match{searchQuery.data.length === 1 ? '' : 'es'}{searchQuery.data.filter(i => !localMatches.some(l => l.Id === i.Id)).length ? ` (${searchQuery.data.filter(i => !localMatches.some(l => l.Id === i.Id)).length} not in the last read)` : ''}.</p><ul className="divide-y">{searchQuery.data.filter(i => !localMatches.some(l => l.Id === i.Id)).map(item => <li key={item.Id} className="fl-row flex flex-wrap items-center gap-2 px-1 py-1.5"><span className="min-w-0 flex-1"><span className="block truncate text-sm"><FileLink item={item} links={fileLinks} /></span><span className="block truncate text-xs text-muted-foreground">{item.Path ?? 'Path not provided'} · {ago(item.LastModified)}</span></span></li>)}</ul></>}
          </div>}
          {layout && layout.skills.some(s => `${s.folder.Name ?? ''} ${s.summary}`.toLowerCase().includes(searchTerm.toLowerCase())) && <div className="space-y-1"><h3 className="text-xs font-semibold text-muted-foreground">Skills</h3><ul aria-label="Matching skills" className="divide-y">{layout.skills.filter(s => `${s.folder.Name ?? ''} ${s.summary}`.toLowerCase().includes(searchTerm.toLowerCase())).map(skill => <SkillRow key={skill.folder.Id} skill={skill} metadata={metadata} changes={changes} onOpen={() => setSelected({ item: skill.folder, kind: 'skill' })} />)}</ul></div>}
        </section>}
        {showTasks && (layoutQuery.isPending || !modeResolved) && <TaskListSkeleton withRail={section === 'dashboard'} label={!modeResolved ? 'Checking your saved preference' : undefined} />}
        {showTasks && !layoutQuery.isPending && modeResolved && <div className={`grid gap-3 ${section === 'dashboard' ? 'xl:grid-cols-[minmax(0,1fr)_280px]' : ''}`}>
          <section aria-labelledby="tasks-heading" className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="tasks-heading" className="text-xl font-semibold tracking-tight">{section === 'archived' ? 'Archived' : selectedProject ? selectedProject.name : projectFilter === 'unassigned' ? 'Unassigned tasks' : 'Tasks'}</h2>
              {selectedProject && <ProjectDot project={selectedProject} />}
              <span className="ml-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"><span className="shrink-0">{visibleTasks.length} of {currentFolders.length} tasks</span><span aria-hidden="true">·</span><span className="md:hidden"><SyncStatusSlot status={sync.status} onRetry={refresh} /></span><span className="hidden md:inline" title={sync.status.lastSyncedAt ? modified(sync.status.lastSyncedAt) : undefined}>{sync.status.lastSyncedAt ? `synced ${agoShort(sync.status.lastSyncedAt)}` : 'not synced yet'}</span></span>
            </div>
            <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-2" aria-busy={pendingKey === 'bulk-assign' || pendingKey === 'bulk-unassign' || undefined}>
              <Checkbox className="fl-focus ml-2" checked={selectionState === 'all' ? true : selectionState === 'some' ? 'indeterminate' : false} disabled={!visibleIds.length} onCheckedChange={() => selectionState === 'all' ? deselectVisible(visibleIds) : selectVisible(visibleIds)} aria-label={selectionState === 'all' ? `Deselect all ${visibleIds.length} visible tasks` : `Select all ${visibleIds.length} visible tasks`} />
              {selectedCount > 0 ? <>
                <span className="text-xs font-medium" aria-live="polite">{selectedCount} selected{selectedHidden ? ` (${selectedHidden} hidden by filters)` : ''}</span>
                <ProjectPill taskIds={selectedIds} actionKey="bulk-assign" focusKey={pillFocusKey('bulk')} metadata={metadata} session={session} size="xs" label={bulkLabel} onCreate={createFromPill} />
                <Button size="xs" variant="outline" className="fl-focus w-24 min-w-0 justify-center" disabled={!writable || !!pendingKey || !selectedIds.some(id => metadata.tasks[id]?.projectId)} aria-busy={pendingKey === 'bulk-unassign' || undefined} onClick={() => void assign(selectedIds, undefined, 'bulk-unassign')}>{pendingKey === 'bulk-unassign' ? <Spinner className="size-3" role="presentation" aria-label={undefined} aria-hidden="true" /> : <>Unassign<ActionStatus actionKey="bulk-unassign" pendingKey={pendingKey} lastResult={lastResult} size="size-3.5" /></>}</Button>
                <Button size="xs" variant="ghost" className="fl-focus" onClick={clearSelection}>Clear selection</Button>
              </> : <>
              <ToggleGroup type="single" value={taskFilter} onValueChange={value => { if (value) setTaskFilter(value); }} aria-label="Task filter" className="flex flex-wrap gap-0.5 rounded-md bg-muted p-0.5">{[['all', section === 'archived' ? 'All archived' : 'All tasks'], ['pinned', 'Pinned'], ['recent', 'Recent'], ['unseen', 'Unseen']].filter(([v]) => section !== 'archived' || v !== 'pinned').map(([value, label]) => <ToggleGroupItem key={value} value={value} className="fl-focus h-7 rounded px-2.5 text-xs font-medium data-[state=on]:bg-card data-[state=on]:text-secondary-foreground data-[state=on]:shadow-[var(--fl-shadow2)]">{label}</ToggleGroupItem>)}</ToggleGroup>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">Project<select aria-label="Filter by project" className="fl-focus h-7 min-w-0 max-w-[10rem] rounded-md border bg-card px-1.5 text-xs text-foreground" value={projectFilter} onChange={e => setProjectFilter(e.target.value)}><option value="">All projects</option><option value="unassigned">Unassigned</option>{metadata.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">Sort<select aria-label="Sort tasks" className="fl-focus h-7 rounded-md border bg-card px-1.5 text-xs text-foreground" value={sort} onChange={e => setSort(e.target.value)}><option value="modified">Last updated</option><option value="name">Name A–Z</option></select></label>
              </>}
            </div>
            {layoutQuery.isError && <ErrorState title={`Couldn’t read ${path}`} description={taskError} action={<div className="flex flex-wrap justify-center gap-2"><Button size="sm" onClick={() => void layoutQuery.refetch()}>Retry</Button><Button asChild size="sm" variant="outline"><a href={sectionHash('settings')}>Check folder settings</a></Button></div>} className="fl-card py-8" />}
            {layout && <>
              {layout.flatLayout && currentFolders.length > 0 && <p className="text-xs text-muted-foreground">No “Tasks” container found under {path}; its direct subfolders are shown as tasks.</p>}
              {layout.tasksTruncated && <p className="text-xs text-[var(--fl-warning)]">The task container has more folders than were read; narrow the folder in Settings.</p>}
              {pinnedTasks.length > 0 && <div className="space-y-1"><h3 className="flex items-center gap-1.5 px-1 text-xs font-semibold text-muted-foreground"><Pin className="size-3.5 fill-primary text-primary" aria-hidden="true" />Pinned</h3><ul aria-label="Pinned tasks" className="fl-card divide-y overflow-hidden">{pinnedTasks.map(item => <TaskRow key={item.Id} item={item} summary={summaryById.get(item.Id)} metadata={metadata} changes={changes} session={session} selected={selection.has(item.Id)} onToggleSelection={toggleSelection} onCreateProject={createFromPill} rememberScroll={rememberScroll} />)}</ul></div>}
              <div className="space-y-1">{pinnedTasks.length > 0 && <h3 className="px-1 text-xs font-semibold text-muted-foreground">{section === 'archived' ? 'Archived' : 'All tasks'}</h3>}<ul aria-label={section === 'archived' ? 'Archived tasks' : 'Tasks'} className="fl-card divide-y overflow-hidden">{!visibleTasks.length && <li className="list-none"><EmptyState icon={section === 'archived' ? Archive : Folder} title={section === 'archived' ? 'No archived tasks' : search || taskFilter !== 'all' || projectFilter ? 'No tasks match these filters' : 'No task folders found'} description={section === 'archived' ? 'Archive a task from its row to hide it from the working view. Files stay in OneDrive.' : search || taskFilter !== 'all' || projectFilter ? undefined : `Looked for a “Tasks” container (any casing) and task subfolders under ${path}. Adjust the folder in Settings if your tasks live elsewhere.`} action={(search || taskFilter !== 'all' || projectFilter) ? <Button variant="outline" size="sm" onClick={() => { setTaskFilter('all'); setProjectFilter(''); setSearch(''); }}>Reset filters</Button> : section !== 'archived' ? <Button asChild variant="outline" size="sm"><a href={sectionHash('settings')}>Folder settings</a></Button> : undefined} className="py-8" /></li>}{otherTasks.map(item => <TaskRow key={item.Id} item={item} summary={summaryById.get(item.Id)} metadata={metadata} changes={changes} session={session} selected={selection.has(item.Id)} onToggleSelection={toggleSelection} onCreateProject={createFromPill} rememberScroll={rememberScroll} />)}</ul></div>
            </>}
            {missingSaved > 0 && <p className="text-xs text-muted-foreground">{missingSaved} saved task record{missingSaved === 1 ? '' : 's'} refer to folders not found under {path}; the companion metadata is preserved.</p>}
          </section>
          {section === 'dashboard' && <aside aria-label="Recent activity and quick open" className="min-w-0 space-y-3">
            <section aria-labelledby="activity-heading" className="fl-card p-3">
              <div className="mb-2 flex items-center justify-between gap-2"><h2 id="activity-heading" className="font-semibold">Recent activity</h2><button className={`fl-focus rounded px-1.5 py-0.5 text-xs font-medium ${activityUnseen ? 'bg-secondary text-secondary-foreground' : 'text-primary hover:underline'}`} aria-pressed={activityUnseen} onClick={() => { setActivityUnseen(!activityUnseen); setActivityPage(0); }}>{activityUnseen ? 'Showing unseen' : unseenCount ? `${unseenCount} unseen` : 'Unseen only'}</button></div>
              {!activity.length && <EmptyState icon={Check} title={activityUnseen ? 'Nothing unseen' : 'No observed changes yet'} description={activityUnseen ? undefined : 'Items appear here as their OneDrive metadata is read.'} className="py-4" />}
              <ol className="relative space-y-0 border-l border-border pl-3">{activity.slice(activityPage * 6, activityPage * 6 + 6).map(item => {
                const taskPath = taskPaths.find(t => normalizePath(item.Path).toLowerCase().startsWith(t.toLowerCase() + '/')) ?? (currentFolders.some(t => t.Id === item.Id) ? normalizePath(item.Path) : undefined);
                const task = currentFolders.find(t => normalizePath(t.Path) === taskPath);
                const project = task ? metadata.projects.find(p => p.id === metadata.tasks[task.Id]?.projectId) : undefined;
                const unseen = changes.isUnseen(item, metadata);
                return <li key={item.Id} className="relative py-1.5"><span aria-hidden="true" className={`absolute -left-[17px] top-3 size-2 rounded-full ring-2 ring-card ${project ? colorClass[project.color] : unseen ? 'bg-primary' : 'bg-input'}`} />
                  {task ? <a href={taskHash(task.Id)} className="fl-focus block w-full min-w-0 rounded text-left" onClick={rememberScroll}><span className="block truncate text-sm font-medium">{task && task.Id !== item.Id ? task.Name : item.Name ?? item.Id}</span><span className="block truncate text-xs text-muted-foreground">{task && task.Id !== item.Id ? `${describeChange(item, taskPaths)} · ${item.Name}` : describeChange(item, taskPaths)}</span><span className="block text-xs text-muted-foreground">{ago(item.LastModified, '').trim() || modified(item.LastModified)}</span></a> : <button className="fl-focus w-full min-w-0 rounded text-left" onClick={() => setSelected({ item, kind: 'file' })}><span className="block truncate text-sm font-medium">{item.Name ?? item.Id}</span><span className="block truncate text-xs text-muted-foreground">{describeChange(item, taskPaths)}</span><span className="block text-xs text-muted-foreground">{ago(item.LastModified, '').trim() || modified(item.LastModified)}</span></button>}
                  {unseen && <Button variant="ghost" size="xs" className="fl-focus mt-0.5 h-6 px-1 text-primary" disabled={!writable} onClick={() => markSeen(item)}><Check className="size-3" aria-hidden="true" />Mark seen</Button>}
                </li>;
              })}</ol>
              <Paging previous={activityPage > 0} next={(activityPage + 1) * 6 < activity.length} busy={false} onPrevious={() => setActivityPage(p => p - 1)} onNext={() => setActivityPage(p => p + 1)} labels={['Newer', 'Older']} />
            </section>
            <section aria-labelledby="quick-heading" className="fl-card p-3">
              <h2 id="quick-heading" className="mb-2 font-semibold">Quick open</h2>
              <ul className="space-y-0.5 text-sm">
                {layout?.root && <li><QuickOpenFolder item={layout.root} links={fileLinks} /></li>}
                <li><button className="fl-row fl-focus flex w-full items-center gap-2 px-1.5 py-1.5 text-left" disabled={!writable} onClick={() => openProject()}><span className="grid size-7 place-items-center rounded-md bg-secondary text-secondary-foreground"><Plus className="size-4" aria-hidden="true" /></span><span className="min-w-0"><span className="block font-medium">New project</span><span className="block text-xs text-muted-foreground">Virtual grouping in Companion</span></span></button></li>
                <li><a href={sectionHash('skills')} className="fl-row fl-focus flex w-full items-center gap-2 px-1.5 py-1.5 text-left"><span className="grid size-7 place-items-center rounded-md bg-secondary text-secondary-foreground"><BookOpen className="size-4" aria-hidden="true" /></span><span className="min-w-0"><span className="block font-medium">Browse skills</span><span className="block text-xs text-muted-foreground">SKILL.md definitions</span></span></a></li>
                {Object.entries(metadata.tasks).filter(([, p]) => p.coworkUrl && !p.archived).slice(0, 5).map(([id, p]) => <li key={id}><a className="fl-row fl-focus flex w-full items-center gap-2 px-1.5 py-1.5 text-left" href={safeUrl(validatedCoworkUrl(p.coworkUrl ?? ''))} target="_blank" rel="noopener noreferrer"><span className="grid size-7 place-items-center rounded-md bg-secondary text-secondary-foreground"><ExternalLink className="size-4" aria-hidden="true" /></span><span className="min-w-0"><span className="block truncate font-medium">{index.get(id)?.Name ?? 'Saved task link'}</span><span className="block text-xs text-muted-foreground">Open in Cowork (saved link)</span></span></a></li>)}
              </ul>
            </section>
          </aside>}
        </div>}
        {section === 'projects' && <section aria-labelledby="projects-heading" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="projects-heading" className="text-xl font-semibold tracking-tight">Projects</h2><Button size="sm" className="fl-focus" disabled={!writable} onClick={() => openProject()}><Plus className="size-4" aria-hidden="true" />New project</Button></div>
          <p className="text-xs text-muted-foreground">Projects are virtual groupings saved in companion metadata. Cowork folders are never moved or renamed.</p>
          <ul aria-label="Projects" className="fl-card divide-y overflow-hidden">{!metadata.projects.length && <li className="list-none"><EmptyState icon={Layers} title="No projects yet" description="Create a project, then assign tasks to it from a task’s details." action={<Button size="sm" disabled={!writable} onClick={() => openProject()}>Create project</Button>} className="py-8" /></li>}{metadata.projects.filter(p => p.name.toLowerCase().includes(search.toLowerCase())).map(project => <li key={project.id} className="fl-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2"><ProjectDot project={project} /><button className="fl-focus min-w-0 rounded text-left" title={project.name} aria-label={`Show tasks in ${project.name}`} onClick={() => showProject(project.id)}><span className="block truncate font-medium">{project.name}</span><span className="block text-xs text-muted-foreground">{projectCounts[project.id] ?? 0} task{projectCounts[project.id] === 1 ? '' : 's'} · {colorLabel[project.color]}</span></button><span className="flex items-center gap-1"><Button size="xs" variant="outline" className="fl-focus" disabled={!writable} aria-label={`Edit project ${project.name}`} onClick={() => openProject(project)}>Edit</Button><Button size="icon-xs" variant="ghost" className="fl-focus" aria-label={`Delete project ${project.name}`} disabled={!writable} onClick={() => void removeProject(project)}><Trash2 aria-hidden="true" className="size-3.5" /></Button></span></li>)}</ul>
          <Button variant="outline" size="sm" className="fl-focus" onClick={() => showProject('unassigned')}>View unassigned tasks</Button>
        </section>}
        {section === 'skills' && <section aria-labelledby="skills-heading" className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 id="skills-heading" className="text-xl font-semibold tracking-tight">Skills</h2><span className="truncate text-xs text-muted-foreground">/Documents/Cowork/skills/{'{skill-name}'}/SKILL.md</span></div>
          {(layoutQuery.isPending || !modeResolved || (layout && sync.status.skills === 'loading' && layout.skills.length === 0)) && <SectionSkeleton rows={3} label="Reading the skills folder from OneDrive" />}{layoutQuery.isError && <ErrorState title={`Couldn’t read ${path}`} description={taskError} action={<Button size="sm" onClick={() => void layoutQuery.refetch()}>Retry</Button>} className="fl-card py-8" />}
          {layout && <SectionSyncLine state={sync.status.skills} error={sync.status.skillsError} syncedAt={sync.status.lastSyncedAt} noun="skills" onRetry={() => void sync.ensureSkills()} />}
          {layout && (sync.status.skills !== 'loading' || layout.skills.length > 0) && <>
            {layout.containers.skills.length > 0 && <p className="text-xs text-muted-foreground">Skills container{layout.containers.skills.length === 1 ? '' : 's'}: {layout.containers.skills.map(c => normalizePath(c.Path) || c.Name).join(', ')} · {layout.skills.length} skill{layout.skills.length === 1 ? '' : 's'} with SKILL.md</p>}
            <ul aria-label="Skills" className="fl-card divide-y overflow-hidden">{layout.containers.skills.length === 0 ? <li className="list-none"><EmptyState icon={BookOpen} title="No skills folder found" description={`${path} has no folder named “skills” (any casing). Skills appear here once Cowork creates one; each skill is a folder containing SKILL.md.`} className="py-8" /></li> : !layout.skills.length && <li className="list-none"><EmptyState icon={BookOpen} title="No SKILL.md definitions found" description="The skills folder exists but no subfolder (searched 4 levels deep) contains a SKILL.md file." className="py-8" /></li>}{layout.skills.filter(s => `${s.folder.Name ?? ''} ${s.summary}`.toLowerCase().includes(search.toLowerCase())).map(skill => <SkillRow key={skill.folder.Id} skill={skill} metadata={metadata} changes={changes} onOpen={() => setSelected({ item: skill.folder, kind: 'skill' })} />)}</ul>
          </>}
        </section>}
        {section === 'memory' && <section aria-labelledby="memory-heading" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="memory-heading" className="text-xl font-semibold tracking-tight">Memory &amp; config</h2>{layout && (layout.containers.memory.length + layout.containers.config.length) > 1 && <label className="flex items-center gap-1.5 text-xs text-muted-foreground">Folder<select aria-label="Memory and configuration folder" className="fl-focus h-7 max-w-full rounded-md border bg-card px-1.5 text-xs text-foreground" value={memoryFilter} onChange={e => setMemoryFilter(e.target.value)}><option value="all">All folders</option>{[...layout.containers.memory, ...layout.containers.config].map(c => <option key={c.Id} value={c.Id}>{normalizePath(c.Path) || c.Name}</option>)}</select></label>}</div>
          <p className="text-xs text-muted-foreground">Shows file names, timestamps and contents as stored. Whether a task or conversation uses a memory item is not observable here and is never implied.</p>
          {(layoutQuery.isPending || !modeResolved || (layout && sync.status.memory === 'loading' && layout.memory.length === 0)) && <SectionSkeleton rows={3} label="Reading memory and configuration folders from OneDrive" />}{layoutQuery.isError && <ErrorState title={`Couldn’t read ${path}`} description={taskError} action={<Button size="sm" onClick={() => void layoutQuery.refetch()}>Retry</Button>} className="fl-card py-8" />}
          {layout && <SectionSyncLine state={sync.status.memory} error={sync.status.memoryError} syncedAt={sync.status.lastSyncedAt} noun="memory and configuration files" onRetry={() => void sync.ensureMemory()} />}
          {layout && (sync.status.memory !== 'loading' || layout.memory.length > 0) && <>
            {(layout.containers.memory.length + layout.containers.config.length) > 0 && <p className="text-xs text-muted-foreground">{[...layout.containers.memory, ...layout.containers.config].map(c => normalizePath(c.Path) || c.Name).join(', ')} · {layout.memory.length} file{layout.memory.length === 1 ? '' : 's'}{layout.memoryTruncated ? ' (list capped)' : ''}</p>}
            <ul aria-label="Memory and config files" className="fl-card divide-y overflow-hidden">{(layout.containers.memory.length + layout.containers.config.length) === 0 ? <li className="list-none"><EmptyState icon={Brain} title="No memory or config folder found" description={`${path} has no folder named “memory”, “memories”, “config” or “settings” (any casing). Files appear here once Cowork creates one.`} className="py-8" /></li> : !memoryEntries.length && <li className="list-none"><EmptyState icon={Brain} title="No files in this folder" className="py-8" /></li>}{memoryEntries.filter(e => (e.item.Name ?? '').toLowerCase().includes(search.toLowerCase())).map(({ item, container, kind }) => <li key={item.Id} className="fl-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2"><FileText className="size-4 text-muted-foreground" aria-hidden="true" /><span className="min-w-0"><span className="flex items-center gap-2"><FileLink item={item} links={fileLinks} className="truncate font-medium" /><span className="fl-badge">{kind}</span><RecentState item={item} metadata={metadata} changes={changes} /></span><span className="block truncate text-xs text-muted-foreground" title={modified(item.LastModified)}>{ago(item.LastModified)} · {kb(item.Size)} · {normalizePath(parentPath(item.Path)) || normalizePath(container.Path) || container.Name}</span></span><Button size="xs" variant="ghost" className="fl-focus" aria-label={`Preview ${item.Name} as text`} onClick={() => setSelected({ item, kind: 'memory' })}>Preview</Button></li>)}</ul>
            {rootFiles.length > 0 && <div className="space-y-1"><h3 className="px-1 text-xs font-semibold text-muted-foreground">Files directly in {path}</h3><ul aria-label="Files in the Cowork root" className="fl-card divide-y overflow-hidden">{rootFiles.filter(i => (i.Name ?? '').toLowerCase().includes(search.toLowerCase())).map(item => <li key={item.Id} className="fl-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2"><FileText className="size-4 text-muted-foreground" aria-hidden="true" /><span className="min-w-0"><span className="flex items-center gap-2"><FileLink item={item} links={fileLinks} className="truncate font-medium" /><RecentState item={item} metadata={metadata} changes={changes} /></span><span className="block text-xs text-muted-foreground" title={modified(item.LastModified)}>{ago(item.LastModified)} · {kb(item.Size)}</span></span><Button size="xs" variant="ghost" className="fl-focus" aria-label={`Preview ${item.Name} as text`} onClick={() => setSelected({ item, kind: 'memory' })}>Preview</Button></li>)}</ul></div>}
          </>}
        </section>}
        {section === 'settings' && <section aria-labelledby="settings-heading" className="space-y-3">
          <h2 id="settings-heading" className="text-xl font-semibold tracking-tight">Settings</h2>
          <form className="fl-card space-y-2 p-4" onSubmit={e => { e.preventDefault(); if (!pathInput.trim().startsWith('/')) return; setPath(pathInput.trim().replace(/\/$/, '')); resetTasks(); window.location.hash = sectionHash('tasks'); }}>
            <h3 className="font-semibold">Task folder</h3>
            <Label htmlFor="task-path">Task-parent folder path</Label><Input id="task-path" className="fl-focus" value={pathInput} onChange={e => setPathInput(e.target.value)} required pattern="/.*" />
            <p className="text-xs text-muted-foreground">The Cowork root folder. Containers named Tasks, Skills, Memory/Memories and Config/Settings are recognised in any casing; task folders are read from inside the Tasks container (or directly from the root when there is no container).</p>
            <Button size="sm" type="submit" className="fl-focus">Apply folder</Button>
            {layout && <dl className="grid gap-x-4 gap-y-1 border-t pt-2 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt className="font-medium">Resolved root</dt><dd className="break-all">{normalizePath(layout.root.Path) || path} · ID {layout.root.Id}</dd>
              <dt className="font-medium">Containers</dt><dd className="break-all">{containerCount ? Object.entries(layout.containers).filter(([, list]) => list.length).map(([kind, list]) => `${kind}: ${list.map(c => c.Name).join(', ')}`).join(' · ') : 'none found (flat layout)'}</dd>
              <dt className="font-medium">Tasks</dt><dd>{layout.tasks.length} folder{layout.tasks.length === 1 ? '' : 's'}{layout.tasks.length ? ` · ${layout.tasks.filter(t => t.inspected).length} inspected · ${layout.tasks.reduce((n, t) => n + t.inputs, 0)} input files · ${layout.tasks.reduce((n, t) => n + t.outputs, 0)} output files` : ''}</dd>
              <dt className="font-medium">Skills</dt><dd>{layout.containers.skills.length ? `${layout.skills.length} with SKILL.md` : 'no skills folder'}</dd>
              <dt className="font-medium">Memory/config</dt><dd>{layout.containers.memory.length + layout.containers.config.length ? `${layout.memory.length} files` : 'no memory or config folder'}</dd>
              <dt className="font-medium">Last sync</dt><dd>{sync.status.lastSyncedAt ? modified(sync.status.lastSyncedAt) : 'not yet'}{layout.issues.length ? ` · ${layout.issues.length} folder issue${layout.issues.length === 1 ? '' : 's'}` : ''}</dd>
            </dl>}
          </form>
          <div className="fl-card space-y-2 p-4">
            <h3 className="font-semibold">Refresh</h3>
            <Label htmlFor="refresh-interval">Automatic refresh</Label><select id="refresh-interval" className="fl-focus block h-8 rounded-md border bg-card px-2 text-sm" value={interval} onChange={e => setIntervalValue(Number(e.target.value))}><option value="0">Manual only</option><option value="60000">Every minute</option><option value="300000">Every 5 minutes</option><option value="900000">Every 15 minutes</option></select>
            <p className="text-xs text-muted-foreground">Refresh is incremental: it re-reads the root and task listings and inspects only folders whose OneDrive metadata changed. Your view, filters and selection are kept.</p>
          </div>
          <div className="fl-card space-y-2 p-4">
            <h3 className="font-semibold">Cached data</h3>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
              <dt className="font-medium">Where</dt><dd>{mode === 'demo' ? 'Session memory (Demo sample content is never cached in the browser)' : sync.status.cacheKind === 'indexeddb' ? 'This browser (IndexedDB), scoped to the Cowork root folder’s item ID' : 'Session memory only'}</dd>
              <dt className="font-medium">Holds</dt><dd>Folder outline, per-task file metadata (names, IDs, sizes, timestamps, ETags), skill summaries and memory listings. No file contents, links or sign-in data.</dd>
              <dt className="font-medium">Status</dt><dd><SyncStatusSlot status={sync.status} onRetry={refresh} /></dd>
              {sync.status.cacheWarning && <><dt className="font-medium text-[var(--fl-warning)]">Note</dt><dd className="text-[var(--fl-warning)]">{sync.status.cacheWarning}</dd></>}
            </dl>
            <div className="flex min-h-8 flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" className="fl-focus" disabled={!!rescanBusy || !layout || sync.status.phase !== 'idle'} aria-busy={rescanBusy === 'rescan' || undefined} onClick={() => void runFullRescan()}>{rescanBusy === 'rescan' ? <Spinner className="size-3.5" role="presentation" aria-label={undefined} aria-hidden="true" /> : <RefreshCw className="size-3.5" aria-hidden="true" />}Full rescan</Button>
              <Button size="sm" variant="outline" className="fl-focus" disabled={!!rescanBusy || !modeResolved} aria-busy={rescanBusy === 'clear' || undefined} onClick={() => void runClearCache()}>{rescanBusy === 'clear' ? <Spinner className="size-3.5" role="presentation" aria-label={undefined} aria-hidden="true" /> : <Trash2 className="size-3.5" aria-hidden="true" />}Clear cached data</Button>
              <span className="text-xs text-muted-foreground">Full rescan ignores fingerprints and walks every folder (with progress); Clear removes the cache and starts over.</span>
            </div>
          </div>
          <div className="fl-card space-y-2 p-4">
            <h3 className="font-semibold">Companion metadata</h3>
            <p className="truncate text-xs" title={liveLocation}>{liveLocation}{mode === 'demo' ? ' (preferences) · content: Demo sample' : ''}</p>
            <p className="text-xs text-muted-foreground">Schema 2 stores project IDs/names/colors, stable task IDs with assignment, pin, archive and saved URL, and seen-change fingerprints. No source filenames or timestamps are copied. Only this app-owned file is written; reload before using another window.</p>
            {metadataQuery.isPending && <p role="status" className="text-xs">Checking companion settings…</p>}
            {metadataQuery.isError && <ErrorState title="Companion settings could not load" description={metadataQuery.error instanceof Error ? metadataQuery.error.message : undefined} action={<Button size="sm" onClick={() => void metadataQuery.refetch()}>Retry</Button>} className="py-4" />}
            {metadataQuery.data?.nextToken && <p className="text-xs">Keep checking the Documents folder before creating a new settings file.</p>}
            {initialize.isError && <p role="alert" className="text-xs text-destructive">{initialize.error instanceof Error ? initialize.error.message : 'The companion file could not be created.'}</p>}
            <Paging previous={metaPrevious.length > 0} next={!!metadataQuery.data?.nextToken} busy={metadataQuery.isFetching} onPrevious={() => { setMetaToken(metaPrevious.at(-1)); setMetaPrevious(p => p.slice(0, -1)); }} onNext={() => { setMetaPrevious(p => [...p, metaToken]); setMetaToken(metadataQuery.data?.nextToken); }} />
            <div className="flex flex-wrap items-center gap-2">
              {preferencesQuery.data?.absent && !preferencesQuery.data.nextToken && bootstrap.status === 'failed' && !initialize.isPending && <Button size="sm" className="fl-focus" onClick={() => void createMetadata()}>Create settings file</Button>}
              <Button variant="outline" size="sm" className="fl-focus" disabled={save.isPending || initialize.isPending} onClick={() => void metadataQuery.refetch()}>Reload</Button>
              {metadataQuery.data?.document && <span className="fl-badge">Loaded · schema {metadata.schemaVersion} · {metadata.projects.length} projects · {Object.keys(metadata.tasks).length} tasks</span>}
              {save.isSuccess && <span role="status" className="text-xs text-muted-foreground">Last change saved.</span>}
            </div>
          </div>
          <div className="fl-card p-4">
            <h3 className="mb-2 text-xs font-semibold text-muted-foreground">Appearance</h3>
            <div className="flex min-h-10 flex-wrap items-center gap-3">
              <ToggleGroup type="single" value={appearance} onValueChange={value => { if (value === 'system' || value === 'light' || value === 'dark') void setAppearance(value); }} aria-label="Appearance" aria-describedby="appearance-help" className="flex gap-0.5 rounded-md bg-muted p-0.5" disabled={!preferencesQuery.data?.document || pendingKey === 'appearance'}>
                {(['system', 'light', 'dark'] as const).map(value => <ToggleGroupItem key={value} value={value} className="fl-focus h-7 w-20 rounded px-2.5 text-xs font-medium data-[state=on]:bg-card data-[state=on]:text-secondary-foreground data-[state=on]:shadow-[var(--fl-shadow2)]">{appearanceLabels[value]}</ToggleGroupItem>)}
              </ToggleGroup>
              <ActionStatus actionKey="appearance" pendingKey={pendingKey} lastResult={lastResult} size="size-5" />
              <p id="appearance-help" className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title="System follows your device’s light or dark setting and updates live.">System follows your device’s light or dark setting and updates live.</p>
            </div>
            <p className="mt-1 h-4 truncate text-xs text-muted-foreground">{preferencesQuery.data?.document?.preferences?.appearance === undefined ? 'No saved preference yet; System is the default.' : `Saved preference: ${appearanceLabels[appearance]}.`}</p>
          </div>
          <div className="fl-card p-4">
            <h3 className="mb-2 text-xs font-semibold text-muted-foreground">Advanced</h3>
            <div className="flex min-h-10 items-center gap-3">
              <Switch id="demo-mode-switch" className="fl-focus shrink-0" checked={demoMode} disabled={!modeResolved || !preferencesQuery.data?.document || pendingKey === 'demo-mode'} aria-describedby="demo-mode-help" aria-busy={pendingKey === 'demo-mode' || undefined} onCheckedChange={value => { void setDemoMode(value); }} />
              <div className="min-w-0 flex-1">
                <Label htmlFor="demo-mode-switch" className="text-sm font-medium">Demo mode</Label>
                <p id="demo-mode-help" className="truncate text-xs text-muted-foreground" title="Uses built-in sample content and does not read from or write to OneDrive.">Uses built-in sample content and does not read from or write to OneDrive.</p>
              </div>
              <ActionStatus actionKey="demo-mode" pendingKey={pendingKey} lastResult={lastResult} size="size-5" />
            </div>
            <div className="mt-1 flex h-4 min-w-0 items-center gap-2 text-xs">
              {readiness.kind === 'checking' && <p role="status" aria-live="polite" className="truncate text-muted-foreground">Checking saved preference…</p>}
              {readiness.kind === 'creating' && <p role="status" aria-live="polite" className="flex min-w-0 items-center gap-1.5 text-muted-foreground"><Spinner className="size-3 shrink-0" role="presentation" aria-label={undefined} aria-hidden="true" /><span className="truncate">First run: creating {liveLocation}…</span></p>}
              {readiness.kind === 'scan-incomplete' && <p className="truncate text-muted-foreground">Finish checking the Documents folder (Companion metadata, above) before the settings file is created.</p>}
              {readiness.kind === 'ready' && <p className="truncate text-muted-foreground">{readiness.saved ? `Saved preference: Demo mode ${demoMode ? 'on' : 'off'}.` : bootstrap.status === 'created' ? 'Settings file created. No saved preference yet; Demo mode is the default until you change it.' : 'No saved preference yet; Demo mode is the default until you change it.'}</p>}
              {readiness.kind === 'create-failed' && <><p role="alert" className="min-w-0 truncate text-destructive" title={readiness.message}>Couldn’t create {liveLocation}: {readiness.message}</p><Button size="xs" variant="outline" className="fl-focus shrink-0" onClick={retryBootstrap}>Retry</Button></>}
              {readiness.kind === 'load-failed' && <><p role="alert" className="min-w-0 truncate text-destructive" title={readiness.message}>Couldn’t read {liveLocation}: {readiness.message}</p><Button size="xs" variant="outline" className="fl-focus shrink-0" onClick={() => void preferencesQuery.refetch()}>Retry</Button></>}
            </div>
          </div>
        </section>}
      </main>
    </div>
    <ProjectEditor open={projectOpen} project={editingProject} assignCount={editingProject ? 0 : assignAfterCreate.length} busy={!writable || pendingKey === 'create-project'} onClose={closeProjectDialog} onClosed={() => setRestoreTick(n => n + 1)} onSave={project => { void createProject(project, editingProject ? undefined : assignAfterCreate).then(ok => { if (ok) { closeProjectDialog(); setAssignAfterCreate([]); } }); }} />
    <Dialog open={!!selected} onOpenChange={open => { if (!open) setSelected(undefined); }}><DialogContent className="max-h-[90dvh] min-w-0 overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle className="break-words pr-6">{selected?.item.Name ?? 'Item details'}</DialogTitle><DialogDescription className="break-all">{selected?.item.Path ?? 'Path not provided'}</DialogDescription></DialogHeader>{selected && <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span title={modified(selected.item.LastModified)}>{ago(selected.item.LastModified)}</span><span>·</span><span className="break-all">ID {selected.item.Id}</span><RecentState item={selected.item} metadata={metadata} changes={changes} verbose />{changes.isUnseen(selected.item, metadata) && <Button size="xs" variant="outline" className="fl-focus" disabled={!writable} onClick={() => markSeen(selected.item)}><Check className="size-3" aria-hidden="true" />Mark seen</Button>}</div>
      {selected.kind === 'skill' && <SkillExploration folder={selected.item} repository={repositories.skills} files={repositories.tasks} scopeKey={scopeKey} />}
      {selected.item.IsFolder ? <FileExplorer key={selected.item.Id} root={selected.item} repository={repositories.tasks} links={fileLinks} scopeKey={scopeKey} metadata={metadata} changes={changes} observe={observe} markSeen={markSeen} writable={writable} /> : <TextReader item={selected.item} repositories={repositories} links={fileLinks} scopeKey={scopeKey} memory={selected.kind === 'memory'} />}
    </div>}</DialogContent></Dialog>
  </div>;
}

/** One-line, fixed-height status for a lazily discovered section (Skills / Memory): cached · loading · ready · error+Retry. */
function SectionSyncLine({ state, error, syncedAt, noun, onRetry }: { state: 'idle' | 'cached' | 'loading' | 'ready' | 'error'; error?: string; syncedAt?: string; noun: string; onRetry: () => void }) {
  const text = state === 'loading' ? `Reading ${noun} from OneDrive…` : state === 'cached' ? `Showing cached ${noun}` : state === 'error' ? `Couldn’t read ${noun}${error ? ` · ${error}` : ''}` : state === 'ready' ? `${noun.charAt(0).toUpperCase()}${noun.slice(1)} checked ${agoShort(syncedAt) ?? 'just now'}` : '';
  return <div className="flex h-5 min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
    {state === 'loading' && <Spinner className="size-3 shrink-0" role="presentation" aria-label={undefined} aria-hidden="true" />}
    <span role="status" aria-live="polite" className={`truncate ${state === 'error' ? 'text-destructive' : ''}`}>{text}</span>
    {(state === 'error' || state === 'cached') && <Button size="xs" variant="outline" className="fl-focus h-5 shrink-0 px-1.5" onClick={onRetry}>{state === 'error' ? 'Retry' : 'Check for changes'}</Button>}
  </div>;
}

// Module-level (not nested in HomePage) so React keeps row DOM nodes across HomePage re-renders — focus and selection stay put.
function TaskRow({ item, summary, metadata, changes, session, selected, onToggleSelection, onCreateProject, rememberScroll }: {
  item: DriveItem; summary?: TaskSummary; metadata: CompanionMetadata; changes: ChangeDetectionService; session: CompanionSession; selected: boolean;
  onToggleSelection: (id: string) => void; onCreateProject: (ids: string[], origin: FocusOrigin<HTMLElement>) => void; rememberScroll: () => void;
}) {
    const { writable, update, confirmArchive } = session;
    const prefs = metadata.tasks[item.Id] ?? {};
    const inputs = summary?.inputs ?? 0;
    const outputs = summary?.outputs ?? 0;
    const files = summary?.files.length ?? 0;
    const newOutput = summary?.newestOutput && isRecent(summary.newestOutput.LastModified, 24);
    // Only the task name and the chevron navigate; checkbox, pin, project pill and archive are siblings of the link.
    return <li className={`fl-row grid h-[52px] grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-x-1.5 px-2 sm:grid-cols-[auto_auto_minmax(0,1fr)_minmax(0,11rem)_minmax(0,8rem)_minmax(0,9rem)_auto] ${selected ? 'bg-[var(--fl-brand-tint)]/40' : ''}`} data-task-id={item.Id}>
      <Checkbox className="fl-focus" checked={selected} onCheckedChange={() => onToggleSelection(item.Id)} aria-label={`${selected ? 'Deselect' : 'Select'} ${item.Name ?? 'task'}`} />
      <Button variant="ghost" size="icon-sm" className="fl-focus" disabled={!writable} aria-label={`${prefs.pinned ? 'Unpin' : 'Pin'} ${item.Name ?? 'task'}`} aria-pressed={!!prefs.pinned} onClick={() => update(item.Id, { pinned: !prefs.pinned })}><Pin className={prefs.pinned ? 'size-4 fill-primary text-primary' : 'size-4 text-muted-foreground'} aria-hidden="true" /></Button>
      <span className="min-w-0">
        <a href={taskHash(item.Id)} className="fl-focus flex min-w-0 items-center gap-2 rounded text-left" title={item.Name ?? item.Id} onClick={rememberScroll}><span className="truncate font-semibold text-foreground">{item.Name ?? item.Id}</span><RecentState item={item} metadata={metadata} changes={changes} />{newOutput && <span className="fl-badge fl-badge-brand">New output</span>}</a>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground sm:hidden"><ProjectPill taskIds={[item.Id]} actionKey={`row:${item.Id}`} focusKey={pillFocusKey('row', item.Id)} metadata={metadata} session={session} onCreate={onCreateProject} /><span className="truncate">{ago(item.LastModified)}</span></span>
      </span>
      <span className="hidden sm:block"><ProjectPill taskIds={[item.Id]} actionKey={`row:${item.Id}`} focusKey={pillFocusKey('row', item.Id)} metadata={metadata} session={session} onCreate={onCreateProject} /></span>
      <span className="hidden truncate text-xs text-muted-foreground sm:block" title={modified(item.LastModified)}>{ago(item.LastModified)}</span>
      <span className="hidden min-w-0 items-center gap-1.5 text-xs sm:flex"><FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />{!summary?.inspected ? <span className="truncate text-muted-foreground" aria-busy="true" title="This task folder’s input/output counts are read in the background">Inspecting…</span> : summary.roleFolders.length ? <span className="truncate" title={`${files} files · ${inputs} inputs · ${outputs} outputs${summary.partial ? ' · partial' : ''}`}><span className="font-medium">{files}</span><span className="text-muted-foreground"> · {inputs} in · {outputs} out{summary.partial ? ' · partial' : ''}</span></span> : <span className="truncate text-muted-foreground" title={files ? `${files} files, no input/output folders` : 'Empty folder'}>{files ? `${files} file${files === 1 ? '' : 's'}` : 'Empty'}</span>}</span>
      <span className="flex items-center gap-0.5">
        <Button variant="ghost" size="icon-sm" className="fl-focus" disabled={!writable} aria-label={`${prefs.archived ? 'Restore' : 'Archive'} ${item.Name ?? 'task'}`} {...{ 'data-focus-return-key': `archive:row:${item.Id}` }} onClick={e => { if (prefs.archived) update(item.Id, { archived: false }); else void confirmArchive(item.Id, { node: e.currentTarget, key: `archive:row:${item.Id}` }); }}><Archive className="size-4 text-muted-foreground" aria-hidden="true" /></Button>
        <Button asChild variant="ghost" size="icon-sm" className="fl-focus"><a href={taskHash(item.Id)} aria-label={`Open task page for ${item.Name ?? 'task'}`} onClick={rememberScroll}><ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" /></a></Button>
      </span>
    </li>;
  }

function QuickOpenFolder({ item, links }: { item: DriveItem; links: FileLinkService }) {
  useFileLinks(links, [item]);
  return <div className="fl-row flex items-center gap-2 px-1.5 py-1.5"><span className="grid size-7 shrink-0 place-items-center rounded-md bg-secondary text-secondary-foreground"><FolderOpen className="size-4" aria-hidden="true" /></span><span className="min-w-0 flex-1"><span className="block truncate font-medium"><FileLink item={item} links={links} className="font-medium" /></span><span className="block text-xs text-muted-foreground">OneDrive Cowork root folder</span></span></div>;
}


function Paging({ previous, next, busy, onPrevious, onNext, labels = ['Previous page', 'Load more'] }: { previous: boolean; next: boolean; busy: boolean; onPrevious: () => void; onNext: () => void; labels?: [string, string] }) {
  if (!previous && !next) return null;
  return <div className="flex flex-wrap gap-2 pt-1">{previous && <Button size="xs" variant="outline" className="fl-focus" disabled={busy} onClick={onPrevious}>{labels[0]}</Button>}{next && <Button size="xs" variant="outline" className="fl-focus" disabled={busy} onClick={onNext}>{labels[1]}</Button>}</div>;
}
function ProjectEditor({ open, project, busy, assignCount = 0, onClose, onClosed, onSave }: { open: boolean; project?: Project; busy: boolean; assignCount?: number; onClose: () => void; onClosed: () => void; onSave: (project: Project) => void }) {
  // onCloseAutoFocus runs for Escape, the Close button, Cancel and a successful save alike: restore focus explicitly
  // to the originating control instead of Radix's default (which would be <body> after a menu-driven open).
  return <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }}><DialogContent onCloseAutoFocus={e => { e.preventDefault(); onClosed(); }}><DialogHeader><DialogTitle>{project ? 'Edit virtual project' : 'New virtual project'}</DialogTitle><DialogDescription>{assignCount > 0 ? `The new project will be assigned to ${assignCount} selected task${assignCount === 1 ? '' : 's'}. ` : ''}Projects organize companion metadata only. Cowork folders are not changed.</DialogDescription></DialogHeader><form key={project?.id ?? String(open)} className="space-y-3" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); const name = String(data.get('name') ?? '').trim(); const color = projectColors.find(c => c === data.get('color')); if (name && color) onSave({ id: project?.id ?? crypto.randomUUID(), name, color }); }}><Label htmlFor="project-name">Project name</Label><Input id="project-name" name="name" defaultValue={project?.name} required maxLength={160} /><fieldset className="space-y-1"><legend className="text-sm font-medium">Color</legend><div className="flex flex-wrap gap-2">{projectColors.map(c => <label key={c} className="fl-focus flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs has-[:checked]:border-primary has-[:checked]:bg-secondary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"><input type="radio" name="color" value={c} defaultChecked={(project?.color ?? 'blue') === c} className="sr-only" /><span aria-hidden="true" className={`size-3 rounded-full ${colorClass[c]}`} />{colorLabel[c]}</label>)}</div></fieldset><div className="flex min-w-0 justify-end gap-2 pt-1"><Button type="button" variant="outline" className="fl-focus min-w-0 flex-1 justify-center sm:flex-none sm:w-24" onClick={onClose}>Cancel</Button><Button type="submit" className="fl-focus min-w-0 flex-1 justify-center sm:flex-none sm:w-44" disabled={busy} aria-busy={busy || undefined}>{busy ? <Spinner className="size-4" role="presentation" aria-label={undefined} aria-hidden="true" /> : assignCount > 0 ? `Create and assign ${assignCount}` : project ? 'Save project' : 'Create project'}</Button></div></form></DialogContent></Dialog>;
}
function SkillRow({ skill, metadata, changes, onOpen }: { skill: SkillSummary; metadata: CompanionMetadata; changes: ChangeDetectionService; onOpen: () => void }) {
  const item = skill.definition ?? skill.folder;
  return <li className="fl-row grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2"><BookOpen className="size-4 text-muted-foreground" aria-hidden="true" /><button className="fl-focus min-w-0 rounded text-left" title={skill.folder.Name} aria-label={`Open skill ${skill.folder.Name}`} onClick={onOpen}><span className="flex items-center gap-2"><span className="truncate font-semibold">{skill.folder.Name}</span><RecentState item={item} metadata={metadata} changes={changes} /></span><span className="block truncate text-xs">{skill.summary}</span><span className="block truncate text-xs text-muted-foreground" title={modified(item.LastModified)}>{ago(item.LastModified)} · {skill.files.length} file{skill.files.length === 1 ? '' : 's'}{skill.partial ? ' (partial)' : ''} · {normalizePath(skill.folder.Path) || skill.folder.Name}</span></button><ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" /></li>;
}
function TextReader({ item, repositories, links, scopeKey, memory }: { item: DriveItem; repositories: CompanionRepositories; links: FileLinkService; scopeKey: string; memory: boolean }) {
  useFileLinks(links, [item]);
  const query = useQuery({ queryKey: ['cowork', scopeKey, 'text', item.Id, item.ETag, item.LastModified], queryFn: () => memory ? repositories.memory.read(item) : repositories.tasks.read(item), retry: false });
  return <section className="min-w-0 space-y-2" aria-label="File contents"><h3 className="flex items-center gap-2 font-semibold">File contents · <FileLink item={item} links={links} className="text-sm font-medium" /></h3>{query.isPending && <p role="status">Reading text…</p>}{query.isError && <ErrorState title="Text preview unavailable" description={query.error instanceof Error ? query.error.message : undefined} action={<Button onClick={() => void query.refetch()}>Retry preview</Button>} className="py-4" />}{query.isSuccess && <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted p-3 text-xs [overflow-wrap:anywhere]">{query.data}</pre>}</section>;
}
function SkillExploration({ folder, repository, files, scopeKey }: { folder: DriveItem; repository: SkillsRepository; files: CompanionRepositories['tasks']; scopeKey: string }) {
  const [action, setAction] = useState('inspect');
  const [before, setBefore] = useState('');
  const query = useQuery({ queryKey: ['cowork', scopeKey, 'skill-detail', folder.Id], queryFn: () => repository.inspect(folder), retry: false });
  const definition = query.data?.definition;
  const text = useQuery({ queryKey: ['cowork', scopeKey, 'text', definition?.Id, definition?.ETag, definition?.LastModified], queryFn: () => { if (!definition) throw new Error('SKILL.md is not loaded.'); return files.read(definition); }, enabled: !!definition, retry: false });
  let difference: ReturnType<typeof compareText> = [];
  let compareError = '';
  if (action === 'compare' && before && text.data !== undefined) { try { difference = compareText(before, text.data); } catch (error) { compareError = error instanceof Error ? error.message : 'Compare unavailable.'; } }
  return <section aria-label="Skill version exploration" className="fl-card space-y-2 p-3"><h3 className="font-semibold">Skill exploration</h3><div className="flex flex-wrap gap-1" role="group" aria-label="Skill exploration actions">{['inspect', 'history', 'compare', 'restore', 'deactivate', 'reactivate', 'duplicate'].map(value => <Button size="sm" variant={action === value ? 'secondary' : 'outline'} aria-pressed={action === value} className="h-auto whitespace-normal capitalize" key={value} onClick={() => setAction(value)}>{value === 'history' ? 'Version history' : value}</Button>)}</div>
    {action === 'inspect' && <><p className="text-xs">Current SKILL.md only. Version ID is not supplied by the connector.</p>{text.isPending && definition && <p role="status">Reading definition…</p>}{text.isError && <p role="alert">Unable to read the current skill definition.</p>}{text.isSuccess && <pre className="whitespace-pre-wrap break-words text-xs [overflow-wrap:anywhere]">{text.data}</pre>}{query.isError && <Button size="sm" onClick={() => void query.refetch()}>Retry definition</Button>}</>}
    {action === 'compare' && <><Label htmlFor="previous-definition">Previous definition supplied by you</Label><Textarea id="previous-definition" value={before} maxLength={256000} onChange={e => setBefore(e.target.value)} className="min-h-24" /><p className="text-xs">Line-by-line comparison with current SKILL.md; not a fetched historical version. No files are changed.</p>{compareError && <p role="alert">{compareError}</p>}{before && text.isSuccess && !difference.length && <p role="status">No line differences.</p>}<ul className="space-y-2 text-xs">{difference.slice(0, 100).map(row => <li key={row.line} className="break-words rounded border bg-card p-2"><p className="font-medium">Line {row.line}</p><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">Previous: {row.before || '(empty)'}</p><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">Current: {row.after || '(empty)'}</p></li>)}</ul>{difference.length > 100 && <p role="alert">More than 100 changed lines. Narrow the supplied text for a full visible comparison.</p>}</>}
    {action === 'history' && <p className="text-xs">{repository.versions.reason}</p>}
    {action === 'restore' && <p className="text-xs">Restore exploration: inspect the current definition, compare an independently obtained prior version, then use the owning file system for any approved restore. No restore is performed here: the bound client exposes no version-restore operation.</p>}
    {['deactivate', 'reactivate', 'duplicate'].includes(action) && <p className="text-xs">{action === 'duplicate' ? 'Duplicate exploration requires known Cowork folder and skill-identity rules.' : `${action} exploration requires documented Cowork activation semantics.`} These semantics are not exposed. This control is a read-only extension point; it never edits, copies, moves, or deletes a skill.</p>}
  </section>;
}

