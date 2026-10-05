// Pure helpers for project assignment (single and bulk), task selection, and Cowork task URL validation.
// Everything here operates on stable OneDrive item IDs and the companion metadata document only.
import { parseMetadata, putProject, type CompanionMetadata, type Project } from '@/lib/cowork-domain';

// ---- Assignment: one metadata mutation for any number of tasks -------------------------------
export function assignTasks(document: CompanionMetadata, taskIds: Iterable<string>, projectId: string | undefined): CompanionMetadata {
  const ids = [...new Set(taskIds)].filter(id => id.length > 0);
  if (!ids.length) return document;
  if (projectId !== undefined && !document.projects.some(p => p.id === projectId)) throw new Error('That project no longer exists. Reload settings and try again.');
  const tasks = { ...document.tasks };
  for (const id of ids) tasks[id] = { ...tasks[id], projectId };
  return parseMetadata(JSON.stringify({ ...document, tasks }));
}
export function createProjectAndAssign(document: CompanionMetadata, project: Project, taskIds: Iterable<string>): CompanionMetadata {
  return assignTasks(putProject(document, project), taskIds, project.id);
}
/** Summarises the current projects of a set of tasks (for the bulk bar / menu). */
export function assignmentSummary(document: CompanionMetadata, taskIds: Iterable<string>): { projectIds: (string | undefined)[]; mixed: boolean; common?: string } {
  const projectIds = [...new Set([...taskIds].map(id => document.tasks[id]?.projectId))];
  return { projectIds, mixed: projectIds.length > 1, common: projectIds.length === 1 ? projectIds[0] : undefined };
}

// ---- Selection: session UI state over stable IDs --------------------------------------------
export function toggleSelected(selection: ReadonlySet<string>, id: string): Set<string> { const next = new Set(selection); if (next.has(id)) next.delete(id); else next.add(id); return next; }
export function selectAll(selection: ReadonlySet<string>, visibleIds: Iterable<string>): Set<string> { const next = new Set(selection); for (const id of visibleIds) next.add(id); return next; }
export function deselectAll(selection: ReadonlySet<string>, visibleIds: Iterable<string>): Set<string> { const next = new Set(selection); for (const id of visibleIds) next.delete(id); return next; }
/** Drop IDs that are no longer discovered; IDs merely hidden by a filter or sort stay selected. */
export function pruneSelection(selection: ReadonlySet<string>, presentIds: ReadonlySet<string>): Set<string> { return new Set([...selection].filter(id => presentIds.has(id))); }
export function visibleSelectionState(selection: ReadonlySet<string>, visibleIds: readonly string[]): 'none' | 'some' | 'all' {
  const count = visibleIds.filter(id => selection.has(id)).length;
  return count === 0 ? 'none' : count === visibleIds.length ? 'all' : 'some';
}

// ---- Cowork task URL ------------------------------------------------------------------------
// Accepts the complete URL copied from the Cowork session in the browser (query and #/task/... fragment kept
// verbatim). Rejects malformed strings, non-http(s) schemes and hosts that are not Microsoft Cowork/Copilot hosts.
// Nothing is ever derived or manufactured.
export const coworkHostSuffixes = ['cloud.microsoft', 'microsoft.com', 'microsoft365.com', 'office.com'] as const;
export type CoworkUrlResult = { ok: true; url: string } | { ok: false; reason: 'empty' | 'malformed' | 'scheme' | 'host' | 'credentials' | 'too-long' };
export function validateCoworkTaskUrl(input: string | null | undefined): CoworkUrlResult {
  const value = (input ?? '').trim();
  if (!value) return { ok: false, reason: 'empty' };
  if (value.length > 4096) return { ok: false, reason: 'too-long' };
  let url: URL;
  try { url = new URL(value); } catch { return { ok: false, reason: 'malformed' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'scheme' };
  if (url.username || url.password) return { ok: false, reason: 'credentials' };
  const host = url.hostname.toLowerCase();
  if (!coworkHostSuffixes.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) return { ok: false, reason: 'host' };
  return { ok: true, url: url.href };
}
export const coworkUrlMessages: Record<Exclude<CoworkUrlResult, { ok: true }>['reason'], string> = {
  empty: 'Paste the URL from the Cowork session in your browser.',
  malformed: 'That is not a complete URL. Copy the full address from the browser address bar.',
  scheme: 'Only http and https URLs are accepted.',
  credentials: 'Remove the user name/password from the URL.',
  host: 'That is not a Cowork URL. It should come from m365.cloud.microsoft or another Microsoft Copilot host.',
  'too-long': 'That URL is too long to save.',
};
