// First-run bootstrap of the LIVE companion metadata file (/Documents/cowork-companion.json).
// Independent of the effective content repository: Demo mode (the first-run default) must not stop the live file
// from being created, and bootstrapping must not trigger any live Cowork content read. The controller guarantees
// exactly one initialize per absent scan (across re-renders / Strict Mode double effects), never touches an existing
// file, surfaces failures explicitly and supports an explicit retry.
import type { CompanionMetadata, CompanionMetadataRepository, MetadataPage } from '@/lib/cowork-domain';
import { emptyMetadata } from '@/lib/cowork-domain';

export type BootstrapPhase =
  | { status: 'idle' }
  | { status: 'creating' }
  | { status: 'created'; document: CompanionMetadata }
  | { status: 'failed'; message: string };

/** What Settings should say about the live companion file. */
export type SettingsReadiness =
  | { kind: 'checking' }                                  // live preferences query still loading
  | { kind: 'creating' }                                  // absent → first-run file creation in progress
  | { kind: 'ready'; saved: boolean }                     // document loaded; `saved` = an explicit demoMode preference exists
  | { kind: 'scan-incomplete' }                           // absent on this page but more pages to check
  | { kind: 'create-failed'; message: string }            // initialize failed (connector error) — retry available
  | { kind: 'load-failed'; message: string };             // the live read itself failed (connector error) — retry available

export interface BootstrapDecisionInput { page?: MetadataPage; queryStatus: 'pending' | 'success' | 'error'; queryError?: string; phase: BootstrapPhase }

/** Should the controller start creating the live file now? True only for a conclusive absent scan with nothing started. */
export function shouldBootstrap(input: Pick<BootstrapDecisionInput, 'page' | 'queryStatus' | 'phase'>): boolean {
  return input.queryStatus === 'success' && !!input.page?.absent && !input.page.nextToken && !input.page.document && input.phase.status === 'idle';
}

export function settingsReadiness(input: BootstrapDecisionInput): SettingsReadiness {
  if (input.queryStatus === 'error') return { kind: 'load-failed', message: input.queryError ?? 'The companion settings file could not be read.' };
  if (input.queryStatus === 'pending') return { kind: 'checking' };
  const document = input.page?.document;
  if (document) return { kind: 'ready', saved: document.preferences?.demoMode !== undefined };
  if (input.phase.status === 'failed') return { kind: 'create-failed', message: input.phase.message };
  if (input.phase.status === 'creating' || shouldBootstrap(input)) return { kind: 'creating' };
  if (input.page?.absent && input.page.nextToken) return { kind: 'scan-incomplete' };
  return { kind: 'checking' };
}

export class MetadataBootstrapController {
  private phase: BootstrapPhase = { status: 'idle' };
  private inflight?: Promise<BootstrapPhase>;
  private listeners = new Set<() => void>();
  constructor(private repository: Pick<CompanionMetadataRepository, 'initialize'>, private onCreated?: (document: CompanionMetadata) => void) {}
  get state(): BootstrapPhase { return this.phase; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private set(next: BootstrapPhase) { this.phase = next; for (const l of this.listeners) l(); }
  /** Idempotent: a second call while creating (or after success) returns the same outcome without a second write. */
  start(): Promise<BootstrapPhase> {
    if (this.inflight) return this.inflight;
    if (this.phase.status === 'created' || this.phase.status === 'failed') return Promise.resolve(this.phase); // after a failure only an explicit retry() tries again
    this.set({ status: 'creating' });
    this.inflight = this.repository.initialize(emptyMetadata())
      .then(document => { const next: BootstrapPhase = { status: 'created', document }; this.set(next); this.onCreated?.(document); return next; })
      .catch((error: unknown) => { const next: BootstrapPhase = { status: 'failed', message: error instanceof Error ? error.message : 'The companion settings file could not be created.' }; this.set(next); return next; })
      .finally(() => { this.inflight = undefined; });
    return this.inflight;
  }
  /** Explicit user retry after a failure. */
  retry(): Promise<BootstrapPhase> { if (this.phase.status !== 'failed') return Promise.resolve(this.phase); this.set({ status: 'idle' }); return this.start(); }
  /** Called when a fresh live load observes the file (created elsewhere): nothing to do and nothing to create. */
  observeExisting() { if (this.phase.status !== 'created') this.phase = { status: 'idle' }; }
}
