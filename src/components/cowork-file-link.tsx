import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import type { DriveItem } from '@/lib/cowork-domain';
import { linkAccessibleName, type FileLinkService } from '@/lib/file-links';

export function useFileLinks(service: FileLinkService, items: DriveItem[]) {
  const [, rerender] = useState(0);
  useEffect(() => service.subscribe(() => rerender(n => n + 1)), [service]);
  const key = items.map(i => i.Id).join('|');
  useEffect(() => { service.ensure(items); }, [service, key]); // eslint-disable-line react-hooks/exhaustive-deps -- items identity changes every render; the id list is the real dependency
}

/**
 * The filename itself is the link: a normal anchor with the exact connector-derived URL, target="_blank" and
 * rel="noopener noreferrer" — a natural click (or Ctrl/Cmd-click, Enter) opens it, so no script-opened popup is ever
 * needed. Without a URL the name is plain text with an explicit pending/unavailable state; nothing is manufactured.
 */
export function FileLink({ item, links: service, className = 'truncate text-sm font-medium', children }: { item: DriveItem; links: FileLinkService; className?: string; children?: React.ReactNode }) {
  const [, rerender] = useState(0);
  useEffect(() => service.subscribe(() => rerender(n => n + 1)), [service]);
  const state = service.state(item.Id);
  const name = children ?? item.Name ?? item.Id;
  if (state.status === 'ready') {
    return <a href={state.url} target="_blank" rel="noopener noreferrer" aria-label={linkAccessibleName(item)} title={item.Name} className={`fl-focus inline-flex min-w-0 max-w-full items-center gap-1 rounded text-primary hover:underline ${className}`}><span className="truncate">{name}</span><ExternalLink className="size-3 shrink-0" aria-hidden="true" /></a>;
  }
  if (state.status === 'unavailable') {
    return <span className={`inline-flex min-w-0 max-w-full items-center gap-1 ${className}`} title={state.message}><span className="truncate">{name}</span><span className="fl-badge shrink-0" aria-label={`Link unavailable: ${state.message}`}>Link unavailable</span><button type="button" className="fl-focus shrink-0 rounded text-muted-foreground hover:text-foreground" aria-label={`Retry link for ${item.Name ?? 'file'}`} onClick={() => service.retry(item)}><RefreshCw className="size-3" aria-hidden="true" /></button></span>;
  }
  return <span className={`inline-flex min-w-0 max-w-full items-center gap-1 ${className}`} aria-busy={state.status === 'pending' || undefined}><span className="truncate">{name}</span>{state.status === 'pending' && <Spinner className="size-3 shrink-0 text-muted-foreground" aria-label="Preparing link" />}</span>;
}
