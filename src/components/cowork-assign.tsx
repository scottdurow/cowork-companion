import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Check, ChevronDown, ClipboardPaste, ExternalLink, Link2, Pencil, Plus, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { safeUrl } from '@/lib/safe-url';
import type { CompanionMetadata, Project } from '@/lib/cowork-domain';
import { coworkUrlMessages, validateCoworkTaskUrl } from '@/lib/cowork-assignment';
import type { CompanionSession } from '@/lib/companion-session';
import { FOCUS_RETURN_ATTR, FocusReturn, resolveFocusKey, type FocusOrigin } from '@/lib/focus-return';

export const colorClass = { green: 'bg-[#0E700E]', blue: 'bg-[#0F6CBD]', amber: 'bg-[#BC4B09]', rose: 'bg-[#C50F1F]', purple: 'bg-[#8764B8]' };
export function ProjectDot({ project, className = '' }: { project?: Project; className?: string }) { return <span aria-hidden="true" className={`inline-block size-2 shrink-0 rounded-full ${project ? colorClass[project.color] : 'border border-input bg-transparent'} ${className}`} />; }

/**
 * Fixed-geometry status: a reserved slot (never a new row) that shows nothing / spinner / ✓ / ! for one action key.
 * `height` must match the control it sits beside so saving never moves surrounding layout.
 */
export function ActionStatus({ actionKey, pendingKey, lastResult, size = 'size-4', children }: { actionKey: string; pendingKey?: string; lastResult?: CompanionSession['lastResult']; size?: string; children?: ReactNode }) {
  const pending = pendingKey === actionKey;
  const result = lastResult?.key === actionKey ? lastResult : undefined;
  return <span className={`inline-flex ${size} shrink-0 items-center justify-center`} aria-live="polite">
    {pending && <Spinner className="size-3.5" role="presentation" aria-label={undefined} aria-hidden="true" />}
    {!pending && result?.status === 'success' && <Check className="size-3.5 text-[var(--fl-success)]" aria-hidden="true" />}
    {!pending && result?.status === 'error' && <AlertCircle className="size-3.5 text-destructive" aria-label={result.message ?? 'Save failed'} />}
    {!pending && !result && children}
    <span className="sr-only">{pending ? 'Saving' : result?.status === 'success' ? 'Saved' : result?.status === 'error' ? `Save failed: ${result.message ?? ''}` : ''}</span>
  </span>;
}

/** Project pill + keyboard-accessible menu (Unassigned · projects · Create new project). Never navigates. */
export function ProjectPill({ taskIds, actionKey, focusKey, metadata, session, onCreate, size = 'xs', className = '', label }: {
  taskIds: string[]; actionKey: string; /** Stable focus identity (pillFocusKey) that survives the trigger node being replaced by a re-render. */ focusKey: string; metadata: CompanionMetadata; session: Pick<CompanionSession, 'confirmAssign' | 'pendingKey' | 'lastResult' | 'writable'>;
  /** Called with the selected task IDs and the pill origin (node + stable key) so the dialog can return focus to it. */
  onCreate: (assignTo: string[], origin: FocusOrigin<HTMLElement>) => void; size?: 'xs' | 'sm'; className?: string; label?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const projectIds = [...new Set(taskIds.map(id => metadata.tasks[id]?.projectId))];
  const mixed = projectIds.length > 1;
  const current = !mixed ? metadata.projects.find(p => p.id === projectIds[0]) : undefined;
  const pending = session.pendingKey === actionKey;
  const text = label ?? (mixed ? 'Mixed projects' : current?.name ?? 'Unassigned');
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button ref={triggerRef} type="button" data-project-pill={actionKey} {...{ [FOCUS_RETURN_ATTR]: focusKey }} className={`fl-focus inline-flex ${size === 'xs' ? 'h-6 max-w-[11rem] px-1.5 text-xs' : 'h-8 max-w-[16rem] px-2 text-sm'} min-w-0 max-w-full items-center gap-1.5 rounded-full border bg-card text-left hover:bg-accent disabled:opacity-60 ${className}`} disabled={!session.writable && !pending} aria-label={`Project: ${text}. Change project for ${taskIds.length === 1 ? 'this task' : `${taskIds.length} tasks`}`} aria-busy={pending || undefined} title={text}>
        <ProjectDot project={current} />
        <span className="truncate">{text}</span>
        <ActionStatus actionKey={actionKey} pendingKey={session.pendingKey} lastResult={session.lastResult} size="size-3.5"><ChevronDown className="size-3 text-muted-foreground" aria-hidden="true" /></ActionStatus>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="min-w-52">
      <DropdownMenuLabel className="text-xs text-muted-foreground">{taskIds.length === 1 ? 'Assign to project' : `Assign ${taskIds.length} tasks to`}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={mixed ? '__mixed__' : current?.id ?? ''} onValueChange={value => { void session.confirmAssign(taskIds, value || undefined, { node: triggerRef.current, key: focusKey }, actionKey); }}>
        <DropdownMenuRadioItem value=""><ProjectDot className="mr-1" />Unassigned</DropdownMenuRadioItem>
        {metadata.projects.map(project => <DropdownMenuRadioItem key={project.id} value={project.id}><ProjectDot project={project} className="mr-1" />{project.name}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => onCreate(taskIds, { node: triggerRef.current, key: focusKey })}><Plus className="size-4" aria-hidden="true" />Create new project…</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}


/**
 * Cowork link commands for the task header. No link → one compact secondary "Assign Cowork link" command that opens a
 * popover editor (paste / manual entry, validation, Enter-to-save). Link → a real "Open in Cowork" anchor plus a
 * low-emphasis Edit command (the popover also offers Remove). Both triggers share one stable focus key so focus returns
 * to the current equivalent control after save/remove. Geometry: fixed 32px controls; the popover floats.
 */
export function CoworkLinkCommands({ taskId, metadata, session }: { taskId: string; metadata: CompanionMetadata; session: Pick<CompanionSession, 'runAction' | 'pendingKey' | 'lastResult' | 'writable'> }) {
  const saved = metadata.tasks[taskId]?.coworkUrl ?? '';
  const savedValid = validateCoworkTaskUrl(saved);
  const savedSafe = savedValid.ok ? safeUrl(savedValid.url) : undefined;
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(saved);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string }>();
  const inputRef = useRef<HTMLInputElement>(null);
  const [focusReturn] = useState(() => new FocusReturn<HTMLElement>());
  const key = `url:${taskId}`;
  const focusKey = `cowork-link:${taskId}`;
  const pending = session.pendingKey === key;
  const clipboardAvailable = typeof navigator !== 'undefined' && !!navigator.clipboard && typeof navigator.clipboard.readText === 'function';
  useEffect(() => { if (!open) { setValue(saved); setMessage(undefined); } }, [saved, open]);
  function close() { setOpen(false); window.requestAnimationFrame(() => focusReturn.restore(k => resolveFocusKey(k))); }
  function onOpenChange(next: boolean) { if (next) { focusReturn.capture({ node: document.activeElement instanceof HTMLElement ? document.activeElement : null, key: focusKey }); setOpen(true); } else close(); }
  async function saveUrl(candidate: string): Promise<boolean> {
    const result = validateCoworkTaskUrl(candidate);
    if (!result.ok) { setMessage({ tone: 'error', text: coworkUrlMessages[result.reason] }); return false; }
    setMessage(undefined);
    const ok = await session.runAction(key, () => ({ ...metadata, tasks: { ...metadata.tasks, [taskId]: { ...metadata.tasks[taskId], coworkUrl: result.url } } }));
    if (ok) close(); else setMessage({ tone: 'error', text: 'The link could not be saved. The previous link is unchanged.' });
    return ok;
  }
  async function pasteFromClipboard() {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { inputRef.current?.focus(); setMessage({ tone: 'info', text: 'Clipboard access was not allowed. Click the field and press Ctrl+V to paste.' }); return; }
    if (!text.trim()) { inputRef.current?.focus(); setMessage({ tone: 'info', text: 'The clipboard is empty. Copy the Cowork session URL, then press Ctrl+V here.' }); return; }
    setValue(text.trim());
    if (!await saveUrl(text)) inputRef.current?.focus();
  }
  async function remove() {
    const ok = await session.runAction(key, () => { const prefs = { ...metadata.tasks[taskId] }; delete prefs.coworkUrl; return { ...metadata, tasks: { ...metadata.tasks, [taskId]: prefs } }; });
    if (ok) close(); else setMessage({ tone: 'error', text: 'The link could not be removed.' });
  }
  const editor = <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-3" onOpenAutoFocus={e => { e.preventDefault(); inputRef.current?.focus(); }} onCloseAutoFocus={e => e.preventDefault()}>
    <form className="space-y-2" onSubmit={e => { e.preventDefault(); void saveUrl(value); }}>
      <div><Label htmlFor="cowork-task-url" className="text-xs">Cowork task URL</Label><Input ref={inputRef} id="cowork-task-url" className="fl-focus mt-1 h-8 w-full min-w-0 text-xs" value={value} onChange={e => { setValue(e.target.value); if (message) setMessage(undefined); }} placeholder="https://m365.cloud.microsoft/…#/task/…" inputMode="url" autoComplete="off" spellCheck={false} aria-invalid={message?.tone === 'error' || undefined} aria-describedby="cowork-task-url-status" /></div>
      <p className="text-xs text-muted-foreground">Paste the URL from the Cowork session in your browser.</p>
      <div className="flex min-w-0 gap-2">
        <Button size="sm" type="submit" className="fl-focus h-8 min-w-0 flex-1 justify-center" disabled={!session.writable || pending} aria-busy={pending || undefined} aria-label={pending ? 'Saving Cowork task URL' : 'Save link'}>{pending ? <Spinner className="size-4" role="presentation" aria-label={undefined} aria-hidden="true" /> : 'Save link'}</Button>
        {clipboardAvailable && <Button size="sm" type="button" variant="outline" className="fl-focus h-8 min-w-0 flex-1 justify-center" disabled={!session.writable || pending} onClick={() => void pasteFromClipboard()}><ClipboardPaste className="size-4" aria-hidden="true" />Paste</Button>}
        {saved && <Button size="sm" type="button" variant="ghost" className="fl-focus h-8 min-w-0 flex-1 justify-center" disabled={!session.writable || pending} onClick={() => void remove()} aria-label="Remove the saved Cowork link"><X className="size-4" aria-hidden="true" />Remove</Button>}
      </div>
      <p id="cowork-task-url-status" role={message?.tone === 'error' ? 'alert' : 'status'} aria-live="polite" className={`h-4 truncate text-xs ${message?.tone === 'error' ? 'text-destructive' : 'text-muted-foreground'}`} title={message?.text}>{message?.text ?? (saved ? `Saved link: ${saved}` : 'No Cowork link saved for this task yet.')}</p>
    </form>
  </PopoverContent>;
  if (savedSafe) {
    return <span className="flex min-w-0 items-center gap-1">
      <Button asChild size="sm" className="fl-focus h-8 min-w-0 flex-1 justify-center sm:flex-none sm:w-36"><a href={savedSafe} target="_blank" rel="noopener noreferrer" aria-label="Open this task in Cowork in a new tab"><span className="truncate">Open in Cowork</span><ExternalLink className="size-4" aria-hidden="true" /></a></Button>
      <Popover open={open} onOpenChange={onOpenChange}><PopoverTrigger asChild><Button size="icon-sm" variant="ghost" className="fl-focus shrink-0" {...{ [FOCUS_RETURN_ATTR]: focusKey }} aria-label="Edit or remove the Cowork link" aria-expanded={open}><Pencil className="size-4" aria-hidden="true" /></Button></PopoverTrigger>{editor}</Popover>
    </span>;
  }
  return <Popover open={open} onOpenChange={onOpenChange}><PopoverTrigger asChild><Button size="sm" variant="ghost" className="fl-focus h-8 min-w-0 flex-1 justify-center text-muted-foreground sm:flex-none" {...{ [FOCUS_RETURN_ATTR]: focusKey }} aria-expanded={open}><Link2 className="size-4" aria-hidden="true" /><span className="truncate">Assign Cowork link</span></Button></PopoverTrigger>{editor}</Popover>;
}
