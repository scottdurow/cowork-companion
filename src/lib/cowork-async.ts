// A tiny controller for one-at-a-time asynchronous UI actions (refresh, file-link resolution, remote search).
// It guarantees: a key never runs twice concurrently, the pending flag always clears on success AND failure,
// and the last outcome is kept for the UI. Pure TypeScript so the behaviour checks can drive it directly.
export type AsyncOutcome<T> = { status: 'idle' } | { status: 'pending' } | { status: 'done'; value: T } | { status: 'failed'; message: string };

export class AsyncActionController<T = unknown> {
  private pending = new Set<string>();
  private outcomes = new Map<string, AsyncOutcome<T>>();
  private listeners = new Set<() => void>();
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { for (const l of this.listeners) l(); }
  isPending(key: string) { return this.pending.has(key); }
  outcome(key: string): AsyncOutcome<T> { return this.outcomes.get(key) ?? { status: 'idle' }; }
  dismiss(key: string) { this.outcomes.delete(key); this.emit(); }
  /** Runs `work` for `key` unless it is already running; returns the outcome (or the existing pending marker). */
  async run(key: string, work: () => Promise<T>): Promise<AsyncOutcome<T>> {
    if (this.pending.has(key)) return { status: 'pending' };
    this.pending.add(key);
    this.outcomes.set(key, { status: 'pending' });
    this.emit();
    let outcome: AsyncOutcome<T>;
    try { outcome = { status: 'done', value: await work() }; }
    catch (error) { outcome = { status: 'failed', message: error instanceof Error ? error.message : 'The action failed.' }; }
    finally { this.pending.delete(key); }
    this.outcomes.set(key, outcome);
    this.emit();
    return outcome;
  }
}
