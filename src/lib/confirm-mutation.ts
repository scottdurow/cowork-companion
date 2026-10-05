// Confirmed metadata mutation: pick a candidate (menu/button) → confirmation dialog → exactly one write → focus back
// on the current equivalent trigger. Pure so the behaviour checks can drive it with fake confirm/save/focus.
import { FocusReturn, type Focusable, type FocusOrigin } from '@/lib/focus-return';

export interface ConfirmRequest { title: string; description: string; confirmLabel: string; destructive?: boolean }
export type ConfirmedOutcome = { status: 'cancelled' } | { status: 'noop' } | { status: 'saved' } | { status: 'failed'; message: string } | { status: 'busy' };

export interface ConfirmedMutationDeps<T extends Focusable> {
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  /** Performs the single write; resolves true on success, false (or throws) on failure. */
  perform: () => Promise<boolean>;
  isBusy: () => boolean;
  focusReturn: FocusReturn<T>;
  resolveByKey?: (key: string) => T | null | undefined;
  fallback?: () => T | null | undefined;
  /** Schedules the focus restore after the dialog has unmounted (next frame in the browser; immediate in checks). */
  defer?: (run: () => void) => void;
}

export async function runConfirmedMutation<T extends Focusable>(request: ConfirmRequest | null, origin: FocusOrigin<T> | T | null | undefined, deps: ConfirmedMutationDeps<T>): Promise<ConfirmedOutcome> {
  if (request === null) return { status: 'noop' }; // e.g. choosing the already-current project
  if (deps.isBusy()) return { status: 'busy' };
  deps.focusReturn.capture(origin, deps.fallback);
  const restore = () => (deps.defer ?? (run => run()))(() => deps.focusReturn.restore(deps.resolveByKey));
  const confirmed = await deps.confirm(request);
  if (!confirmed) { restore(); return { status: 'cancelled' }; }
  try {
    const ok = await deps.perform();
    restore();
    return ok ? { status: 'saved' } : { status: 'failed', message: 'The change could not be saved.' };
  } catch (error) {
    restore();
    return { status: 'failed', message: error instanceof Error ? error.message : 'The change could not be saved.' };
  }
}

// ---- Request builders (text states the task name / count and the destination) -----------------------------------
export function assignRequest(names: string[], from: string | undefined, to: string | undefined): ConfirmRequest | null {
  const count = names.length;
  const subject = count === 1 ? `“${names[0]}”` : `${count} selected tasks`;
  if (to === undefined) return { title: count === 1 ? 'Remove from project?' : `Unassign ${count} tasks?`, description: `${subject} will be moved from ${from ? `“${from}”` : 'its current project'} to Unassigned. Only Cowork Companion metadata changes; the task folder is not moved.`, confirmLabel: 'Unassign' };
  return { title: count === 1 ? 'Move to project?' : `Assign ${count} tasks?`, description: `${subject} will be assigned to “${to}”${from ? ` (currently “${from}”)` : ''}. Only Cowork Companion metadata changes; the task folder is not moved.`, confirmLabel: `Assign to ${to}` };
}
export function archiveRequest(name: string): ConfirmRequest {
  return { title: 'Archive task?', description: `“${name}” will be hidden from the working view. It stays in OneDrive untouched and can be restored from Archived.`, confirmLabel: 'Archive' };
}
