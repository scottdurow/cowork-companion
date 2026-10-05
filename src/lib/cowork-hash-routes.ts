// Hash routes are the single source of truth for what the app shows. Pure helpers only (no React, no DOM);
// the hook that binds them to window.location lives in use-hash-route.ts.
export const sections = ['dashboard', 'tasks', 'projects', 'skills', 'memory', 'archived', 'settings'] as const;
export type Section = typeof sections[number];
export const sectionLabels: Record<Section, string> = { dashboard: 'Dashboard', tasks: 'Tasks', projects: 'Projects', skills: 'Skills', memory: 'Memory', archived: 'Archived', settings: 'Settings' };
export type HashRoute =
  | { kind: 'section'; section: Section }
  | { kind: 'task'; taskId: string }
  | { kind: 'not-found'; hash: string; reason: 'unknown-section' | 'malformed-task-id' | 'malformed' };

export const DEFAULT_HASH = '#/dashboard';
export function sectionHash(section: Section) { return `#/${section}`; }
export function taskHash(taskId: string) { return `#/tasks/${encodeURIComponent(taskId)}`; }
export function serializeRoute(route: HashRoute): string {
  if (route.kind === 'section') return sectionHash(route.section);
  if (route.kind === 'task') return taskHash(route.taskId);
  return route.hash;
}

/** Normalise user-typed variants (#tasks, #/Tasks/, #/tasks//) to the canonical hash; returns undefined for an empty hash. */
export function canonicalHash(hash: string): string | undefined {
  let value = (hash ?? '').trim();
  if (value.startsWith('#')) value = value.slice(1);
  if (!value || value === '/') return undefined;
  if (!value.startsWith('/')) value = `/${value}`;
  value = value.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  const [, head = '', ...rest] = value.split('/');
  const section = head.toLowerCase();
  if (section === 'tasks' && rest.length === 1 && rest[0]) return `#/tasks/${rest[0]}`;
  if (rest.length === 0 && (sections as readonly string[]).includes(section)) return `#/${section}`;
  return `#${value}`;
}

export function parseHash(hash: string): HashRoute | undefined {
  const canonical = canonicalHash(hash);
  if (canonical === undefined) return undefined;
  const parts = canonical.slice(2).split('/');
  if (parts.length === 1 && (sections as readonly string[]).includes(parts[0])) return { kind: 'section', section: parts[0] as Section };
  if (parts[0] === 'tasks' && parts.length === 2) {
    try {
      const taskId = decodeURIComponent(parts[1]);
      if (!taskId.trim() || taskId.length > 2048 || [...taskId].some(ch => ch.charCodeAt(0) < 32)) return { kind: 'not-found', hash: canonical, reason: 'malformed-task-id' };
      return { kind: 'task', taskId };
    } catch { return { kind: 'not-found', hash: canonical, reason: 'malformed-task-id' }; }
  }
  if (parts.length === 1) return { kind: 'not-found', hash: canonical, reason: 'unknown-section' };
  return { kind: 'not-found', hash: canonical, reason: 'malformed' };
}

/** Compact navigation: the first `primaryCount` sections stay in the bar; the rest go to an accessible "More" menu so every destination remains reachable. */
export function splitNavigation<T extends string>(all: readonly T[], primaryCount: number): { primary: T[]; overflow: T[] } {
  const count = Math.max(0, Math.min(primaryCount, all.length));
  return { primary: all.slice(0, count), overflow: all.slice(count) };
}

/** Which section the task list "belongs to" for breadcrumbs/back fallbacks. */
export const listSections: readonly Section[] = ['dashboard', 'tasks', 'archived'];
export function listSectionFor(route: HashRoute | undefined): Section { return route?.kind === 'section' && listSections.includes(route.section) ? route.section : 'tasks'; }

/** In-app Back: use browser history only when this page load pushed an entry before the current one. */
export function backTarget(historyState: unknown): { kind: 'history' } | { kind: 'hash'; hash: string } {
  const index = historyState && typeof historyState === 'object' ? (historyState as { companionIndex?: unknown }).companionIndex : undefined;
  return typeof index === 'number' && index > 0 ? { kind: 'history' } : { kind: 'hash', hash: sectionHash('tasks') };
}

/** Resolve a task route against the last read: loading until the layout exists, then found or not-found. */
export function resolveTaskRoute(taskId: string, layoutLoaded: boolean, has: (id: string) => boolean): 'loading' | 'found' | 'not-found' {
  if (!layoutLoaded) return 'loading';
  return has(taskId) ? 'found' : 'not-found';
}

/** Deterministic model of the browser's hash history used by the behaviour checks (and nothing else). */
export class HashHistoryModel {
  entries: { hash: string; state: { companionIndex: number } }[];
  index = 0;
  constructor(initial = '') { const canonical = canonicalHash(initial) ?? DEFAULT_HASH; this.entries = [{ hash: canonical, state: { companionIndex: 0 } }]; }
  get hash() { return this.entries[this.index].hash; }
  get state() { return this.entries[this.index].state; }
  get route() { return parseHash(this.hash); }
  push(hash: string) { this.entries = this.entries.slice(0, this.index + 1); this.entries.push({ hash, state: { companionIndex: this.state.companionIndex + 1 } }); this.index += 1; }
  replace(hash: string) { this.entries[this.index] = { hash, state: this.state }; }
  back() { if (this.index > 0) this.index -= 1; }
  forward() { if (this.index < this.entries.length - 1) this.index += 1; }
}
