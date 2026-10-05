// Explicit focus restoration for flows that chain a menu into a dialog (project pill → "Create new project…" → dialog).
// Radix returns focus to whatever was focused when the dialog mounted; after a menu closes that is often <body>, so the
// originating control is remembered here and focused explicitly on every close path (Escape, Cancel, Close, success).
export interface Focusable { focus(options?: { preventScroll?: boolean }): void; readonly isConnected: boolean }

export interface FocusOrigin<T extends Focusable = Focusable> { node: T | null | undefined; /** Stable identity (e.g. "pill:row:<task id>") that survives React replacing the node. */ key?: string }

export class FocusReturn<T extends Focusable = Focusable> {
  private origin?: FocusOrigin<T>;
  private fallback?: () => T | null | undefined;
  /** Remember the control that started the flow (e.g. the row or bulk project pill) by node AND stable key. */
  capture(origin: FocusOrigin<T> | T | null | undefined, fallback?: () => T | null | undefined) {
    this.origin = origin && typeof origin === 'object' && 'node' in origin ? origin : { node: origin as T | null | undefined };
    this.fallback = fallback;
  }
  get target(): T | undefined { return this.origin?.node ?? undefined; }
  get key(): string | undefined { return this.origin?.key; }
  /**
   * Focus, in order: the captured node if still connected → the current element with the same stable key (the
   * re-rendered equivalent) if connected → the fallback. Returns what received focus.
   */
  restore(resolveByKey?: (key: string) => T | null | undefined): T | undefined {
    const origin = this.origin;
    const byNode = origin?.node && origin.node.isConnected ? origin.node : undefined;
    const byKey = !byNode && origin?.key ? resolveByKey?.(origin.key) : undefined;
    const target = byNode ?? (byKey && byKey.isConnected ? byKey : undefined) ?? this.fallback?.() ?? undefined;
    this.origin = undefined;
    this.fallback = undefined;
    if (target) target.focus({ preventScroll: true });
    return target;
  }
  clear() { this.origin = undefined; this.fallback = undefined; }
}
export const FOCUS_RETURN_ATTR = 'data-focus-return-key';
export function pillFocusKey(scope: 'row' | 'bulk' | 'header', id = '') { return scope === 'bulk' ? 'pill:bulk' : `pill:${scope}:${id}`; }
/** DOM resolver for the stable key (kept here so the UI and the checks share it). */
export function resolveFocusKey(key: string, root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[${FOCUS_RETURN_ATTR}="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key.replace(/"/g, '\\"')}"]`);
}

export const dialogCloseReasons = ['escape', 'cancel', 'close-button', 'success'] as const;
export type DialogCloseReason = typeof dialogCloseReasons[number];
