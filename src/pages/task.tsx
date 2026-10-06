import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Archive, ArrowLeft, Check, ChevronDown, ChevronRight, FileOutput, Folder, FolderOpen, List, ListTree, Pin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { CoworkLinkCommands, ProjectPill } from '@/components/cowork-assign';
import { useFileLinks } from '@/components/cowork-file-link';
import { EmptyState, ErrorState } from '@/components/states';
import { ago, isRecent, modified } from '@/components/cowork-file-explorer';
import { FileRow } from '@/components/cowork-open-file';
import { FileListSkeleton, TaskPageSkeleton } from '@/components/cowork-skeletons';
import { useCompanion } from '@/lib/companion-session';
import { pillFocusKey, type FocusOrigin } from '@/lib/focus-return';
import { classifyFolder, type DriveItem, type Project } from '@/lib/cowork-domain';
import { normalizePath } from '@/lib/cowork-discovery';
import { sectionHash, sectionLabels, type Section } from '@/lib/cowork-hash-routes';
import { allFolderIds, buildRoleTree, fileType, flattenRoleFiles, isTextPreviewable, partitionTaskFiles, type OutputsView, type TreeFolderNode } from '@/lib/cowork-workspace';

const colorClass = { green: 'bg-[#0E700E]', blue: 'bg-[#0F6CBD]', amber: 'bg-[#BC4B09]', rose: 'bg-[#C50F1F]', purple: 'bg-[#8764B8]' };
function ProjectDot({ project }: { project?: Project }) { return <span aria-hidden="true" className={`inline-block size-2 shrink-0 rounded-full ${project ? colorClass[project.color] : 'border border-input'}`} />; }

export function TaskPage({ taskId, listSection, onBack, hasHistory, onCreateProject }: { taskId: string; listSection: Section; onBack: () => void; hasHistory: boolean; onCreateProject: (assignTo: string[], origin: FocusOrigin<HTMLElement>) => void }) {
  const session = useCompanion();
  const { repositories, scopeKey, metadata, writable, update, markSeen, markAllSeen, layout, layoutQuery, summaryById, changes, mode, setList, outputsView, setOutputsView, expanded, toggleFolder, setExpanded, fileLinks, confirmArchive } = session;
  const summary = summaryById.get(taskId);
  const task = summary?.folder;
  const prefs = metadata.tasks[taskId] ?? {};
  const project = metadata.projects.find(p => p.id === prefs.projectId);
  const [preview, setPreview] = useState<DriveItem>();
  // Opening a task is a priority-0 hydration in the sync engine: the task folder and its role folders are validated at the nearest
  // boundary (unchanged leaf folders reused by fingerprint), deduplicated with any queued work, ≤3 connector calls in flight.
  const { sync } = session;
  useEffect(() => { if (task) void sync.hydrateTask(taskId); }, [sync, taskId, task]);
  const taskIssues = useMemo(() => (layout?.issues ?? []).filter(i => task && normalizePath(i.path).toLowerCase().startsWith(normalizePath(task.Path).toLowerCase())), [layout, task]);
  const inspecting = !!task && !summary?.inspected && taskIssues.length === 0;
  const taskError = !!task && !summary?.inspected && taskIssues.find(i => i.scope === 'task');
  const source = summary?.inspected ? summary : undefined;
  const files = partitionTaskFiles(source);
  useFileLinks(fileLinks, (source?.files ?? []).map(f => f.item));
  const outputTree = buildRoleTree(source?.files ?? [], source?.folders ?? [], 'output');
  const outputFlat = flattenRoleFiles(source?.files ?? [], 'output');
  const previewQuery = useQuery({ queryKey: ['cowork', scopeKey, 'text', preview?.Id, preview?.ETag, preview?.LastModified], enabled: !!preview, retry: false, queryFn: () => { if (!preview) throw new Error('Choose a file.'); return repositories.tasks.read(preview); } });
  const unseenOutputs = files.outputs.filter(o => changes.isUnseen(o, metadata));
  const newOutputs = files.outputs.filter(o => isRecent(o.LastModified, 24));
  const backLabel = sectionLabels[listSection];

  if (layoutQuery.isPending) return <TaskPageSkeleton />;
  if (layoutQuery.isError) return <div className="mx-auto w-full max-w-[1100px]"><ErrorState title="Couldn’t read the Cowork folder" description={layoutQuery.error instanceof Error ? layoutQuery.error.message : undefined} action={<Button asChild size="sm"><a href={sectionHash('tasks')}>Back to Tasks</a></Button>} className="fl-card py-8" /></div>;
  if (!task) return <div className="mx-auto w-full max-w-[1100px]"><EmptyState title="Task not found" description="This task folder is not in the last OneDrive read. It may have been moved or renamed, the link may be out of date, or the folder scope may have changed." action={<div className="flex flex-wrap justify-center gap-2"><Button asChild size="sm"><a href={sectionHash('tasks')}><ArrowLeft className="size-4" aria-hidden="true" />Back to Tasks</a></Button>{hasHistory && <Button size="sm" variant="outline" onClick={onBack}>Previous page</Button>}</div>} className="fl-card py-10" /></div>;

  const renderRow = (entry: { item: DriveItem; depth?: number; relativeDir?: string }) => <FileRow key={entry.item.Id} item={entry.item} depth={entry.depth} relativeDir={entry.relativeDir} links={fileLinks} metadata={metadata} changes={changes} writable={writable} onMarkSeen={markSeen} onPreview={isTextPreviewable(entry.item.Name) ? setPreview : undefined} primary />;

  return <div className="mx-auto w-full min-w-0 max-w-[1100px] space-y-3">
    <nav aria-label="Breadcrumb" className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
      <Button variant="ghost" size="xs" className="fl-focus -ml-1 shrink-0" onClick={onBack} aria-label={hasHistory ? 'Back to the previous page' : 'Back to Tasks'}><ArrowLeft className="size-3.5" aria-hidden="true" />Back</Button>
      <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
      <a href={sectionHash(listSection)} className="fl-focus shrink-0 rounded hover:underline">{backLabel}</a>
      {project && <><ChevronRight className="size-3 shrink-0" aria-hidden="true" /><a href={sectionHash('tasks')} className="fl-focus flex min-w-0 max-w-[40%] items-center gap-1 rounded hover:underline" onClick={() => setList({ projectFilter: project.id })}><ProjectDot project={project} /><span className="truncate">{project.name}</span></a></>}
      <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
      <span aria-current="page" className="min-w-0 flex-1 truncate font-medium text-foreground" title={task.Name}>{task.Name}</span>
    </nav>
    <header className="fl-card min-w-0 p-3">
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <h1 className="flex min-w-0 flex-wrap items-center gap-2 text-lg font-semibold tracking-tight"><span className="break-words">{task.Name}</span>{prefs.pinned && <Pin className="size-4 fill-primary text-primary" aria-label="Pinned" />}{prefs.archived && <span className="fl-badge">Archived</span>}{mode === 'demo' && <span className="fl-badge fl-badge-warning">Demo sample</span>}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"><ProjectPill taskIds={[taskId]} actionKey={`header:${taskId}`} focusKey={pillFocusKey('header', taskId)} metadata={metadata} session={session} onCreate={onCreateProject} /><span title={modified(task.LastModified)}>Folder {ago(task.LastModified).toLowerCase()}</span><span className="hidden sm:inline">·</span><span className="hidden truncate sm:inline" title={normalizePath(task.Path)}>{normalizePath(task.Path)}</span></p>
        </div>
        <div className="flex w-full min-w-0 items-center gap-1 sm:w-auto">
          <Button size="sm" variant={prefs.pinned ? 'secondary' : 'outline'} className="fl-focus min-w-0 flex-1 justify-center sm:flex-none sm:w-24" disabled={!writable} aria-pressed={!!prefs.pinned} onClick={() => update(taskId, { pinned: !prefs.pinned })}><Pin className={`size-4 ${prefs.pinned ? 'fill-primary text-primary' : ''}`} aria-hidden="true" /><span className="truncate">{prefs.pinned ? 'Pinned' : 'Pin'}</span></Button>
          <Button size="sm" variant="outline" className="fl-focus min-w-0 flex-1 justify-center sm:flex-none sm:w-24" disabled={!writable} aria-pressed={!!prefs.archived} {...{ 'data-focus-return-key': `archive:header:${taskId}` }} onClick={e => { if (prefs.archived) update(taskId, { archived: false }); else void confirmArchive(taskId, { node: e.currentTarget, key: `archive:header:${taskId}` }); }}><Archive className="size-4" aria-hidden="true" /><span className="truncate">{prefs.archived ? 'Restore' : 'Archive'}</span></Button>
          <CoworkLinkCommands key={taskId} taskId={taskId} metadata={metadata} session={session} />
        </div>
      </div>
    </header>

    <section aria-labelledby="outputs-heading" className="space-y-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-1">
        <h2 id="outputs-heading" className="flex items-center gap-1.5 text-base font-semibold"><FileOutput className="size-4 text-primary" aria-hidden="true" />Outputs</h2>
        <span className="min-w-0 text-xs text-muted-foreground">{files.outputs.length} file{files.outputs.length === 1 ? '' : 's'}{outputTree.folders.length ? ` · ${allFolderIds(outputTree).length} sub-folder${allFolderIds(outputTree).length === 1 ? '' : 's'}` : ''}{files.latestOutput ? ` · last output ${ago(files.latestOutput.LastModified).toLowerCase()} (${files.latestOutput.Name})` : ''}{summary?.partial ? ' · partial' : ''}</span>
        {newOutputs.length > 0 && <span className="fl-badge fl-badge-brand">{newOutputs.length} in the last 24h</span>}
        <span className="ml-auto flex min-w-0 items-center gap-1">
          {unseenOutputs.length > 0 && <Button size="xs" variant="ghost" className="fl-focus" disabled={!writable} onClick={() => markAllSeen(unseenOutputs)}><Check className="size-3" aria-hidden="true" />Mark {unseenOutputs.length} seen</Button>}
          <ViewToggle view={outputsView} onChange={setOutputsView} />
        </span>
      </div>
      {taskError && <ErrorState title="Couldn’t read this task’s files" description={taskError.message} action={<Button size="sm" onClick={() => void sync.hydrateTask(taskId)}>Retry</Button>} className="fl-card py-6" />}
      {inspecting && <FileListSkeleton rows={3} label="Inspecting this task’s folders in OneDrive" />}
      {source && <div className="fl-card overflow-hidden">
        {files.outputs.length === 0 ? <div className="flex min-h-11 items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><FileOutput className="size-4 shrink-0" aria-hidden="true" /><span><span className="font-medium text-foreground">No outputs yet.</span> {summary?.roleFolders.some(f => classifyFolder(f.Name) === 'output') ? (outputTree.folders.length ? `The output folder has ${allFolderIds(outputTree).length} sub-folder${allFolderIds(outputTree).length === 1 ? '' : 's'} but no files in the last OneDrive read.` : 'The output folder exists but holds no files in the last OneDrive read.') : 'No output folder is present in this task folder yet; files written there will appear here, newest first.'}</span></div>
          : outputsView === 'flat'
            ? <ul className="divide-y" aria-label="Output files, newest first, with their folder path">{outputFlat.map(entry => renderRow({ item: entry.item, relativeDir: entry.relativeDir }))}</ul>
            : <TreeView root={outputTree} expanded={expanded} onToggle={toggleFolder} onExpandAll={() => setExpanded(allFolderIds(outputTree))} onCollapseAll={() => setExpanded([])} render={renderRow} />}
      </div>}
    </section>

    <section aria-labelledby="inputs-heading" className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 px-1"><h2 id="inputs-heading" className="text-sm font-semibold text-muted-foreground">Inputs</h2><span className="text-xs text-muted-foreground">{files.inputs.length} file{files.inputs.length === 1 ? '' : 's'}</span></div>
      {inspecting && <FileListSkeleton rows={2} />}
      {source && <div className="fl-card overflow-hidden">{files.inputs.length === 0 ? <p className="p-3 text-xs text-muted-foreground">No “input” or “inputs” folder files in this task.</p> : <ul className="divide-y">{flattenRoleFiles(source.files, 'input').map(entry => <FileRow key={entry.item.Id} item={entry.item} relativeDir={entry.relativeDir} links={fileLinks} metadata={metadata} changes={changes} writable={writable} onMarkSeen={markSeen} onPreview={isTextPreviewable(entry.item.Name) ? setPreview : undefined} />)}</ul>}</div>}
    </section>

    {files.other.length > 0 && <section aria-labelledby="other-heading" className="space-y-1">
      <div className="flex items-center gap-2 px-1"><h2 id="other-heading" className="text-sm font-semibold text-muted-foreground">Other files in the task folder</h2><span className="text-xs text-muted-foreground">{files.other.length}</span></div>
      <div className="fl-card overflow-hidden"><ul className="divide-y">{files.other.map(item => <FileRow key={item.Id} item={item} links={fileLinks} metadata={metadata} changes={changes} writable={writable} onMarkSeen={markSeen} onPreview={isTextPreviewable(item.Name) ? setPreview : undefined} />)}</ul></div>
    </section>}

    {preview && <section aria-labelledby="preview-heading" className="fl-card p-3" aria-busy={previewQuery.isPending || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="preview-heading" className="truncate text-sm font-semibold">{preview.Name} <span className="font-normal text-muted-foreground">· {fileType(preview)} · text preview</span></h2><Button size="xs" variant="outline" className="fl-focus" onClick={() => setPreview(undefined)}>Close preview</Button></div>
      {previewQuery.isPending && <p role="status" aria-live="polite" className="mt-2 text-xs">Reading text…</p>}
      {previewQuery.isError && <p role="alert" className="mt-2 text-xs text-destructive">{previewQuery.error instanceof Error ? previewQuery.error.message : 'Unable to preview this file.'}</p>}
      {previewQuery.isSuccess && <pre className="mt-2 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted p-3 text-xs [overflow-wrap:anywhere]">{previewQuery.data}</pre>}
    </section>}
    {source?.stale && <p role="status" className="text-xs text-muted-foreground">Showing the last inspected file list · checking this folder for changes…</p>}
    {taskIssues.length > 0 && !taskError && <p className="text-xs text-[var(--fl-warning)]">{taskIssues.map(i => `${i.path} — ${i.message}`).join(' · ')}</p>}
  </div>;
}

function ViewToggle({ view, onChange }: { view: OutputsView; onChange: (view: OutputsView) => void }) {
  // Exclusive choice → single-select toggle group (radio semantics), remembered for the session.
  return <ToggleGroup type="single" value={view} onValueChange={value => { if (value === 'tree' || value === 'flat') onChange(value); }} aria-label="Outputs view" className="flex items-center gap-1 rounded-md bg-muted p-0.5 text-xs">
    {([['tree', 'Tree', ListTree], ['flat', 'Flat', List]] as const).map(([value, label, Icon]) => <ToggleGroupItem key={value} value={value} aria-label={`${label} view of outputs`} className="fl-focus h-6 gap-1 rounded px-2 text-xs font-medium data-[state=on]:bg-card data-[state=on]:text-secondary-foreground data-[state=on]:shadow-[var(--fl-shadow2)]"><Icon className="size-3.5" aria-hidden="true" />{label}</ToggleGroupItem>)}
  </ToggleGroup>;
}

// Accessible tree: each folder is a treeitem with aria-expanded; files use the same FileRow (and actions) as the flat view.
function TreeView({ root, expanded, onToggle, onExpandAll, onCollapseAll, render }: { root: TreeFolderNode; expanded: ReadonlySet<string>; onToggle: (id: string) => void; onExpandAll: () => void; onCollapseAll: () => void; render: (entry: { item: DriveItem; depth: number }) => React.ReactNode }) {
  const count = allFolderIds(root).length;
  return <div>
    {count > 0 && <div className="flex items-center gap-2 border-b px-2 py-1 text-xs text-muted-foreground"><Folder className="size-3.5" aria-hidden="true" />{count} sub-folder{count === 1 ? '' : 's'}<span className="ml-auto flex gap-1"><button type="button" className="fl-focus rounded px-1 hover:underline" onClick={onExpandAll}>Expand all</button><button type="button" className="fl-focus rounded px-1 hover:underline" onClick={onCollapseAll}>Collapse all</button></span></div>}
    <ul role="tree" aria-label="Output folders and files" className="divide-y">
      {root.files.map(entry => render({ item: entry.item, depth: 0 }))}
      {root.folders.map(folder => <TreeFolder key={folder.id} node={folder} depth={0} expanded={expanded} onToggle={onToggle} render={render} />)}
    </ul>
  </div>;
}
function TreeFolder({ node, depth, expanded, onToggle, render }: { node: TreeFolderNode; depth: number; expanded: ReadonlySet<string>; onToggle: (id: string) => void; render: (entry: { item: DriveItem; depth: number }) => React.ReactNode }) {
  const open = expanded.has(node.id);
  return <>
    <li role="treeitem" aria-expanded={open} aria-level={depth + 1} className="fl-row px-2 py-1.5" style={{ paddingLeft: `${8 + depth * 18}px` }} data-folder-id={node.id}>
      <button type="button" className="fl-focus flex w-full min-w-0 items-center gap-2 rounded text-left" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} folder ${node.name}, ${node.fileCount} file${node.fileCount === 1 ? '' : 's'}`} onClick={() => onToggle(node.id)}>
        {open ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        {open ? <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        <span className="truncate text-sm font-medium">{node.name}</span>
        <span className="fl-badge">{node.fileCount}</span>
        {node.newestModified && <span className="ml-auto hidden truncate text-xs text-muted-foreground sm:block" title={modified(node.newestModified)}>{ago(node.newestModified)}</span>}
      </button>
    </li>
    {open && <li role="none"><ul role="group" className="divide-y border-t">
      {node.files.map(entry => render({ item: entry.item, depth: depth + 1 }))}
      {node.folders.map(child => <TreeFolder key={child.id} node={child} depth={depth + 1} expanded={expanded} onToggle={onToggle} render={render} />)}
    </ul></li>}
  </>;
}
