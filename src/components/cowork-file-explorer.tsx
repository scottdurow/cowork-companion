import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check, FileText, Folder } from 'lucide-react';
import { FileLink, useFileLinks } from '@/components/cowork-file-link';
import type { FileLinkService } from '@/lib/file-links';
import { changeLabel } from '@/lib/cowork-workspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { classify, type DriveItem, type CoworkTaskRepository, type CompanionMetadata, ChangeDetectionService } from '@/lib/cowork-domain';

export function modified(value?: string) {
  if (!value) return 'Not provided';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not provided' : date.toLocaleString();
}
// Observable relative wording ("Updated 4 minutes ago") derived only from the item's modified timestamp.
export function ago(value?: string, prefix = 'Updated') {
  if (!value) return 'Modified time not provided';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Modified time not provided';
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  const units: [number, string][] = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month'], [Infinity, 'year']];
  let amount = seconds;
  for (const [size, name] of units) {
    if (amount < size) { const n = Math.floor(amount); return name === 'second' ? `${prefix} just now` : `${prefix} ${n} ${name}${n === 1 ? '' : 's'} ago`; }
    amount /= size;
  }
  return `${prefix} ${modified(value)}`;
}
export function isRecent(value?: string, hours = 24) {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && Date.now() - date.getTime() < hours * 3_600_000;
}
export function RecentState({ item, metadata, changes, verbose = false }: { item: DriveItem; metadata: CompanionMetadata; changes: ChangeDetectionService; verbose?: boolean }) {
  const state = changes.state(item, metadata);
  const label = changeLabel(state);
  if (label === 'Updated') return <span className="fl-badge fl-badge-warning" aria-label="Updated since you last saw it">Updated</span>;
  if (label === 'New') return <span className="fl-badge fl-badge-brand" aria-label="New: not seen before">New</span>;
  if (!verbose) return null;
  return <span className="fl-badge">{state === 'seen' ? 'Seen' : 'No change data'}</span>;
}
export function FileExplorer({ root, repository, links, scopeKey, metadata, changes, observe, markSeen, writable, taskPath, initialFile }: {
  root: DriveItem; repository: CoworkTaskRepository; links: FileLinkService; scopeKey: string;
  metadata: CompanionMetadata; changes: ChangeDetectionService;
  observe: (items: DriveItem[]) => void; markSeen: (item: DriveItem) => void; writable: boolean; taskPath?: string; initialFile?: DriveItem;
}) {
  const [trail, setTrail] = useState([root]);
  const [token, setToken] = useState<string>();
  const [previous, setPrevious] = useState<(string | undefined)[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [previewItem, setPreviewItem] = useState<DriveItem | undefined>(initialFile);
  const folder = trail[trail.length - 1];
  const query = useQuery({ queryKey: ['cowork', scopeKey, 'files', folder.Id, token], queryFn: () => repository.list(folder.Id, token), retry: false });
  const preview = useQuery({ queryKey: ['cowork', scopeKey, 'text', previewItem?.Id, previewItem?.ETag, previewItem?.LastModified], queryFn: () => { if (!previewItem) throw new Error('Choose a file.'); return repository.read(previewItem); }, enabled: !!previewItem, retry: false });
  useEffect(() => { if (query.data) observe(query.data.items); }, [query.data, observe]);
  useFileLinks(links, (query.data?.items ?? []).filter(i => !i.IsFolder));
  const items = (query.data?.items ?? []).filter(i => (i.Name ?? '').toLowerCase().includes(search.toLowerCase()) && (filter === 'all' || classify(i, taskPath) === filter)).sort((a, b) => Number(!!b.IsFolder) - Number(!!a.IsFolder) || (b.LastModified ?? '').localeCompare(a.LastModified ?? ''));
  function reset() { setToken(undefined); setPrevious([]); setSearch(''); setFilter('all'); setPreviewItem(undefined); }
  return <section className="space-y-3" aria-label={`Files in ${folder.Name ?? 'selected folder'}`}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="break-words font-semibold">{folder.Name ?? 'Files'}</h3>{trail.length > 1 && <Button variant="outline" size="sm" onClick={() => { setTrail(t => t.slice(0, -1)); reset(); }}><ArrowLeft aria-hidden="true" className="size-3" />Parent folder</Button>}</div>
    <div className="flex flex-wrap gap-2"><Input aria-label="Filter filenames on this page" className="min-w-0 flex-1" placeholder="Filter filenames" value={search} onChange={e => setSearch(e.target.value)} />{taskPath && <select aria-label="File classification" className="rounded border bg-card p-2 focus-visible:outline-2 focus-visible:outline-ring" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All files</option><option value="input">Inputs</option><option value="output">Outputs</option><option value="unclassified">Unclassified</option></select>}</div>
    {taskPath && <p className="text-xs text-muted-foreground">Input/output labels use only input(s)/output(s) folders. Files are newest first within each folder.</p>}
    {query.isPending && <LoadingState rows={2} />}
    {query.isError && <ErrorState title="Unable to read this folder" action={<Button onClick={() => void query.refetch()}>Retry files</Button>} className="py-6" />}
    {query.isSuccess && !items.length && <EmptyState icon={Folder} title="No matching items on this page" action={<Button variant="outline" onClick={() => { setSearch(''); setFilter('all'); void query.refetch(); }}>Refresh files</Button>} className="py-6" />}
    <ul className="fl-card divide-y overflow-hidden">{items.map(item => <li key={item.Id} className="fl-row flex flex-wrap items-start gap-2 p-2">
      {item.IsFolder ? <Folder className="mt-1 size-4 shrink-0" aria-hidden="true" /> : <FileText className="mt-1 size-4 shrink-0" aria-hidden="true" />}
      <div className="min-w-0 flex-1 basis-40">
        {item.IsFolder ? <button className="break-words rounded text-left font-medium focus-visible:outline-2 focus-visible:outline-ring" onClick={() => { setTrail(t => [...t, item]); reset(); }}>{item.Name ?? item.Id}</button> : <FileLink item={item} links={links} className="font-medium" />}
        <p className="text-xs text-muted-foreground" title={modified(item.LastModified)}>{ago(item.LastModified)}{!item.IsFolder ? ` · ${item.Size === undefined ? 'size n/a' : `${Math.max(1, Math.round(item.Size / 1024))} KB`}` : ''}{!item.IsFolder && taskPath && classify(item, taskPath) !== 'unclassified' ? ` · ${classify(item, taskPath)}` : ''}</p>
        <div className="flex flex-wrap items-center gap-1"><RecentState item={item} metadata={metadata} changes={changes} />{changes.isUnseen(item, metadata) && <Button variant="ghost" size="sm" disabled={!writable} onClick={() => markSeen(item)}><Check className="size-3" aria-hidden="true" />Mark seen</Button>}</div>
      </div>
      <span className="flex items-center gap-1">{!item.IsFolder && /\.(md|txt|json|csv|yaml|yml|log)$/i.test(item.Name ?? '') && <Button variant="ghost" size="xs" className="fl-focus" onClick={() => setPreviewItem(item)}>Preview</Button>}</span>
    </li>)}</ul>
    <div className="flex flex-wrap gap-2">{previous.length > 0 && <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => { setToken(previous.at(-1)); setPrevious(p => p.slice(0, -1)); }}>Previous page</Button>}{query.data?.nextToken && <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => { setPrevious(p => [...p, token]); setToken(query.data?.nextToken); }}>Load more files</Button>}</div>
    {previewItem && <div className="fl-card min-w-0 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="break-words font-semibold">{previewItem.Name}</h4><Button size="sm" variant="outline" onClick={() => setPreviewItem(undefined)}>Close text</Button></div>{preview.isPending && <p role="status">Reading text…</p>}{preview.isError && <p role="alert">{preview.error instanceof Error ? preview.error.message : 'Unable to preview this file.'}</p>}{preview.isSuccess && <pre className="mt-2 whitespace-pre-wrap break-words text-xs [overflow-wrap:anywhere]">{preview.data}</pre>}</div>}
  </section>;
}
