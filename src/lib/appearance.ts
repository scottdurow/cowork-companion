// Appearance preference: `preferences.appearance` is exactly 'system' | 'light' | 'dark' in the app-owned companion
// file. Missing or invalid values resolve to 'system' without rewriting the file. The resolved scheme drives the
// `.light` / `.dark` class on <html>, which selects the light or dark Fluent-style token set in index.css.
export const appearances = ['system', 'light', 'dark'] as const;
export type Appearance = typeof appearances[number];
export type Scheme = 'light' | 'dark';
export const appearanceLabels: Record<Appearance, string> = { system: 'System', light: 'Light', dark: 'Dark' };

export function parseAppearance(value: unknown): Appearance { return appearances.includes(value as Appearance) ? value as Appearance : 'system'; }
export function appearanceOf(document: { preferences?: { appearance?: unknown } } | undefined): Appearance { return parseAppearance(document?.preferences?.appearance); }
export function resolveScheme(appearance: Appearance, systemPrefersDark: boolean): Scheme { return appearance === 'system' ? (systemPrefersDark ? 'dark' : 'light') : appearance; }
/** Classes to put on <html>: explicit choices pin a scheme; 'system' leaves both off so the prefers-color-scheme CSS applies. */
export function rootClassesFor(appearance: Appearance): { add: string[]; remove: string[] } {
  if (appearance === 'light') return { add: ['light'], remove: ['dark'] };
  if (appearance === 'dark') return { add: ['dark'], remove: ['light'] };
  return { add: [], remove: ['light', 'dark'] };
}

/** Pure model of the live appearance: tracks the preference and the OS media query, and notifies on resolved changes. */
export class AppearanceController {
  private listeners = new Set<(scheme: Scheme, appearance: Appearance) => void>();
  constructor(private appearance: Appearance = 'system', private systemDark = false) {}
  get current(): Appearance { return this.appearance; }
  get scheme(): Scheme { return resolveScheme(this.appearance, this.systemDark); }
  subscribe(listener: (scheme: Scheme, appearance: Appearance) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  setAppearance(next: Appearance) { const before = this.scheme; this.appearance = next; this.emit(before); }
  /** Called from the `(prefers-color-scheme: dark)` media query listener. Only affects the resolved scheme under 'system'. */
  onSystemChange(prefersDark: boolean) { const before = this.scheme; this.systemDark = prefersDark; this.emit(before); }
  private emit(before: Scheme) { const after = this.scheme; if (after !== before) for (const l of this.listeners) l(after, this.appearance); }
}
