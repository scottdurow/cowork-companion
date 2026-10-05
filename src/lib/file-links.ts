// Browser links for OneDrive items, resolved through the repository (view-only, organisation-scoped) and cached per
// item for the session, with bounded concurrency. The UI renders a filename as a real anchor only once a link is
// known; until then it is plain text with an explicit state. No URL is ever manufactured.
import type { CoworkTaskRepository, DriveItem } from '@/lib/cowork-domain';

export type LinkState = { status: 'idle' } | { status: 'pending' } | { status: 'ready'; url: string } | { status: 'unavailable'; message: string };

export class FileLinkService {
  private states = new Map<string, LinkState>();
  private listeners = new Set<() => void>();
  private queue: DriveItem[] = [];
  private active = 0;
  constructor(private repository: Pick<CoworkTaskRepository, 'open'>, private concurrency = 3, private maxItems = 80) {}
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { for (const l of this.listeners) l(); }
  state(id: string): LinkState { return this.states.get(id) ?? { status: 'idle' }; }
  url(id: string): string | undefined { const s = this.states.get(id); return s?.status === 'ready' ? s.url : undefined; }
  /** Queue items whose link is not yet known (deduplicated, bounded); resolution starts immediately. */
  ensure(items: DriveItem[]) {
    let queued = 0;
    for (const item of items) {
      if (this.states.has(item.Id) || this.queue.some(q => q.Id === item.Id)) continue;
      if (this.states.size >= this.maxItems) break;
      this.states.set(item.Id, { status: 'pending' });
      this.queue.push(item);
      queued++;
    }
    if (queued) { this.emit(); this.pump(); }
    return queued;
  }
  retry(item: DriveItem) { this.states.delete(item.Id); this.ensure([item]); }
  private pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const item = this.queue.shift()!;
      this.active++;
      void this.repository.open(item)
        .then(url => { this.states.set(item.Id, { status: 'ready', url }); })
        .catch((error: unknown) => { this.states.set(item.Id, { status: 'unavailable', message: error instanceof Error ? error.message : 'No browser link is available.' }); })
        .finally(() => { this.active--; this.emit(); this.pump(); });
    }
  }
}
export function linkAccessibleName(item: Pick<DriveItem, 'Name' | 'IsFolder'>) { return `Open ${item.Name ?? (item.IsFolder ? 'folder' : 'file')} in a new tab`; }
