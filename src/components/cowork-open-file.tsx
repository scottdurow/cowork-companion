import { Check, Eye, FileText, Folder, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RecentState, ago, isRecent, modified } from '@/components/cowork-file-explorer';
import { FileLink } from '@/components/cowork-file-link';
import type { ChangeDetectionService, CompanionMetadata, DriveItem } from '@/lib/cowork-domain';
import type { FileLinkService } from '@/lib/file-links';
import { fileType } from '@/lib/cowork-workspace';

// Dense file row: the filename is the link (exact connector URL, new tab) · type · size · modified · New/Updated badges
// from timestamps and seen-state only · Mark seen / Preview. Fixed 44px height in every link state.
export function FileRow({ item, links, metadata, changes, writable, onMarkSeen, onPreview, primary = false, onOpenFolder, relativeDir, depth = 0 }: {
  item: DriveItem; links: FileLinkService; metadata: CompanionMetadata; changes: ChangeDetectionService; writable: boolean;
  onMarkSeen?: (item: DriveItem) => void; onPreview?: (item: DriveItem) => void; primary?: boolean; onOpenFolder?: (item: DriveItem) => void;
  /** Flat view: the folder path inside the output/input folder, shown after the name. */ relativeDir?: string;
  /** Tree view: nesting depth for indentation. */ depth?: number;
}) {
  const unseen = changes.isUnseen(item, metadata);
  const recent = isRecent(item.LastModified, 24);
  const Icon = item.IsFolder ? (onOpenFolder ? FolderOpen : Folder) : FileText;
  return <li className="fl-row grid h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 px-2 sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,8rem)_minmax(0,9rem)_auto]" style={depth ? { paddingLeft: `${8 + depth * 18}px` } : undefined} data-file-id={item.Id}>
    <Icon className={`size-4 shrink-0 ${primary && (unseen || recent) ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden="true" />
    <span className="min-w-0">
      <span className="flex min-w-0 items-center gap-2">
        {item.IsFolder && onOpenFolder ? <button className="fl-focus truncate rounded text-left text-sm font-medium" onClick={() => onOpenFolder(item)}>{item.Name ?? item.Id}</button> : <FileLink item={item} links={links} />}
        {relativeDir && <span className="truncate text-xs text-muted-foreground" title={relativeDir}>{relativeDir}</span>}
        <RecentState item={item} metadata={metadata} changes={changes} />
      </span>
      <span className="block truncate text-xs text-muted-foreground sm:hidden">{fileType(item)}{item.Size !== undefined ? ` · ${Math.max(1, Math.round(item.Size / 1024))} KB` : ''} · {ago(item.LastModified)}</span>
    </span>
    <span className="hidden truncate text-xs text-muted-foreground sm:block">{fileType(item)}{!item.IsFolder && item.Size !== undefined ? ` · ${Math.max(1, Math.round(item.Size / 1024))} KB` : ''}</span>
    <span className="hidden truncate text-xs text-muted-foreground sm:block" title={modified(item.LastModified)}>{ago(item.LastModified)}</span>
    <span className="flex items-center gap-1">
      {unseen && onMarkSeen && <Button size="xs" variant="ghost" className="fl-focus text-muted-foreground" disabled={!writable} aria-label={`Mark ${item.Name ?? 'file'} seen`} onClick={() => onMarkSeen(item)}><Check className="size-3.5 sm:hidden" aria-hidden="true" /><span className="hidden sm:inline">Mark seen</span></Button>}
      {!item.IsFolder && onPreview && <Button size="xs" variant="ghost" className="fl-focus" aria-label={`Preview ${item.Name ?? 'file'} as text`} onClick={() => onPreview(item)}><Eye className="size-3.5 sm:hidden" aria-hidden="true" /><span className="hidden sm:inline">Preview</span></Button>}
    </span>
  </li>;
}
