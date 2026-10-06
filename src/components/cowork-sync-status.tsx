// Concise, layout-stable sync status: one line in a fixed-height slot, derived only from the engine's observable state.
// "Showing cached data · checking for changes", "Updated just now", "Refresh failed · showing data from 10:24 · Retry".
import { AlertTriangle, Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { SyncStatus } from '@/lib/cowork-sync';

const timeOf = (iso?: string) => iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : undefined;
export function agoShort(iso?: string, now = Date.now()) {
  if (!iso) return undefined;
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `at ${timeOf(iso)}`;
}

/** The single sentence the status slot shows, exported so behaviour checks can assert the wording for each engine state. */
export function syncStatusText(status: SyncStatus, now = Date.now()): { text: string; tone: 'muted' | 'warning' | 'error'; busy: boolean; retry: boolean } {
  const from = timeOf(status.lastSyncedAt);
  if (status.rootError) return { text: `Couldn’t open the Cowork folder · ${status.rootError}`, tone: 'error', busy: false, retry: true };
  if (status.phase === 'authorizing') return { text: 'Opening the Cowork folder…', tone: 'muted', busy: true, retry: false };
  if (status.phase === 'cold-outline') return { text: 'Reading task folders…', tone: 'muted', busy: true, retry: false };
  if (status.phase === 'rescanning') return { text: status.progress ? `Full rescan · ${status.progress.done} of ${status.progress.total} task folders` : 'Full rescan · reading every folder…', tone: 'muted', busy: true, retry: false };
  if (status.error) return { text: from ? `Refresh failed · showing data from ${from}` : `Refresh failed · ${status.error}`, tone: 'error', busy: false, retry: true };
  if (status.phase === 'revalidating') return { text: status.source === 'cache' ? 'Showing cached data · checking for changes' : 'Checking for changes…', tone: 'muted', busy: true, retry: false };
  if (status.progress) return { text: `${status.progress.label} · ${status.progress.done} of ${status.progress.total}`, tone: 'muted', busy: true, retry: false };
  if (status.pendingHydration > 0) return { text: `Updated ${agoShort(status.lastSyncedAt, now) ?? 'just now'} · inspecting ${status.pendingHydration} task folder${status.pendingHydration === 1 ? '' : 's'}`, tone: 'muted', busy: true, retry: false };
  if (status.source === 'cache') return { text: `Showing cached data from ${from ?? 'an earlier visit'}`, tone: 'muted', busy: false, retry: false };
  return { text: `Updated ${agoShort(status.lastSyncedAt, now) ?? 'just now'}`, tone: 'muted', busy: false, retry: false };
}

export function SyncStatusSlot({ status, onRetry, className = '' }: { status: SyncStatus; onRetry: () => void; className?: string }) {
  const s = syncStatusText(status);
  const tone = s.tone === 'error' ? 'text-destructive' : s.tone === 'warning' ? 'text-[var(--fl-warning)]' : 'text-muted-foreground';
  return <span className={`flex h-5 min-w-0 items-center gap-1.5 text-xs ${tone} ${className}`} data-sync-status={status.phase} data-sync-source={status.source}>
    {s.busy && <Spinner className="size-3 shrink-0" role="presentation" aria-label={undefined} aria-hidden="true" />}
    {s.tone === 'error' && <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />}
    <span role="status" aria-live="polite" className="truncate" title={s.text}>{s.text}</span>
    {s.retry && <Button size="xs" variant="outline" className="fl-focus h-5 shrink-0 px-1.5" onClick={onRetry}>Retry</Button>}
    {status.cacheKind === 'memory' && status.cacheWarning && <span className="hidden shrink-0 items-center gap-1 sm:inline-flex" title={status.cacheWarning}><Database className="size-3" aria-hidden="true" />session cache</span>}
  </span>;
}
