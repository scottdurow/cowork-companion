// Demo mode: an in-memory repository bundle behind the SAME interfaces as the
// live OneDrive repositories. It is only used when the user explicitly switches
// to Demo mode in Settings. Nothing here is read from, or written to, OneDrive,
// and the UI labels the mode wherever this bundle is active.
import { InMemoryCompanionMetadataRepository, InMemoryCoworkTaskRepository, emptyMetadata, type DriveItem } from '@/lib/cowork-domain';
import { createRepositories, type CompanionRepositories } from '@/lib/cowork-repositories';

const ROOT = '/Documents/Cowork';
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

function folder(id: string, path: string, minutes: number): DriveItem {
  return { Id: id, Name: path.slice(path.lastIndexOf('/') + 1), Path: path, IsFolder: true, LastModified: ago(minutes), ETag: `demo-${id}-${minutes}` };
}
function file(id: string, path: string, minutes: number, size: number, type = 'text/plain'): DriveItem {
  return { Id: id, Name: path.slice(path.lastIndexOf('/') + 1), Path: path, IsFolder: false, LastModified: ago(minutes), Size: size, MediaType: type, ETag: `demo-${id}-${minutes}` };
}

// Clearly fictional Cowork-style folders. Names are prefixed "Demo" so they can
// never be mistaken for a real task.
export const demoItems: DriveItem[] = [
  folder('demo-root', ROOT, 12),
  folder('demo-tasks', `${ROOT}/Tasks`, 12),
  folder('demo-skills', `${ROOT}/skills`, 2880),
  folder('demo-memory', `${ROOT}/memory`, 95),
  // Task 1: active, several outputs incl. a very recent one
  folder('demo-task-1', `${ROOT}/Tasks/Demo task - Website copy refresh`, 12),
  folder('demo-task-1-in', `${ROOT}/Tasks/Demo task - Website copy refresh/input`, 400),
  folder('demo-task-1-out', `${ROOT}/Tasks/Demo task - Website copy refresh/output`, 12),
  file('demo-f1', `${ROOT}/Tasks/Demo task - Website copy refresh/input/brand-voice.md`, 400, 2140, 'text/markdown'),
  file('demo-f2', `${ROOT}/Tasks/Demo task - Website copy refresh/input/current-homepage.txt`, 420, 5320),
  file('demo-f3', `${ROOT}/Tasks/Demo task - Website copy refresh/output/homepage-draft-v2.md`, 12, 3980, 'text/markdown'),
  file('demo-f3b', `${ROOT}/Tasks/Demo task - Website copy refresh/output/seo-checklist.csv`, 40, 1210, 'text/csv'),
  file('demo-f4', `${ROOT}/Tasks/Demo task - Website copy refresh/output/homepage-draft-v1.md`, 190, 3610, 'text/markdown'),
  file('demo-f4b', `${ROOT}/Tasks/Demo task - Website copy refresh/output/copy-review-notes.txt`, 2000, 900),
  // Nested output folders (observable structure only)
  folder('demo-t1-out-pages', `${ROOT}/Tasks/Demo task - Website copy refresh/output/pages`, 25),
  folder('demo-t1-out-pages-pricing', `${ROOT}/Tasks/Demo task - Website copy refresh/output/pages/pricing`, 25),
  file('demo-f10', `${ROOT}/Tasks/Demo task - Website copy refresh/output/pages/about.md`, 70, 1800, 'text/markdown'),
  file('demo-f11', `${ROOT}/Tasks/Demo task - Website copy refresh/output/pages/pricing/plans.md`, 25, 2100, 'text/markdown'),
  file('demo-f12', `${ROOT}/Tasks/Demo task - Website copy refresh/output/pages/pricing/faq.csv`, 600, 700, 'text/csv'),
  folder('demo-t1-out-assets', `${ROOT}/Tasks/Demo task - Website copy refresh/output/assets`, 3000),
  file('demo-f13', `${ROOT}/Tasks/Demo task - Website copy refresh/output/assets/alt-text.txt`, 3000, 400),
  folder('demo-t1-out-archive', `${ROOT}/Tasks/Demo task - Website copy refresh/output/archive`, 5000),
  // Task 2: outputs older than a day
  folder('demo-task-2', `${ROOT}/Tasks/Demo task - Q1 campaign plan`, 1700),
  folder('demo-task-2-in', `${ROOT}/Tasks/Demo task - Q1 campaign plan/inputs`, 2900),
  folder('demo-task-2-out', `${ROOT}/Tasks/Demo task - Q1 campaign plan/outputs`, 1700),
  file('demo-f5', `${ROOT}/Tasks/Demo task - Q1 campaign plan/inputs/goals.txt`, 2900, 880),
  file('demo-f5b', `${ROOT}/Tasks/Demo task - Q1 campaign plan/inputs/last-quarter-results.csv`, 2950, 2300, 'text/csv'),
  file('demo-f6', `${ROOT}/Tasks/Demo task - Q1 campaign plan/outputs/campaign-plan.md`, 1700, 7400, 'text/markdown'),
  file('demo-f7', `${ROOT}/Tasks/Demo task - Q1 campaign plan/outputs/channel-budget.csv`, 1720, 1210, 'text/csv'),
  // Task 3: input only, no output folder yet (empty-state case)
  folder('demo-task-3', `${ROOT}/Tasks/Demo task - Competitor notes`, 1440),
  folder('demo-task-3-in', `${ROOT}/Tasks/Demo task - Competitor notes/input`, 1440),
  file('demo-f8', `${ROOT}/Tasks/Demo task - Competitor notes/input/notes.md`, 1440, 2600, 'text/markdown'),
  // Task 4: singular "output" folder, one older summary
  folder('demo-task-4', `${ROOT}/Tasks/Demo task - Expense policy review`, 4320),
  folder('demo-task-4-out', `${ROOT}/Tasks/Demo task - Expense policy review/output`, 4320),
  file('demo-f9', `${ROOT}/Tasks/Demo task - Expense policy review/output/summary.md`, 4320, 1900, 'text/markdown'),
  file('demo-f9b', `${ROOT}/Tasks/Demo task - Expense policy review/readme.txt`, 4400, 300),
  // Skills and memory
  folder('demo-skill-1', `${ROOT}/skills/meeting-recap`, 2880),
  file('demo-s1', `${ROOT}/skills/meeting-recap/SKILL.md`, 2880, 1400, 'text/markdown'),
  file('demo-s1b', `${ROOT}/skills/meeting-recap/template.md`, 4000, 600, 'text/markdown'),
  folder('demo-skill-2', `${ROOT}/skills/release-notes`, 60),
  file('demo-s2', `${ROOT}/skills/release-notes/SKILL.md`, 60, 1700, 'text/markdown'),
  file('demo-m1', `${ROOT}/memory/preferences.md`, 95, 760, 'text/markdown'),
  file('demo-m2', `${ROOT}/memory/project-context.json`, 2000, 1320, 'application/json'),
];

export const demoContents: Record<string, string> = {
  'demo-f1': '# Brand voice (demo sample)\n\nFriendly, direct, no jargon. Short sentences.\n',
  'demo-f2': 'DEMO SAMPLE — current homepage copy\n\nWelcome to our product. We help teams work better.\n',
  'demo-f3': '# Homepage draft v2 (demo sample)\n\nWelcome. Get more done with less back-and-forth.\n\n- Clear value in the first line\n- One call to action\n',
  'demo-f3b': 'check,status\ntitle under 60 chars,done\nmeta description,done\nalt text on hero,todo\n',
  'demo-f4': '# Homepage draft v1 (demo sample)\n\nWelcome to our product.\n',
  'demo-f4b': 'DEMO SAMPLE — review notes\n\nShorten the hero. Replace "synergy".\n',
  'demo-f10': '# About page (demo sample)\n\nWe are a small team that ships weekly.\n',
  'demo-f11': '# Pricing plans (demo sample)\n\n- Starter\n- Team\n- Enterprise\n',
  'demo-f12': 'question,answer\nCan I cancel?,Yes at any time\n',
  'demo-f13': 'DEMO SAMPLE — alt text\nhero.png: Team working at a table\n',
  'demo-f5': 'DEMO SAMPLE — Q1 goals\n\n1. Grow trials 20%\n2. Keep CAC flat\n',
  'demo-f5b': 'channel,spend,trials\nsearch,1100,240\nsocial,700,90\n',
  'demo-f6': '# Q1 campaign plan (demo sample)\n\n1. Awareness\n2. Trial\n3. Retention\n',
  'demo-f7': 'channel,budget\nsearch,1200\nsocial,800\n',
  'demo-f8': '# Competitor notes (demo sample)\n\n- Pricing page simplified.\n',
  'demo-f9': '# Expense policy summary (demo sample)\n\nReceipts required above 25.\n',
  'demo-f9b': 'DEMO SAMPLE — this folder was created by hand.\n',
  'demo-s1': '---\nname: meeting-recap\ndescription: Summarize a meeting transcript into decisions and action items.\n---\n# Meeting recap (demo skill)\n\nSteps: read transcript, list decisions, list owners.\n',
  'demo-s1b': '# Recap template (demo)\n\n## Decisions\n## Actions\n',
  'demo-s2': '---\nname: release-notes\ndescription: Turn merged work items into customer-facing release notes.\n---\n# Release notes (demo skill)\n',
  'demo-m1': '# Preferences (demo memory)\n\n- Prefers concise replies\n- Time zone: Pacific\n',
  'demo-m2': '{\n  "schema": 1,\n  "activeProjects": ["Website", "Campaign"]\n}\n',
};

export function createDemoRepositories(): CompanionRepositories {
  const tasks = new InMemoryCoworkTaskRepository(demoItems, demoContents);
  const metadata = new InMemoryCompanionMetadataRepository({
    ...emptyMetadata(),
    projects: [{ id: 'demo-project-web', name: 'Website', color: 'blue' }, { id: 'demo-project-mkt', name: 'Marketing', color: 'green' }],
    tasks: { 'demo-task-1': { projectId: 'demo-project-web', pinned: true }, 'demo-task-2': { projectId: 'demo-project-mkt' } },
  });
  return createRepositories(tasks, metadata);
}
