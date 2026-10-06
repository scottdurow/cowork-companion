// Pure repository contract checks. Not imported by the running app; no live fixture substitution.
import { ChangeDetectionService, InMemoryCompanionMetadataRepository, InMemoryCoworkTaskRepository, FolderSkillsRepository, FolderMemoryRepository, classify, classifyFolder, compareText, deleteProject, demoModeOf, emptyMetadata, fingerprint, parseMetadata, patchTask, putProject, serializeMetadata, skillSummary, validatedCoworkUrl, withAppearance, withDemoMode, type CompanionMetadata, type CoworkTaskRepository, type DriveItem, type FolderPage } from './cowork-domain';
import { CoworkDiscoveryService, containerKind } from './cowork-discovery';
import { decodeFileContent } from './cowork-repositories';
import { allFolderIds, buildRoleTree, changeLabel, collectTreeFiles, decodeListState, decodeOutputsView, defaultListState, encodeListState, fileType, flattenRoleFiles, openFileInNewTab, partitionTaskFiles, searchLocalFiles, toggleExpanded } from './cowork-workspace';
import { DEFAULT_HASH, HashHistoryModel, backTarget, canonicalHash, listSectionFor, parseHash, resolveTaskRoute, sectionHash, sections, serializeRoute, splitNavigation, taskHash } from './cowork-hash-routes';
import { createDemoRepositories } from './cowork-demo';
import { createRepositories } from './cowork-repositories';
import { AsyncActionController } from './cowork-async';
import { FocusReturn, dialogCloseReasons, pillFocusKey } from './focus-return';
import { AppearanceController, appearanceOf, parseAppearance, resolveScheme, rootClassesFor } from './appearance';
import { archiveRequest, assignRequest, runConfirmedMutation } from './confirm-mutation';
import { FileLinkService, linkAccessibleName } from './file-links';
import { MetadataBootstrapController, settingsReadiness, shouldBootstrap } from './metadata-bootstrap';
import type { CompanionMetadataRepository, MetadataPage } from './cowork-domain';
import { assignTasks, assignmentSummary, createProjectAndAssign, deselectAll, pruneSelection, selectAll, toggleSelected, validateCoworkTaskUrl, visibleSelectionState } from './cowork-assignment';
import { skeletonSpec } from '../components/cowork-skeletons';
import type { TaskFile, TaskFolder } from './cowork-discovery';

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function rejects(run: () => unknown, message: string) { let failed = false; try { run(); } catch { failed = true; } assert(failed, message); }
export async function runCoworkChecks() {
  const passed: string[] = [];
  const initial = emptyMetadata();
  const assigned = patchTask(putProject(initial, { id: 'project-stable', name: 'Research', color: 'green' }), 'task-stable', { projectId: 'project-stable', pinned: true, archived: false, coworkUrl: 'https://example.com/task' });
  assert(assigned.tasks['task-stable'].projectId === 'project-stable', 'Assignment must retain stable ID.');
  assert(initial.projects.length === 0 && Object.keys(initial.tasks).length === 0, 'Mutation must not change original document.');
  passed.push('project creation and stable assignment');
  const renamed = putProject(assigned, { id: 'project-stable', name: 'Discovery', color: 'blue' });
  assert(renamed.projects.length === 1 && renamed.projects[0].name === 'Discovery' && renamed.projects[0].color === 'blue', 'Project edits must retain ID.');
  passed.push('project rename and color update');
  const deleted = deleteProject(renamed, 'project-stable');
  assert(deleted.projects.length === 0 && deleted.tasks['task-stable'].projectId === undefined && deleted.tasks['task-stable'].pinned && deleted.tasks['task-stable'].coworkUrl === 'https://example.com/task', 'Deleting a project must preserve tasks and unrelated preferences.');
  passed.push('project deletion preserves task records');
  const archived = patchTask(assigned, 'task-stable', { pinned: false, archived: true });
  const restored = patchTask(archived, 'task-stable', { archived: false });
  assert(archived.tasks['task-stable'].archived && !restored.tasks['task-stable'].archived && !restored.tasks['task-stable'].pinned, 'Pin/archive must be reversible metadata only.');
  passed.push('pin archive and unarchive');
  assert(validatedCoworkUrl('https://example.com/task') && !validatedCoworkUrl('javascript:alert(1)') && validatedCoworkUrl('http://example.com/') && !validatedCoworkUrl('//example.com/') && !validatedCoworkUrl('https://user:secret@example.com/'), 'Unsafe URL must be rejected.');
  assert(!patchTask(assigned, 'task-stable', { coworkUrl: undefined }).tasks['task-stable'].coworkUrl, 'Saved URL must be removable.');
  passed.push('HTTPS URL validation and removal');
  const item: DriveItem = { Id: 'item-stable', Name: 'output.txt', Path: '/Documents/Cowork/task/outputs/output.txt', LastModified: '2026-10-05T00:00:00Z', ETag: 'revision-one' };
  const changes = new ChangeDetectionService();
  changes.observe([item]);
  assert(changes.state(item, assigned) === 'unreviewed', 'First discovery must not claim source creation.');
  const reviewed = changes.markSeen(item, assigned);
  assert(changes.state(item, reviewed) === 'seen', 'Review must store current fingerprint.');
  const changed = { ...item, ETag: 'revision-two' };
  assert(changes.state(changed, reviewed) === 'modified', 'Different fingerprint must be unseen.');
  assert(new ChangeDetectionService().state(changed, parseMetadata(serializeMetadata(reviewed))) === 'modified', 'Review state must survive repository restart.');
  assert(!changes.isUnseen({ Id: 'missing-evidence' }, reviewed), 'Missing evidence cannot imply a change.');
  passed.push('durable review and modified detection');
  const serialized = serializeMetadata(reviewed);
  assert(!serialized.includes('output.txt') && !serialized.includes(item.LastModified ?? 'not-present'), 'Metadata must not duplicate source filenames or timestamps.');
  assert(JSON.stringify(parseMetadata(serialized)) === JSON.stringify(reviewed), 'Metadata roundtrip must preserve permitted state.');
  passed.push('schema 2 serialization roundtrip and data minimization');
  const migrated = parseMetadata(JSON.stringify({ version: 1, tasks: { 'task-stable': { pinned: true } }, seen: { 'item-stable': 'revision-one' } }));
  assert(migrated.schemaVersion === 2 && migrated.seen['item-stable'] === fingerprint(item) && migrated.tasks['task-stable'].pinned, 'Version 1 must migrate without losing reviews.');
  passed.push('schema 1 migration');
  rejects(() => parseMetadata('{"schemaVersion":3}'), 'Unknown schema must be rejected.');
  rejects(() => parseMetadata('{"schemaVersion":2,"tasks":{"__proto__":{}}}'), 'Prototype key must be rejected.');
  rejects(() => parseMetadata('{"schemaVersion":2,"tasks":{"x":{"pinned":"yes"}}}'), 'Invalid flags must be rejected.');
  rejects(() => parseMetadata('{"schemaVersion":2,"projects":[{"id":"p","name":"x","color":"unknown"}]}'), 'Invalid project color must be rejected.');
  passed.push('malformed and future metadata protection');
  assert(classify(item, '/Documents/Cowork/task') === 'output' && classify({ ...item, Path: '/Documents/Cowork/task/inputs/source.csv' }, '/Documents/Cowork/task') === 'input' && classify({ ...item, Path: '/Documents/Cowork/task/report.pdf' }, '/Documents/Cowork/task') === 'unclassified' && classify(item, '/other-task') === 'unclassified' && classifyFolder('output') === 'output' && classifyFolder('reports') === 'unclassified', 'Classification must use explicit folder evidence only.');
  passed.push('input output classification boundaries');
  assert(skillSummary('---\nname: organize\ndescription: Organize notes\n---\n# Skill') === 'Organize notes', 'Frontmatter summary must parse.');
  assert(compareText('first\nold', 'first\nnew').length === 1, 'Comparison must identify differing lines.');
  passed.push('skill summary and non-destructive text comparison');
  const memoryOne = new InMemoryCompanionMetadataRepository(reviewed);
  const memoryTwo = new InMemoryCompanionMetadataRepository();
  const loaded = await memoryOne.load();
  loaded.document.tasks['task-stable'].pinned = false;
  assert((await memoryOne.load()).document.tasks['task-stable'].pinned, 'Repository must return isolated values.');
  assert(Object.keys((await memoryTwo.load()).document.tasks).length === 0, 'Separate repository instances must not leak state.');
  assert((await memoryOne.save(archived)).tasks['task-stable'].archived, 'Repository save must roundtrip state.');
  passed.push('in-memory persistence and instance isolation');
  const root: DriveItem = { Id: 'root', Name: 'task', Path: '/Documents/Cowork/task', IsFolder: true };
  const childItems = Array.from({ length: 41 }, (_, n): DriveItem => ({ Id: `f-${n}`, Name: `file-${n}.txt`, Path: `${root.Path}/file-${n}.txt` }));
  const files = new InMemoryCoworkTaskRepository([root, ...childItems, item], { 'item-stable': 'content' });
  const first = await files.list('root');
  const second = await files.list('root', first.nextToken);
  assert(first.items.length === 40 && second.items.length === 1 && !second.nextToken, 'Pagination must expose continuation without eagerly fetching.');
  assert((await files.read(item)) === 'content' && (await files.search(root.Path ?? '', 'file-')).length === 41, 'In-memory file methods must share the live contract.');
  const skills = new FolderSkillsRepository(files);
  const memory = new FolderMemoryRepository(files);
  assert(!(skills.versions.history || skills.versions.restore || skills.versions.lifecycle) && (await memory.read(item)) === 'content', 'Unsupported capabilities must remain non-destructive.');
  passed.push('repository contracts pagination and read-only extensions');

  // Layout discovery against the shape observed in this tenant: /Documents/Cowork/Tasks/<task>/input/<file>, no skills or memory folders.
  const F = (id: string, path: string, extra: Partial<DriveItem> = {}): DriveItem => ({ Id: id, Name: path.slice(path.lastIndexOf('/') + 1), Path: path, LastModified: '2026-10-01T00:00:00Z', ETag: id, ...extra });
  const D = (id: string, path: string) => F(id, path, { IsFolder: true });
  const tenant: DriveItem[] = [D('r', '/Documents/Cowork'), D('t', '/Documents/Cowork/Tasks')];
  for (let n = 0; n < 11; n++) { tenant.push(D(`task${n}`, `/Documents/Cowork/Tasks/task-${n}-2026-10-01`), D(`in${n}`, `/Documents/Cowork/Tasks/task-${n}-2026-10-01/input`), F(`file${n}`, `/Documents/Cowork/Tasks/task-${n}-2026-10-01/input/attachment-${n}.png`, { Size: 100 })); }
  const tenantLayout = await new CoworkDiscoveryService(new InMemoryCoworkTaskRepository(tenant)).discover('/Documents/Cowork');
  assert(tenantLayout.tasks.length === 11 && tenantLayout.containers.tasks.length === 1 && !tenantLayout.flatLayout, 'Tasks container must be descended, not shown as a task.');
  assert(tenantLayout.tasks.every(t => t.inspected && t.inputs === 1 && t.outputs === 0 && t.roleFolders.length === 1), 'Singular input folders must be classified and counted.');
  assert(tenantLayout.containers.skills.length === 0 && tenantLayout.skills.length === 0 && tenantLayout.memory.length === 0 && tenantLayout.issues.length === 0, 'Missing skills/memory folders are an empty state, not an error.');
  passed.push('discovery of the Tasks container layout without skills or memory');
  // Casing, nesting, flat fallback and per-path isolation.
  const mixed: DriveItem[] = [D('r', '/Documents/Cowork'), D('T', '/Documents/Cowork/TASKS'), D('a', '/Documents/Cowork/TASKS/alpha'), D('ao', '/Documents/Cowork/TASKS/alpha/Outputs'), F('o1', '/Documents/Cowork/TASKS/alpha/Outputs/report.md', { Size: 10, LastModified: '2026-10-02T00:00:00Z' }), F('o2', '/Documents/Cowork/TASKS/alpha/Outputs/old.md', { Size: 10, LastModified: '2026-09-01T00:00:00Z' }),
    D('S', '/Documents/Cowork/Skills'), D('s1', '/Documents/Cowork/Skills/recap'), F('s1d', '/Documents/Cowork/Skills/recap/skill.md', { Size: 50 }), D('s2', '/Documents/Cowork/Skills/group'), D('s2a', '/Documents/Cowork/Skills/group/nested'), F('s2d', '/Documents/Cowork/Skills/group/nested/SKILL.MD', { Size: 50 }), D('s3', '/Documents/Cowork/Skills/empty'),
    D('M', '/Documents/Cowork/MEMORY'), F('m1', '/Documents/Cowork/MEMORY/prefs.md', { Size: 5 }), D('m2', '/Documents/Cowork/MEMORY/deep'), F('m3', '/Documents/Cowork/MEMORY/deep/context.json', { Size: 5 }), D('C', '/Documents/Cowork/.config'), F('c1', '/Documents/Cowork/.config/settings.json', { Size: 5 }), F('rf', '/Documents/Cowork/notes.txt', { Size: 5 })];
  const mixedLayout = await new CoworkDiscoveryService(new InMemoryCoworkTaskRepository(mixed, { s1d: '---\ndescription: Recap meetings\n---', s2d: '# Nested skill\n\nDoes nested things.' })).discover('/Documents/Cowork');
  assert(mixedLayout.tasks.length === 1 && mixedLayout.tasks[0].outputs === 2 && mixedLayout.tasks[0].newestOutput?.Id === 'o1', 'Mixed-case containers and plural output folders must be recognised; newest output selected by timestamp.');
  assert(mixedLayout.skills.length === 2 && mixedLayout.skills.some(k => k.folder.Id === 's2a' && k.summary === 'Does nested things.') && mixedLayout.skills.some(k => k.summary === 'Recap meetings'), 'Skills must be discovered recursively with case-insensitive SKILL.md.');
  assert(mixedLayout.memory.length === 3 && mixedLayout.memory.filter(e => e.kind === 'config').length === 1 && mixedLayout.rootFiles.length === 1, 'Memory and config files must be listed recursively; root files kept separately.');
  assert(containerKind('Memories') === 'memory' && containerKind('tasks') === 'tasks' && containerKind('Projects') === undefined, 'Container matching must be case-insensitive and bounded.');
  const flat = await new CoworkDiscoveryService(new InMemoryCoworkTaskRepository([D('r', '/Documents/Cowork'), D('x', '/Documents/Cowork/plain-task')])).discover('/Documents/Cowork');
  assert(flat.flatLayout && flat.tasks.length === 1, 'Without a Tasks container, root folders are tasks.');
  class Flaky implements CoworkTaskRepository { constructor(private inner: CoworkTaskRepository) {} get(id: string) { return this.inner.get(id); } resolve(p: string) { return this.inner.resolve(p); } read(i: DriveItem) { return this.inner.read(i); } open(i: DriveItem) { return this.inner.open(i); } search(p: string, t: string) { return this.inner.search(p, t); } list(id: string, token?: string): Promise<FolderPage> { if (id === 'S') return Promise.reject(new Error('Folder Skills could not be listed: not found (404).')); return this.inner.list(id, token); } }
  const isolated = await new CoworkDiscoveryService(new Flaky(new InMemoryCoworkTaskRepository(mixed))).discover('/Documents/Cowork');
  assert(isolated.tasks.length === 1 && isolated.memory.length === 3 && isolated.skills.length === 0 && isolated.issues.length === 1 && isolated.issues[0].scope === 'skills' && isolated.issues[0].path === '/Documents/Cowork/Skills', 'A failing container must surface a path-specific issue without failing other sections.');
  passed.push('case-insensitive containers, nested skills, flat fallback and per-path error isolation');
  // Connector content shapes: the bootstrap file must parse whether it arrives as text, parsed JSON, a binary envelope or bare base64.
  const bootstrap = '{\n  "schemaVersion": 2,\n  "projects": [],\n  "tasks": {},\n  "seen": {}\n}\n';
  const b64 = btoa(bootstrap);
  const bytes = new TextEncoder().encode(bootstrap);
  const byteMap = Object.fromEntries([...bytes].map((v, i) => [String(i), v])) as Record<string, number>;
  for (const shape of [bootstrap, JSON.parse(bootstrap), { '$content-type': 'application/octet-stream', '$content': b64 }, b64, bytes, bytes.buffer, [...bytes], byteMap, new Blob([bootstrap]), JSON.stringify(byteMap), JSON.stringify({ '$content': b64 })]) assert(parseMetadata(await decodeFileContent(shape)).schemaVersion === 2, 'Bootstrap metadata must load from every connector content shape.');
  assert(await decodeFileContent('# Plain markdown\n\nText.') === '# Plain markdown\n\nText.' && await decodeFileContent('abcd') === 'abcd' && await decodeFileContent({ '$content': btoa('name: x') }) === 'name: x', 'Plain text must never be mistaken for base64; envelopes must be unwrapped.');
  assert((await decodeFileContent({ 0: 1, 1: 'x' })).includes('"1": "x"'), 'A non-byte object must still be treated as parsed JSON.');
  rejects(() => parseMetadata(JSON.stringify({ '$content-type': 'x', '$content': 'y' })), 'An undecoded envelope must still be rejected with a diagnostic.');
  passed.push('connector content shapes decode to the bootstrap schema');

  // Hash routes: parse/serialize round trips, canonicalisation, invalid hashes, and the Back/Forward model.
  const oddId = 'b!x/y+z=01ABC%20';
  const taskRoute = parseHash(taskHash(oddId));
  assert(taskRoute?.kind === 'task' && taskRoute.taskId === oddId && serializeRoute(taskRoute) === taskHash(oddId), 'Task hash must round-trip any stable item ID.');
  for (const section of sections) { const r = parseHash(sectionHash(section)); assert(r?.kind === 'section' && r.section === section && serializeRoute(r) === `#/${section}`, `Section hash ${section} must round-trip.`); }
  assert(parseHash('') === undefined && parseHash('#') === undefined && parseHash('#/') === undefined && canonicalHash('') === undefined, 'An empty hash means the default route (replaced, not pushed).');
  assert(canonicalHash('#tasks') === '#/tasks' && canonicalHash('#/Tasks/') === '#/tasks' && canonicalHash('#/tasks//abc/') === '#/tasks/abc' && canonicalHash('#/skills') === '#/skills', 'Non-canonical hashes must canonicalise to a valid route.');
  assert(parseHash('#/nope')?.kind === 'not-found' && parseHash('#/tasks/%E0%A4%A')?.kind === 'not-found' && parseHash('#/tasks/a/b')?.kind === 'not-found' && parseHash('#/tasks/%20')?.kind === 'not-found', 'Unknown sections and malformed task IDs must be not-found routes, never throws.');
  assert(listSectionFor(parseHash('#/archived')) === 'archived' && listSectionFor(parseHash('#/skills')) === 'tasks' && listSectionFor(parseHash(taskHash('x'))) === 'tasks', 'The breadcrumb list section falls back to Tasks.');
  const history = new HashHistoryModel('');
  assert(history.hash === DEFAULT_HASH && history.route?.kind === 'section' && backTarget(history.state).kind === 'hash', 'First load with an empty hash lands on #/dashboard with no in-app history.');
  history.push(sectionHash('tasks')); history.push(taskHash('task-stable')); history.push(sectionHash('skills'));
  assert(history.entries.length === 4 && backTarget(history.state).kind === 'history', 'User navigation must push history entries.');
  history.back(); const afterBack = parseHash(history.hash); assert(afterBack?.kind === 'task' && afterBack.taskId === 'task-stable', 'Back from #/skills returns to the task page.');
  history.back(); assert(history.hash === sectionHash('tasks'), 'Back again returns to #/tasks.');
  history.forward(); history.forward(); assert(history.hash === sectionHash('skills'), 'Forward twice returns to #/skills.');
  const deep = new HashHistoryModel(taskHash('task-stable'));
  assert(deep.route?.kind === 'task' && backTarget(deep.state).kind === 'hash' && backTarget(deep.state).kind === 'hash' && (backTarget(deep.state) as { hash: string }).hash === '#/tasks', 'A direct task deep link resolves immediately and its Back falls back to #/tasks.');
  assert(resolveTaskRoute('task-stable', false, () => false) === 'loading' && resolveTaskRoute('task-stable', true, id => id === 'task-stable') === 'found' && resolveTaskRoute('missing', true, () => false) === 'not-found', 'Task resolution is loading until the layout exists, then found or not-found.');
  const listState = { ...defaultListState, search: 'flight', taskFilter: 'pinned' as const, projectFilter: 'project-stable', sort: 'name' as const, memoryFilter: 'm', activityUnseen: true, scrollY: 420 };
  assert(JSON.stringify(decodeListState(encodeListState(listState))) === JSON.stringify(listState), 'List state (search, filters, sort, scroll) must round-trip for Back restoration.');
  assert(decodeListState('{"view":"Archived","taskFilter":"x","scrollY":-5}').taskFilter === 'all' && decodeListState('garbage').sort === 'modified' && decodeListState(null).scrollY === 0, 'Corrupt or legacy list state must fall back to safe defaults.');
  passed.push('hash routes, Back/Forward model, deep links, not-found and list-state restoration');

  // Output-first workspace: outputs are primary and newest first; inputs secondary; latest output identified.
  const ws = partitionTaskFiles({ files: [
    { item: F('o-old', '/t/output/a.md', { LastModified: '2026-09-01T00:00:00Z' }), role: 'output', relativePath: 'a.md' }, { item: F('i-new', '/t/input/z.csv', { LastModified: '2026-10-05T00:00:00Z' }), role: 'input', relativePath: 'z.csv' },
    { item: F('o-new', '/t/output/b.md', { LastModified: '2026-10-04T00:00:00Z' }), role: 'output', relativePath: 'b.md' }, { item: F('o-mid', '/t/output/c.md', { LastModified: '2026-10-02T00:00:00Z' }), role: 'output', relativePath: 'c.md' }, { item: F('x', '/t/readme.txt'), role: 'unclassified', relativePath: '' },
  ] });
  assert(ws.outputs.map(o => o.Id).join(',') === 'o-new,o-mid,o-old' && ws.inputs.length === 1 && ws.other.length === 1 && ws.latestOutput?.Id === 'o-new', 'Outputs must sort newest first with the latest output selected; inputs and other files stay separate.');
  assert(partitionTaskFiles(undefined).outputs.length === 0 && partitionTaskFiles(undefined).latestOutput === undefined, 'A task without inspection has an honest empty workspace.');
  assert(fileType({ Name: 'a.docx' }) === 'Word document' && fileType({ Name: 'x.PNG' }) === 'PNG image' && fileType({ Name: 'noext', MediaType: 'application/octet-stream' }) === 'File' && fileType({ Name: 'f', IsFolder: true }) === 'Folder', 'File type labels must derive from extension/media type.');
  passed.push('output-first newest-first workspace partitioning');

  // Direct Open flow: connector link first, then one navigation attempt with the REAL url; never a pre-opened blank tab.
  const attempts: string[] = [];
  const cache = new Map<string, string>();
  let calls = 0;
  const linkRepo = { open: async (i: DriveItem) => { calls++; if (i.Id === 'bad') throw new Error('A browser link for bad.md could not be created: access denied (403).'); return `https://contoso-my.sharepoint.com/:t:/g/${i.Id}`; } };
  const good: DriveItem = { Id: 'good', Name: 'report.md' };
  const allow = { openTab: (url: string) => { attempts.push(url); return true; }, cache };
  const firstOpen = await openFileInNewTab(good, linkRepo, allow);
  assert(firstOpen.status === 'opened' && attempts.length === 1 && attempts[0] === 'https://contoso-my.sharepoint.com/:t:/g/good', 'Navigation must be attempted only with the resolved link; no blank tab is ever opened.');
  const secondOpen = await openFileInNewTab(good, linkRepo, allow);
  assert(secondOpen.status === 'opened' && calls === 1, 'A cached link must open without another connector call.');
  const popupBlocked = await openFileInNewTab({ Id: 'other', Name: 'x.md' }, linkRepo, { openTab: (url) => { attempts.push(url); return false; }, cache });
  assert(popupBlocked.status === 'blocked' && popupBlocked.reason === 'popup-blocked' && popupBlocked.url.endsWith('/other') && cache.get('other') === popupBlocked.url, 'A blocked popup must keep the resolved link (cached) for a user-click anchor.');
  const sandboxed = await openFileInNewTab({ Id: 'third', Name: 'y.md' }, linkRepo, { openTab: () => { throw new Error('Unsafe attempt to initiate navigation'); }, cache });
  assert(sandboxed.status === 'blocked' && sandboxed.reason === 'navigation-refused' && sandboxed.url.endsWith('/third') && cache.has('third'), 'A sandbox navigation refusal is reported as blocked, never as a connector failure, and the link is retained.');
  const before = attempts.length;
  const failedOpen = await openFileInNewTab({ Id: 'bad', Name: 'bad.md' }, linkRepo, allow);
  assert(failedOpen.status === 'failed' && failedOpen.message.includes('403') && attempts.length === before && !cache.has('bad'), 'A connector failure must be reported distinctly, attempt no navigation and cache nothing.');
  assert(attempts.every(u => u.startsWith('https://')), 'No about:blank or empty navigation may ever be attempted.');
  const demoFiles = new InMemoryCoworkTaskRepository([F('d1', '/Documents/Cowork/Tasks/t/output/a.md')], { d1: 'hello' });
  if (typeof URL.createObjectURL === 'function') assert((await demoFiles.open(F('d1', '/Documents/Cowork/Tasks/t/output/a.md'))).startsWith('blob:'), 'Demo mode opens sample content as a blob: URL, never an invented OneDrive URL.');
  let demoMissing = false; try { await demoFiles.open(F('d2', '/x')); } catch { demoMissing = true; } assert(demoMissing, 'Demo mode must refuse to open a sample without content.');
  const localHits = searchLocalFiles([F('a', '/x/Report-Final.md', { LastModified: '2026-10-01T00:00:00Z' }), F('b', '/x/report-draft.md', { LastModified: '2026-10-03T00:00:00Z' }), D('c', '/x/Reports'), F('d', '/x/other.txt')], 'rep');
  assert(localHits.map(h => h.Id).join(',') === 'b,a,c' && searchLocalFiles(localHits, 'r').length === 0, 'Local filename search must be case-insensitive, files newest first then folders, and need 2+ characters.');
  passed.push('local-only filename search over the last read');
  // Tree and Flat output views are projections of the same files.
  const nf: TaskFile[] = [
    { item: F('r1', '/t/output/summary.md', { LastModified: '2026-10-03T00:00:00Z' }), role: 'output', relativePath: 'summary.md' },
    { item: F('q1', '/t/output/reports/q1/revenue.csv', { LastModified: '2026-10-05T00:00:00Z' }), role: 'output', relativePath: 'reports/q1/revenue.csv' },
    { item: F('q2', '/t/output/reports/q1/notes.md', { LastModified: '2026-10-01T00:00:00Z' }), role: 'output', relativePath: 'reports/q1/notes.md' },
    { item: F('d1', '/t/output/drafts/intro.md', { LastModified: '2026-10-04T00:00:00Z' }), role: 'output', relativePath: 'drafts/intro.md' },
    { item: F('in1', '/t/input/brief.md', { LastModified: '2026-10-06T00:00:00Z' }), role: 'input', relativePath: 'brief.md' },
  ];
  const nd: TaskFolder[] = [
    { item: D('f-reports', '/t/output/reports'), role: 'output', relativePath: 'reports', parentRelativePath: '' },
    { item: D('f-q1', '/t/output/reports/q1'), role: 'output', relativePath: 'reports/q1', parentRelativePath: 'reports' },
    { item: D('f-drafts', '/t/output/drafts'), role: 'output', relativePath: 'drafts', parentRelativePath: '' },
    { item: D('f-empty', '/t/output/empty'), role: 'output', relativePath: 'empty', parentRelativePath: '' },
  ];
  const tree = buildRoleTree(nf, nd, 'output');
  assert(tree.fileCount === 4 && tree.files.map(f => f.item.Id).join() === 'r1' && tree.folders.map(f => f.name).join() === 'drafts,empty,reports', 'Tree root must hold direct files and sorted top-level folders with the total file count.');
  const reports = tree.folders.find(f => f.name === 'reports')!;
  assert(reports.id === 'f-reports' && reports.fileCount === 2 && reports.folders.length === 1 && reports.folders[0].id === 'f-q1' && reports.folders[0].files.map(f => f.item.Id).join() === 'q1,q2' && reports.newestModified === '2026-10-05T00:00:00Z', 'Nested folders must keep hierarchy, per-folder counts and newest-first files.');
  assert(tree.folders.find(f => f.name === 'empty')!.fileCount === 0, 'An empty observed folder is shown with zero files, not hidden.');
  const flatOut = flattenRoleFiles(nf, 'output');
  assert(flatOut.map(f => f.item.Id).join() === 'q1,d1,r1,q2' && flatOut.map(f => f.relativeDir).join('|') === 'reports/q1|drafts||reports/q1' && flatOut[0].relativePath === 'reports/q1/revenue.csv', 'Flat view must be newest first with the relative output path.');
  assert(collectTreeFiles(tree).map(f => f.item.Id).sort().join() === flatOut.map(f => f.item.Id).sort().join() && !flatOut.some(f => f.item.Id === 'in1'), 'Tree and Flat must cover exactly the same output files (inputs excluded).');
  let expanded: ReadonlySet<string> = new Set();
  expanded = toggleExpanded(expanded, 'f-reports'); assert(expanded.has('f-reports') && !expanded.has('f-q1'), 'Expanding a folder does not expand its children.');
  expanded = toggleExpanded(expanded, 'f-reports'); assert(!expanded.has('f-reports'), 'Toggling again collapses.');
  assert(allFolderIds(tree).join() === 'f-drafts,f-empty,f-reports,f-q1', 'Expand-all must address every nested folder id.');
  assert(decodeOutputsView('flat') === 'flat' && decodeOutputsView('tree') === 'tree' && decodeOutputsView('junk') === 'tree' && decodeOutputsView(null) === 'tree', 'The remembered outputs view must decode safely with Tree as default.');
  passed.push('outputs Tree/Flat: hierarchy, counts, flat relative paths, identical coverage, expand/collapse, view persistence');

  // Skeleton shape and the async controller (spinner cleanup, no duplicate action).
  assert(skeletonSpec.taskRows >= 4 && skeletonSpec.activityItems >= 3 && skeletonSpec.outputRows >= 2 && skeletonSpec.inputRows >= 1 && skeletonSpec.taskRowHeight.startsWith('h-[') && skeletonSpec.fileRowHeight.startsWith('h-['), 'Skeletons must mirror task rows, activity, outputs and inputs with fixed row heights.');
  const controller = new AsyncActionController<string>();
  let runs = 0; let release: (v: string) => void = () => {};
  const slow = () => new Promise<string>(resolve => { runs++; release = resolve; });
  const p1 = controller.run('k', slow); const p2 = controller.run('k', slow);
  assert(controller.isPending('k') && runs === 1 && (await p2).status === 'pending', 'A second trigger while pending must not start a duplicate action.');
  release('ok'); const r1 = await p1;
  assert(r1.status === 'done' && !controller.isPending('k') && controller.outcome('k').status === 'done', 'Success must clear pending and keep the outcome.');
  const r2 = await controller.run('k', async () => { throw new Error('boom'); });
  assert(r2.status === 'failed' && r2.message === 'boom' && !controller.isPending('k'), 'Failure must clear pending and surface the message.');
  controller.dismiss('k'); assert(controller.outcome('k').status === 'idle', 'Dismiss resets the outcome.');
  passed.push('skeleton spec, spinner cleanup on success and failure, no duplicate async action');

  // Change labels: New = never seen; Updated = seen before and fingerprint changed; nothing for seen/unknown.
  assert(changeLabel('unreviewed') === 'New' && changeLabel('modified') === 'Updated' && changeLabel('seen') === undefined && changeLabel('unknown') === undefined, 'Change labels must derive New/Updated from seen-state only.');
  const labelled: DriveItem = { Id: 'lbl', Name: 'x.md', ETag: 'v1', LastModified: '2026-10-01T00:00:00Z' };
  const seenDoc = new ChangeDetectionService().markSeen(labelled, emptyMetadata());
  assert(changeLabel(new ChangeDetectionService().state(labelled, emptyMetadata())) === 'New' && changeLabel(new ChangeDetectionService().state(labelled, seenDoc)) === undefined && changeLabel(new ChangeDetectionService().state({ ...labelled, ETag: 'v2' }, seenDoc)) === 'Updated', 'An item is New until seen, then Updated only when its fingerprint changes.');
  passed.push('New vs Updated label derivation');

  // Project assignment: single row, bulk, mixed, unassign, create-and-assign — each exactly one metadata document.
  const base = putProject(putProject(emptyMetadata(), { id: 'p-web', name: 'Website', color: 'blue' }), { id: 'p-mkt', name: 'Marketing', color: 'green' });
  const single = assignTasks(base, ['t1'], 'p-web');
  assert(single.tasks.t1.projectId === 'p-web' && base.tasks.t1 === undefined, 'Single-row assignment must set the project immutably.');
  const bulk = assignTasks(single, ['t1', 't2', 't3', 't3'], 'p-mkt');
  assert(bulk.tasks.t1.projectId === 'p-mkt' && bulk.tasks.t2.projectId === 'p-mkt' && Object.keys(bulk.tasks).length === 3, 'Bulk assignment must apply once per unique stable ID in one document.');
  const mixedDoc = assignTasks(bulk, ['t2'], 'p-web');
  assert(assignmentSummary(mixedDoc, ['t1', 't2', 't3']).mixed && assignmentSummary(mixedDoc, ['t1', 't3']).common === 'p-mkt' && assignmentSummary(mixedDoc, ['t9']).common === undefined, 'Assignment summary must report mixed vs common projects.');
  const unassigned = assignTasks(mixedDoc, ['t1', 't2'], undefined);
  assert(unassigned.tasks.t1.projectId === undefined && unassigned.tasks.t2.projectId === undefined && unassigned.tasks.t3.projectId === 'p-mkt', 'Bulk unassign must clear only the selected tasks.');
  const created = createProjectAndAssign(unassigned, { id: 'p-new', name: 'Launch', color: 'amber' }, ['t1', 't3']);
  assert(created.projects.length === 3 && created.tasks.t1.projectId === 'p-new' && created.tasks.t3.projectId === 'p-new' && created.tasks.t2.projectId === undefined, 'Create-and-assign must add the project and assign the selection in one document.');
  rejects(() => assignTasks(base, ['t1'], 'p-missing'), 'Assigning to a deleted project must be refused before any write.');
  assert(assignTasks(base, [], 'p-web') === base, 'An empty selection is a no-op.');
  assert(JSON.stringify(parseMetadata(serializeMetadata(created))) === JSON.stringify(created), 'The assigned document must round-trip through the persisted format.');
  passed.push('project assignment: single, bulk, mixed, unassign, create-and-assign in one document');

  // Selection: session UI state over stable IDs; stable across filtering, pruned only when tasks disappear.
  let sel: ReadonlySet<string> = new Set();
  sel = toggleSelected(sel, 'a'); sel = toggleSelected(sel, 'b'); sel = toggleSelected(sel, 'a');
  assert(sel.has('b') && !sel.has('a'), 'Toggle must add and remove.');
  sel = selectAll(sel, ['c', 'd', 'b']);
  assert(sel.size === 3 && visibleSelectionState(sel, ['b', 'c', 'd']) === 'all' && visibleSelectionState(sel, ['b', 'z']) === 'some' && visibleSelectionState(sel, ['z']) === 'none' && visibleSelectionState(sel, []) === 'none', 'Select-all-visible must cover the filtered list and report all/some/none.');
  const filteredAway = pruneSelection(sel, new Set(['b', 'c', 'd', 'z']));
  assert(filteredAway.size === 3, 'Selected tasks hidden by a filter stay selected while still discovered.');
  assert(pruneSelection(sel, new Set(['b'])).size === 1, 'Selected tasks no longer discovered are pruned.');
  sel = deselectAll(sel, ['c', 'd']);
  assert(sel.size === 1 && sel.has('b'), 'Deselect-visible removes only the visible IDs.');
  passed.push('task selection: toggle, select all visible, filtered stability, prune, deselect');

  // Keyed metadata actions: one write per action, duplicates refused while pending, selection kept on failure and cleared on success.
  const writeLog: { docs: CompanionMetadata[] } = { docs: [] };
    let failNext = false;
  const repo = { save: async (doc: CompanionMetadata) => { if (failNext) { failNext = false; throw new Error('OneDrive update failed: HTTP 423'); } writeLog.docs.push(doc); return doc; } };
  const actions = new AsyncActionController<CompanionMetadata>();
  const selectionBox: { current: ReadonlySet<string> } = { current: new Set(['t1', 't2']) };
  const written = () => writeLog.docs.length; const selectedCount = () => selectionBox.current.size;
  const bulkAssign = (doc: CompanionMetadata) => actions.run('bulk-assign', async () => { const next = assignTasks(doc, selectionBox.current, 'p-web'); const saved = await repo.save(next); selectionBox.current = new Set(); return saved; });
  failNext = true;
  const failedBulk = await bulkAssign(base);
  assert(failedBulk.status === 'failed' && failedBulk.message.includes('423') && selectedCount() === 2 && written() === 0 && !actions.isPending('bulk-assign'), 'A failed bulk write keeps the selection, writes nothing and clears pending.');
  const inflight = bulkAssign(base); const duplicate = await bulkAssign(base);
  assert(duplicate.status === 'pending', 'A duplicate bulk request while pending must be refused.');
  const okBulk = await inflight;
  assert(okBulk.status === 'done' && written() === 1 && writeLog.docs[0].tasks.t1.projectId === 'p-web' && writeLog.docs[0].tasks.t2.projectId === 'p-web' && selectedCount() === 0, 'A successful bulk assignment is exactly one write and clears the selection.');
  passed.push('bulk persistence: one write, duplicate prevention, failure keeps selection, success clears it');

  // Cowork task URL: real Cowork URLs with query and #/task fragments are kept verbatim; everything else is rejected inline.
  const real = 'https://m365.cloud.microsoft/chat/?auth=2&titleId=abc123#/task/19%3Aabc_def%40thread.v2';
  const okUrl = validateCoworkTaskUrl(`  ${real}\n`);
  assert(okUrl.ok && okUrl.url === real, 'A real Cowork task URL must be accepted with query and hash preserved and whitespace trimmed.');
  assert(validateCoworkTaskUrl('https://copilot.cloud.microsoft/?x=1#/task/x').ok && validateCoworkTaskUrl('http://m365.cloud.microsoft/x').ok && validateCoworkTaskUrl('https://www.office.com/launch/cowork?x=1').ok, 'Other Microsoft Copilot/Cowork hosts and http are accepted.');
  for (const [bad, reason] of [['', 'empty'], ['   ', 'empty'], ['not a url', 'malformed'], ['m365.cloud.microsoft/chat', 'malformed'], ['javascript:alert(1)', 'scheme'], ['ftp://m365.cloud.microsoft/x', 'scheme'], ['https://example.com/#/task/x', 'host'], ['https://m365.cloud.microsoft.evil.com/', 'host'], ['https://user:pw@m365.cloud.microsoft/', 'credentials'], [`https://m365.cloud.microsoft/${'a'.repeat(5000)}`, 'too-long']] as const) {
    const r = validateCoworkTaskUrl(bad); assert(!r.ok && r.reason === reason, `Must reject ${JSON.stringify(bad).slice(0, 40)} as ${reason}, got ${JSON.stringify(r)}`);
  }
  const withUrl = patchTask(base, 't1', { coworkUrl: real });
  assert(withUrl.tasks.t1.coworkUrl === real && parseMetadata(serializeMetadata(withUrl)).tasks.t1.coworkUrl === real, 'The saved URL must persist verbatim.');
  const invalidAttempt = validateCoworkTaskUrl('https://example.com/');
  assert(!invalidAttempt.ok && withUrl.tasks.t1.coworkUrl === real, 'An invalid new value never touches the previously saved URL.');
  const removed = patchTask(withUrl, 't1', { coworkUrl: undefined });
  assert(removed.tasks.t1.coworkUrl === undefined && validatedCoworkUrl(removed.tasks.t1.coworkUrl ?? '') === undefined && validatedCoworkUrl(withUrl.tasks.t1.coworkUrl ?? '') === real, 'Remove clears the link; Open in Cowork is gated on the persisted valid URL only.');
  passed.push('Cowork task URL: real URLs kept verbatim, invalid inputs rejected without writes, remove and Open gating');

  // Keyboard focus return: pill → menu → "Create new project…" → dialog → (Escape | Cancel | Close | success) → focus is back on the SAME pill.
  const focusLog: { current?: FakeControl } = {};
  class FakeControl { focused = false; constructor(public name: string, public isConnected = true) {} focus() { focusLog.current = this; this.focused = true; } }
  const lastFocused = (): FakeControl | undefined => focusLog.current;
  for (const origin of ['row:task-stable', 'bulk-assign', 'header:task-stable']) {
    for (const reason of dialogCloseReasons) {
      focusLog.current = undefined;
      const pill = new FakeControl(origin);
      const body = new FakeControl('body');
      const flow = new FocusReturn<FakeControl>();
      flow.capture(pill, () => body);
      body.focus(); // Radix would leave focus on <body> after the menu closed
      const restored = flow.restore();
      const received = lastFocused();
      assert(restored === pill && received === pill && received !== undefined && received.focused, `After ${reason} the ${origin} pill must regain focus (got ${received ? received.name : 'nothing'}).`);
      assert(flow.target === undefined, 'The remembered origin is cleared after one restore.');
    }
  }
  const gone = new FakeControl('row:removed', false); const content = new FakeControl('companion-content');
  const fallbackFlow = new FocusReturn<FakeControl>(); fallbackFlow.capture(gone, () => content);
  assert(fallbackFlow.restore() === content && content.focused, 'If the originating pill left the document (e.g. task filtered out), focus goes to the content fallback, never to <body>.');
  const noOrigin = new FocusReturn<FakeControl>(); noOrigin.capture(null, () => content);
  assert(noOrigin.restore() === content, 'A missing origin still restores to the fallback.');
  // Replacement-node case: React re-rendered the row, so the captured node is disconnected; the equivalent pill with the
  // same stable key is connected and must receive focus — its aria-label equals the originating pill's label exactly.
  class FakePill extends FakeControl { constructor(name: string, public key: string, public ariaLabel: string, isConnected = true) { super(name, isConnected); } }
  for (const [scope, id] of [['row', 'task-stable'], ['bulk', ''], ['header', 'task-stable']] as const) {
    for (const reason of dialogCloseReasons) {
      const key = pillFocusKey(scope, id);
      const label = scope === 'bulk' ? 'Project: Assign to: Unassigned. Change project for 2 tasks' : 'Project: Unassigned. Change project for this task';
      const oldPill = new FakePill(`${scope}-old`, key, label, false);           // replaced by a re-render
      const newPill = new FakePill(`${scope}-new`, key, label, true);            // the current equivalent in the document
      const content = new FakeControl('companion-content');
      const dom = new Map<string, FakePill>([[key, newPill], [pillFocusKey('row', 'other'), new FakePill('other', pillFocusKey('row', 'other'), 'Project: Website. Change project for this task')]]);
      const flow = new FocusReturn<FakeControl>(); flow.capture({ node: oldPill, key }, () => content);
      const restored = flow.restore(k => dom.get(k));
      assert(restored === newPill && newPill.focused && !oldPill.focused && !content.focused, `After ${reason}, a replaced ${scope} pill must be re-resolved by its stable key, not the fallback.`);
      assert((restored as FakePill).ariaLabel === label, 'The re-resolved pill carries the exact originating aria-label.');
    }
  }
  const neither = new FocusReturn<FakeControl>(); const content2 = new FakeControl('companion-content');
  neither.capture({ node: new FakePill('gone', pillFocusKey('row', 'x'), 'l', false), key: pillFocusKey('row', 'x') }, () => content2);
  assert(neither.restore(() => undefined) === content2, 'Only when neither the node nor a keyed equivalent exists does focus go to the content fallback.');
  assert(pillFocusKey('row', 'a') !== pillFocusKey('header', 'a') && pillFocusKey('bulk') === 'pill:bulk', 'Row, header and bulk pills have distinct stable keys.');
  passed.push('keyboard focus return to the originating row/bulk/header pill after Escape, Cancel, Close and successful create, including a replaced trigger node');

  // Demo-mode preference: missing → Demo (default), explicit false → Live, explicit true → Demo; never materialised by itself.
  const fullDoc = patchTask(putProject(emptyMetadata(), { id: 'p-web', name: 'Website', color: 'blue' }), 'task-stable', { projectId: 'p-web', pinned: true, archived: false, coworkUrl: 'https://m365.cloud.microsoft/chat/#/task/x' });
  const fullSeen = new ChangeDetectionService().markSeen(item, fullDoc);
  assert(demoModeOf(undefined) === true && demoModeOf(fullSeen) === true && demoModeOf(parseMetadata('{"schemaVersion":2}')) === true, 'A missing preference means Demo mode.');
  assert(demoModeOf(withDemoMode(fullSeen, false)) === false && demoModeOf(withDemoMode(fullSeen, true)) === true, 'Explicit false selects Live; explicit true selects Demo.');
  assert(!serializeMetadata(fullSeen).includes('"preferences"') && !JSON.stringify(parseMetadata(serializeMetadata(fullSeen))).includes('preferences'), 'The default is never written: a document without a preference stays without one.');
  rejects(() => parseMetadata('{"schemaVersion":2,"preferences":{"demoMode":"yes"}}'), 'A non-boolean demoMode is rejected.');
  // Explicit changes persist across repository reload and preserve every other field and unknown properties.
  const prefRepo = new InMemoryCompanionMetadataRepository(fullSeen);
  const live = await prefRepo.save(withDemoMode((await prefRepo.load()).document, false));
  const reloaded = (await new InMemoryCompanionMetadataRepository(live).load()).document;
  assert(demoModeOf(reloaded) === false && reloaded.projects.length === 1 && reloaded.tasks['task-stable'].pinned && reloaded.tasks['task-stable'].projectId === 'p-web' && reloaded.tasks['task-stable'].coworkUrl === 'https://m365.cloud.microsoft/chat/#/task/x' && reloaded.seen[item.Id] === fullSeen.seen[item.Id], 'Saving the preference keeps projects, assignments, pins, URLs and seen state intact across reload.');
  const foreign = parseMetadata(JSON.stringify({ schemaVersion: 2, projects: [], tasks: {}, seen: {}, preferences: { demoMode: false, theme: 'contrast', nested: { a: 1 } }, futureSetting: { enabled: true }, note: 'kept' }));
  const foreignBack = JSON.parse(serializeMetadata(withDemoMode(foreign, true))) as Record<string, unknown>;
  assert(JSON.stringify((foreignBack.preferences as Record<string, unknown>).nested) === '{"a":1}' && (foreignBack.preferences as Record<string, unknown>).theme === 'contrast' && JSON.stringify(foreignBack.futureSetting) === '{"enabled":true}' && foreignBack.note === 'kept' && (foreignBack.preferences as Record<string, unknown>).demoMode === true, 'Unknown preferences and top-level properties survive a round trip and a demoMode change.');
  // Persistence failure: the UI value rolls back to the saved document and the error is announced; success flips the saved value.
  let failPref = true;
  const flakyPrefs = { save: async (doc: CompanionMetadata) => { if (failPref) { failPref = false; throw new Error('OneDrive update failed: HTTP 423'); } return doc; } };
  const toggle = new AsyncActionController<CompanionMetadata>();
  const prefState = { saved: fullSeen, optimistic: undefined as boolean | undefined, announced: '' };
  const setDemo = async (value: boolean) => { prefState.optimistic = value; const r = await toggle.run('demo-mode', () => flakyPrefs.save(withDemoMode(prefState.saved, value))); prefState.optimistic = undefined; if (r.status === 'done') prefState.saved = r.value; else if (r.status === 'failed') prefState.announced = `Demo mode was not changed: ${r.message}`; return r; };
  const failedToggle = await setDemo(false);
  assert(failedToggle.status === 'failed' && demoModeOf(prefState.saved) === true && prefState.optimistic === undefined && prefState.announced.includes('423') && !toggle.isPending('demo-mode'), 'A failed save rolls the switch back to the saved state (Demo) and announces the error.');
  const okToggle = await setDemo(false);
  assert(okToggle.status === 'done' && demoModeOf(prefState.saved) === false, 'A successful save flips the saved preference to Live.');
  passed.push('Demo-mode preference: missing→Demo, explicit true/false, no default write, persistence across reload, unknown-property preservation, failure rollback');

  // No OneDrive content access while Demo is active: the demo bundle never touches the live repositories.
  const liveCalls: string[] = [];
  const spy = (name: string) => () => { liveCalls.push(name); throw new Error(`live ${name} must not be called in Demo mode`); };
  const liveTasks: CoworkTaskRepository = { get: spy('get'), resolve: spy('resolve'), list: spy('list'), read: spy('read'), open: spy('open'), search: spy('search') } as unknown as CoworkTaskRepository;
  const liveBundle = createRepositories(liveTasks, new InMemoryCompanionMetadataRepository());
  const selectBundle = (demo: boolean) => (demo ? createDemoRepositories() : liveBundle);
  const demoBundle = selectBundle(demoModeOf(undefined));
  const demoLayout = await demoBundle.discovery.discover('/Documents/Cowork');
  await demoBundle.tasks.read(demoLayout.tasks[0].files[0].item); await demoBundle.skills.list('/Documents/Cowork/skills'); await demoBundle.memory.list('/Documents/Cowork/memory'); await demoBundle.metadata.save((await demoBundle.metadata.load()).document!);
  assert(liveCalls.length === 0 && demoLayout.tasks.length === 4, 'Discovery, reads, skills, memory and demo metadata saves make no live OneDrive content calls while Demo is active.');
  assert(selectBundle(false) === liveBundle, 'Explicit false selects the live bundle.');
  passed.push('Demo mode isolates all Cowork content access from OneDrive');

  // Compact navigation: every destination is reachable — primary bar + overflow menu cover the sections exactly once.
  const split = splitNavigation(sections, 3);
  assert(split.primary.length === 3 && split.overflow.length === sections.length - 3 && [...split.primary, ...split.overflow].join() === sections.join() && new Set([...split.primary, ...split.overflow]).size === sections.length, 'Primary + More must cover all seven sections exactly once.');
  assert(splitNavigation(sections, 99).overflow.length === 0 && splitNavigation(sections, 0).primary.length === 0, 'Split bounds are clamped.');
  passed.push('compact navigation exposes every destination');

  // Appearance: default/invalid → system, explicit values persist with every other field and unknown properties intact, no default write.
  assert(appearanceOf(undefined) === 'system' && appearanceOf(fullSeen) === 'system' && parseAppearance('LIGHT') === 'system' && parseAppearance(42) === 'system' && parseAppearance('dark') === 'dark', 'Missing or invalid appearance resolves to system.');
  assert(!serializeMetadata(fullSeen).includes('appearance'), 'The system default is never written.');
  const darkDoc = withAppearance(withDemoMode(fullSeen, false), 'dark');
  const darkReload = (await new InMemoryCompanionMetadataRepository(darkDoc).load()).document;
  assert(appearanceOf(darkReload) === 'dark' && demoModeOf(darkReload) === false && darkReload.projects.length === 1 && darkReload.tasks['task-stable'].coworkUrl === 'https://m365.cloud.microsoft/chat/#/task/x' && darkReload.seen[item.Id] === fullSeen.seen[item.Id], 'Saving appearance keeps Demo mode, projects, assignments, URLs and seen state across reload.');
  const weird = parseMetadata(JSON.stringify({ schemaVersion: 2, preferences: { appearance: 'sepia', keep: [1, 2] }, extra: true }));
  assert(appearanceOf(weird) === 'system' && JSON.parse(serializeMetadata(weird)).preferences.appearance === 'sepia' && JSON.stringify(JSON.parse(serializeMetadata(withAppearance(weird, 'light'))).preferences.keep) === '[1,2]' && JSON.parse(serializeMetadata(withAppearance(weird, 'light'))).extra === true, 'An invalid stored value is read as system but not rewritten; unknown fields survive a change.');
  rejects(() => parseMetadata('{"schemaVersion":2,"preferences":{"appearance":7}}'), 'A non-string appearance is rejected.');
  assert(resolveScheme('system', true) === 'dark' && resolveScheme('system', false) === 'light' && resolveScheme('light', true) === 'light' && resolveScheme('dark', false) === 'dark', 'Resolution follows the OS only under system.');
  assert(rootClassesFor('system').add.length === 0 && rootClassesFor('system').remove.join() === 'light,dark' && rootClassesFor('dark').add.join() === 'dark' && rootClassesFor('light').remove.join() === 'dark', 'Root classes pin explicit schemes and clear both for system.');
  const ctl = new AppearanceController('system', false); const seen: string[] = []; ctl.subscribe(sch => seen.push(sch));
  ctl.onSystemChange(true); ctl.onSystemChange(true); ctl.setAppearance('light'); ctl.onSystemChange(false); ctl.setAppearance('system'); ctl.setAppearance('dark');
  assert(seen.join() === 'dark,light,dark' && ctl.scheme === 'dark', 'Live media-query changes update the resolved scheme under system only, without duplicate notifications.');
  passed.push('appearance: default/invalid→system, light/dark persistence with metadata preservation, live system media-query updates');

  // Confirmation before metadata mutations: cancel/Escape leave metadata unchanged; confirm = exactly one write; duplicate refused; failure reported; focus restored.
  const confirmLog: string[] = [];
  const mutation = { decide: false, writes: 0, failWrite: false };
  const writeCount = () => mutation.writes;
  const confirmDeps = (origin: FakeControl, dom: Map<string, FakeControl>, busy = { value: false }) => ({
    confirm: async (req: { title: string; description: string }) => { confirmLog.push(`${req.title} | ${req.description}`); return mutation.decide; },
    perform: async () => { if (busy.value) throw new Error('duplicate'); busy.value = true; try { if (mutation.failWrite) throw new Error('OneDrive update failed: HTTP 423'); mutation.writes++; return true; } finally { busy.value = false; } },
    isBusy: () => busy.value, focusReturn: new FocusReturn<FakeControl>(), resolveByKey: (k: string) => dom.get(k), fallback: () => new FakeControl('content'),
  });
  const pillOrigin = new FakePill('row-pill', pillFocusKey('row', 'task-stable'), 'Project: Unassigned. Change project for this task');
  const dom = new Map<string, FakeControl>([[pillOrigin.key, pillOrigin]]);
  const singleReq = assignRequest(['flight-plan-status-management-2026-10-01'], undefined, 'Website');
  assert(singleReq && singleReq.description.includes('“flight-plan-status-management-2026-10-01”') && singleReq.description.includes('“Website”') && singleReq.confirmLabel === 'Assign to Website', 'The single-task request states the task name and destination.');
  const bulkReq = assignRequest(['a', 'b', 'c'], 'Website', undefined);
  assert(bulkReq && bulkReq.title === 'Unassign 3 tasks?' && bulkReq.description.includes('3 selected tasks') && bulkReq.description.includes('“Website”'), 'The bulk request states the selected count and the current project.');
  assert(archiveRequest('Competitor notes').description.includes('“Competitor notes”') && archiveRequest('x').confirmLabel === 'Archive', 'The archive request names the task.');
  mutation.decide = false; pillOrigin.focused = false;
  const cancelled = await runConfirmedMutation(singleReq, { node: pillOrigin, key: pillOrigin.key }, confirmDeps(pillOrigin, dom));
  assert(cancelled.status === 'cancelled' && writeCount() === 0 && pillOrigin.focused, 'Cancel/Escape writes nothing and returns focus to the trigger.');
  mutation.decide = true; pillOrigin.focused = false;
  const saved = await runConfirmedMutation(singleReq, { node: pillOrigin, key: pillOrigin.key }, confirmDeps(pillOrigin, dom));
  assert(saved.status === 'saved' && writeCount() === 1 && pillOrigin.focused, 'Confirm performs exactly one write and restores focus.');
  const noop = await runConfirmedMutation(null, pillOrigin, confirmDeps(pillOrigin, dom));
  assert(noop.status === 'noop' && writeCount() === 1 && confirmLog.length === 2, 'Choosing the current project is a no-op with no dialog.');
  const busyBox = { value: true };
  const dup = await runConfirmedMutation(singleReq, pillOrigin, confirmDeps(pillOrigin, dom, busyBox));
  assert(dup.status === 'busy' && writeCount() === 1 && confirmLog.length === 2, 'A second submission while pending is refused before any dialog.');
  mutation.failWrite = true; pillOrigin.focused = false;
  const failedSave = await runConfirmedMutation(bulkReq, { node: pillOrigin, key: pillOrigin.key }, confirmDeps(pillOrigin, dom));
  assert(failedSave.status === 'failed' && failedSave.message.includes('423') && writeCount() === 1 && pillOrigin.focused, 'A failed save is reported (never success-shaped) and focus is restored.');
  mutation.failWrite = false;
  const replacedPill = new FakePill('row-pill-new', pillOrigin.key, pillOrigin.ariaLabel); const stale = new FakePill('row-pill-old', pillOrigin.key, pillOrigin.ariaLabel, false);
  const dom2 = new Map<string, FakeControl>([[pillOrigin.key, replacedPill]]);
  const viaKey = await runConfirmedMutation(singleReq, { node: stale, key: stale.key }, confirmDeps(stale, dom2));
  assert(viaKey.status === 'saved' && replacedPill.focused && !stale.focused, 'After a re-render the current equivalent trigger regains focus.');
  passed.push('confirmation before assign/unassign/archive: cancel leaves metadata unchanged, exactly one write, duplicate refused, failure reported, focus restored (single and bulk)');

  // Filename links: exact connector URL, pending/unavailable states, bounded concurrency, no manufactured URLs.
  let resolving = 0; let peak = 0;
  const linkRepo2 = { open: async (i: DriveItem) => { resolving++; peak = Math.max(peak, resolving); await new Promise(r => setTimeout(r, 1)); resolving--; if (i.Id === 'denied') throw new Error('A browser link for denied.md could not be created: access denied (403).'); return `https://contoso-my.sharepoint.com/:t:/g/${i.Id}?e=abc`; } };
  const links = new FileLinkService(linkRepo2, 2, 5);
  const linkItems = ['a', 'b', 'c', 'denied', 'e', 'f', 'g'].map(id => F(id, `/t/output/${id}.md`));
  const queued = links.ensure(linkItems); links.ensure(linkItems);
  assert(queued === 5 && links.state('a').status === 'pending' && links.state('g').status === 'idle', 'Links are queued once each and bounded; beyond the cap stays idle (plain text).');
  await new Promise(r => setTimeout(r, 40));
  assert(links.url('a') === 'https://contoso-my.sharepoint.com/:t:/g/a?e=abc' && links.state('denied').status === 'unavailable' && peak <= 2, 'Resolved links are exact connector URLs, failures are explicit unavailable states, concurrency is bounded.');
  links.retry(linkItems[3]); await new Promise(r => setTimeout(r, 20));
  assert(links.state('denied').status === 'unavailable' && linkAccessibleName({ Name: 'proposal.docx' }) === 'Open proposal.docx in a new tab', 'Retry re-resolves through the repository; accessible names name the file.');
  passed.push('filename links: exact URL, pending/unavailable states, bounded concurrency, retry, accessible name');

  // Fresh tenant: live companion file absent while the effective mode is Demo → exactly one LIVE initialize; no live content reads.
  class FakeLiveMetadata implements CompanionMetadataRepository {
    readonly location = '/Documents/cowork-companion.json';
    counters = { initializes: 0, saves: 0 }; failInitialize = false; stored?: CompanionMetadata;
    get initializes() { return this.counters.initializes; } get saves() { return this.counters.saves; }
    async load(): Promise<MetadataPage> { return this.stored ? { document: structuredClone(this.stored) } : { absent: true }; }
    async initialize(document: CompanionMetadata) { this.counters.initializes++; if (this.failInitialize) throw new Error('OneDrive create failed: HTTP 423'); if (this.stored) throw new Error('must not overwrite an existing file'); this.stored = parseMetadata(serializeMetadata(document)); return structuredClone(this.stored); }
    async save(document: CompanionMetadata) { this.counters.saves++; this.stored = parseMetadata(serializeMetadata(document)); return structuredClone(this.stored); }
  }
  const liveMeta = new FakeLiveMetadata();
  const liveCache: { page?: MetadataPage } = { page: await liveMeta.load() };
  const liveContentCalls: string[] = [];
  const liveContent: CoworkTaskRepository = { get: async () => { liveContentCalls.push('get'); throw new Error('x'); }, resolve: async () => { liveContentCalls.push('resolve'); throw new Error('x'); }, list: async () => { liveContentCalls.push('list'); throw new Error('x'); }, read: async () => { liveContentCalls.push('read'); throw new Error('x'); }, open: async () => { liveContentCalls.push('open'); throw new Error('x'); }, search: async () => { liveContentCalls.push('search'); throw new Error('x'); } };
  // The content bundle for the effective mode: Demo → in-memory; Live → the spy repository that must stay untouched until Demo is saved off.
  const liveContentBundle = createRepositories(liveContent, liveMeta);
  const effectiveMode = () => (demoModeOf(liveCache.page?.document) ? 'demo' : 'live');
  const effectiveBundle = () => (effectiveMode() === 'demo' ? createDemoRepositories() : liveContentBundle);
  await effectiveBundle().discovery.discover('/Documents/Cowork');
  assert(liveCache.page?.absent === true && effectiveMode() === 'demo', 'A fresh tenant has no live file and defaults to Demo mode.');
  assert(shouldBootstrap({ page: liveCache.page, queryStatus: 'success', phase: { status: 'idle' } }) && !shouldBootstrap({ page: { absent: true, nextToken: 'more' }, queryStatus: 'success', phase: { status: 'idle' } }) && !shouldBootstrap({ page: liveCache.page, queryStatus: 'pending', phase: { status: 'idle' } }) && !shouldBootstrap({ page: { document: emptyMetadata() }, queryStatus: 'success', phase: { status: 'idle' } }), 'Bootstrap starts only on a conclusive absent scan with nothing started.');
  assert(settingsReadiness({ page: liveCache.page, queryStatus: 'success', phase: { status: 'idle' } }).kind === 'creating' && settingsReadiness({ page: undefined, queryStatus: 'pending', phase: { status: 'idle' } }).kind === 'checking' && settingsReadiness({ page: { absent: true, nextToken: 't' }, queryStatus: 'success', phase: { status: 'idle' } }).kind === 'scan-incomplete' && settingsReadiness({ page: undefined, queryStatus: 'error', queryError: 'HTTP 403', phase: { status: 'idle' } }).kind === 'load-failed', 'Settings readiness distinguishes checking, creating, scan-incomplete and a real load failure.');
  const bootstrapCtl = new MetadataBootstrapController(liveMeta, document => { liveCache.page = { document }; });
  // Strict Mode / re-render: three simultaneous starts → one initialize.
  const [b1, b2, b3] = await Promise.all([bootstrapCtl.start(), bootstrapCtl.start(), bootstrapCtl.start()]);
  assert(b1.status === 'created' && b2 === b1 && b3 === b1 && liveMeta.initializes === 1, 'Concurrent effect runs produce exactly one live initialize.');
  assert((await bootstrapCtl.start()).status === 'created' && liveMeta.initializes === 1, 'A later start after success never initializes again.');
  assert(liveCache.page?.document !== undefined && !liveCache.page.absent && demoModeOf(liveCache.page.document) === true && effectiveMode() === 'demo', 'The created document lands in the live query cache; missing preference still means Demo mode.');
  assert(settingsReadiness({ page: liveCache.page, queryStatus: 'success', phase: bootstrapCtl.state }).kind === 'ready' && !(settingsReadiness({ page: liveCache.page, queryStatus: 'success', phase: bootstrapCtl.state }) as { saved: boolean }).saved, 'Settings is ready with no saved preference after creation — the switch is enabled.');
  await effectiveBundle().discovery.discover('/Documents/Cowork');
  assert(liveContentCalls.length === 0 && effectiveBundle() !== liveContentBundle, 'Bootstrapping the metadata file performs no live Cowork content read; content stays on the demo bundle.');
  // Saving Demo mode off writes to the LIVE repository; only then does the effective mode (and content repository) switch.
  const savedLive = await liveMeta.save(withDemoMode(liveCache.page.document!, false)); liveCache.page = { document: savedLive };
  assert(liveMeta.saves === 1 && demoModeOf(liveMeta.stored) === false && effectiveMode() === 'live' && effectiveBundle() === liveContentBundle && liveContentCalls.length === 0, 'Saving Demo mode off persists to the live file and only then selects the live content bundle; no content read happened before the explicit save.');
  // Existing file is never initialized again.
  const existingController = new MetadataBootstrapController(liveMeta); existingController.observeExisting();
  assert(!shouldBootstrap({ page: await liveMeta.load(), queryStatus: 'success', phase: existingController.state }) && liveMeta.initializes === 1, 'An existing live file is never initialized again.');
  // Initialization failure surfaces explicitly and retry works; nothing is silently fallen back to.
  const failingMeta = new FakeLiveMetadata(); failingMeta.failInitialize = true;
  const failCache: { page?: MetadataPage } = { page: { absent: true } };
  const failing = new MetadataBootstrapController(failingMeta, document => { failCache.page = { document }; });
  const failed = await failing.start();
  assert(failed.status === 'failed' && failed.message.includes('423') && failCache.page?.absent === true && settingsReadiness({ page: failCache.page, queryStatus: 'success', phase: failing.state }).kind === 'create-failed', 'A failed creation is reported with the connector reason and the cache stays absent.');
  const afterFailure = await failing.start(); const initializesAfterFailure: number = failingMeta.initializes;
  assert(afterFailure.status === 'failed' && initializesAfterFailure === 1, 'A failed bootstrap does not auto-retry on re-render.');
  failingMeta.failInitialize = false;
  const retried = await failing.retry();
  const initializesAfterRetry: number = failingMeta.initializes;
  assert(retried.status === 'created' && initializesAfterRetry === 2 && failCache.page?.document !== undefined, 'An explicit retry creates the file and updates the cache.');
  passed.push('fresh-tenant live bootstrap: exactly one live initialize while Demo is active, cache update, no content reads, failure + retry, existing file untouched, Demo off persists to live');
  passed.push('direct Open flow: link first, sandbox/popup block keeps link, distinct connector failure, no blank tab');
  return { passed: passed.length, checks: passed };
}
