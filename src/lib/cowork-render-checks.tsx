// Deterministic React integration regression checks (happy-dom + react-dom/client). They render the real HomePage/TaskPage
// through CompanionProvider over an injected live-shaped repository bundle with task shells, and prove that render/update
// SETTLES: no "Maximum update depth exceeded", a bounded number of commits, and engine actions are invoked a bounded number
// of times (regression for the production crash where `sync` changed identity per render and effects re-ran per emit).
import { Window } from 'happy-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmContext } from '@/hooks/use-confirm';
import type { ReactElement } from 'react';

type Dom = { window: Window; dispose: () => void };
function installDom(width: number, hash: string): Dom {
  const window = new Window({ url: `https://preview.local/app/${hash}`, width, height: 800 });
  const g = globalThis as unknown as Record<string, unknown>;
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'PointerEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage', 'history', 'location', 'MutationObserver', 'DOMRect', 'Text', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLAnchorElement', 'SVGElement', 'DocumentFragment', 'ResizeObserver', 'matchMedia'];
  const previous = new Map<string, unknown>();
  for (const key of keys) { previous.set(key, g[key]); const value = (window as unknown as Record<string, unknown>)[key]; if (value !== undefined) g[key] = typeof value === 'function' && !/^[A-Z]/.test(key) ? (value as (...a: unknown[]) => unknown).bind(window) : value; }
  if (!g.ResizeObserver) g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!g.matchMedia) { const mm = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }); g.matchMedia = mm; (window as unknown as Record<string, unknown>).matchMedia = mm; }
  (g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return { window, dispose: () => { for (const key of keys) { if (previous.get(key) === undefined) delete g[key]; else g[key] = previous.get(key); } window.close(); } };
}

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface RenderCheckResult { name: string; detail: string }

export async function runRenderChecks(): Promise<{ passed: number; report: RenderCheckResult[] }> {
  const report: RenderCheckResult[] = [];
  const pass = (name: string, detail: string) => report.push({ name, detail });

  // Imports happen after the DOM exists so module-level `window` reads (hash routing, storage) see happy-dom.
  const scenario = async (opts: { width: number; hash: string; tasks: number; label: string; afterSettle?: (ctx: { window: Window; commits: () => number; repo: InstanceType<Awaited<typeof checks>['CountingRepository']>; engineCalls: () => Record<string, number> }) => Promise<string> }) => {
    const dom = installDom(opts.width, opts.hash);
    try {
      const React = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { act } = await import('react');
      const { CompanionProvider } = await import('@/lib/companion-session');
      const { HomePage } = await import('@/pages/home');
      const { createRepositories } = await import('@/lib/cowork-repositories');
      const { InMemoryCompanionMetadataRepository, emptyMetadata } = await import('@/lib/cowork-domain');
      const synthetic = checksModule.synthetic; const CountingRepository = checksModule.CountingRepository;
      const data = synthetic(opts.tasks, 3, 4);
      const repo = new CountingRepository(data.items, data.contents, 1);
      const metadata = new InMemoryCompanionMetadataRepository({ ...emptyMetadata(), tasks: { t0: { pinned: true }, t1: { projectId: 'p1' } }, projects: [{ id: 'p1', name: 'Website', color: 'blue' }] });
      const repositories = createRepositories(repo, metadata);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      const container = dom.window.document.createElement('div');
      dom.window.document.body.appendChild(container);
      let commits = 0; const errors: string[] = [];
      const root = createRoot(container as unknown as Element, { onUncaughtError: (e) => errors.push(String(e instanceof Error ? e.message : e)), onRecoverableError: (e) => errors.push(String(e instanceof Error ? e.message : e)) });
      const origError = console.error; console.error = (...args: unknown[]) => { const text = args.map(String).join(' '); if (/Maximum update depth|Too many re-renders/.test(text)) errors.push(text); };
      const tree: ReactElement = React.createElement(React.Profiler, { id: 'app', onRender: () => { commits++; } },
        React.createElement(QueryClientProvider, { client }, React.createElement(ConfirmContext.Provider, { value: async () => true }, React.createElement(CompanionProvider, { repositories, children: React.createElement(HomePage) }))));
      try {
        await act(async () => { root.render(tree); });
        // Let the engine authorize, outline and hydrate. Settled = connector calls AND commits unchanged across two consecutive
        // act() turns after the first commit. A feedback loop (effect → engine emit → render → effect …) never satisfies this and
        // trips the commit bound; React's own "Maximum update depth exceeded" is captured from the root/console as an error.
        let lastCommits = -1; let lastCalls = -1; let stableTurns = 0; const started = Date.now(); const trace: string[] = [];
        while (stableTurns < 2) {
          await act(async () => { await tick(30); });
          trace.push(`${Date.now() - started}ms:c${commits}/calls${repo.count()}`);
          if (commits === lastCommits && repo.count() === lastCalls) stableTurns++; else { stableTurns = 0; lastCommits = commits; lastCalls = repo.count(); }
          if (errors.length) throw new Error(`${opts.label}: ${errors[0]}`);
          if (commits > 2 * repo.count() + 40) throw new Error(`${opts.label}: commits (${commits}) outrun connector progress (${repo.count()} calls) — render feedback loop. trace ${trace.slice(-8).join(' ')}`);
          if (Date.now() - started > 90_000) throw new Error(`${opts.label}: did not settle in 90s (commits ${commits}, calls ${repo.count()}) trace ${trace.slice(-8).join(' ')}`);
        }
        // A plain re-render after settling (same route, same data) must not feed back into the engine: no new connector calls, ≤3 commits.
        const settledCommits = commits; const settledCalls = repo.count();
        await act(async () => { dom.window.dispatchEvent(new dom.window.Event('resize')); await tick(30); });
        await act(async () => { await tick(30); });
        if (repo.count() !== settledCalls || commits - settledCommits > 3) throw new Error(`${opts.label}: post-settle re-render caused ${commits - settledCommits} commits and ${repo.count() - settledCalls} connector calls`);
        const extra = opts.afterSettle ? await opts.afterSettle({ window: dom.window, commits: () => commits, repo, engineCalls: () => repo.calls.reduce<Record<string, number>>((acc, c) => { acc[c.op] = (acc[c.op] ?? 0) + 1; return acc; }, {}) }) : '';
        if (errors.length) throw new Error(`${opts.label}: ${errors[0]}`);
        return { commits, extra, repoCalls: repo.count(), html: (container as unknown as HTMLElement).innerHTML };
      } finally { console.error = origError; await act(async () => { root.unmount(); }); client.clear(); }
    } finally { dom.dispose(); }
  };
  const checks = import('@/lib/cowork-sync-checks');
  const checksModule = await checks;

  // 1. Wide live dashboard with 30 task shells (pinned + visible prioritisation, status slot, activity rail).
  const dash = await scenario({ width: 1400, hash: '#/dashboard', tasks: 10, label: 'wide dashboard' });
  if (!/Inspecting…|in · /.test(dash.html) && !/tasks<\/span>/.test(dash.html)) throw new Error('dashboard did not render task rows');
  pass('wide live dashboard settles', `10 shells (pinned + visible prioritised): ${dash.commits} commits, ${dash.repoCalls} connector calls, no update-depth error; rows rendered`);

  // 2. Tasks route at compact width (prioritisation effect with a different visible set) also settles.
  const tasks = await scenario({ width: 329, hash: '#/tasks', tasks: 6, label: 'compact tasks' });
  pass('compact tasks route settles', `6 shells at 329px: ${tasks.commits} commits, ${tasks.repoCalls} connector calls`);

  // 3. Task page: hydration effect depends on stable hydrateTask + taskId only; opening a task settles and lists its folders once.
  const task = await scenario({ width: 1200, hash: '#/tasks/t2', tasks: 6, label: 'task page', afterSettle: async ({ repo }) => { const lists = repo.calls.filter(c => c.op === 'list' && c.id === 't2').length; if (lists !== 1) throw new Error(`task page listed its folder ${lists} times (expected exactly 1 boundary hydration)`); return `task-2 folder listed ${lists}×`; } });
  pass('task page hydration settles', `${task.commits} commits; ${task.extra}; no re-hydration loop`);

  // 4. Skills and Memory routes: ensureSkills/ensureMemory run once per route entry, SKILL.md read once each.
  const skills = await scenario({ width: 1200, hash: '#/skills', tasks: 4, label: 'skills route', afterSettle: async ({ repo }) => { const reads = repo.count('read'); const listed = repo.listed('skills'); if (reads !== 3 || listed !== 1) throw new Error(`skills route: container listed ${listed}×, SKILL.md reads ${reads} (expected 1 / 3)`); return `skills container listed ${listed}×, 3 SKILL.md read once each`; } });
  pass('skills route settles', `${skills.commits} commits; ${skills.extra}`);
  const memory = await scenario({ width: 1200, hash: '#/memory', tasks: 4, label: 'memory route', afterSettle: async ({ repo }) => { const listed = repo.listed('memory'); if (listed !== 1) throw new Error(`memory container listed ${listed}×`); return `memory container listed ${listed}×`; } });
  pass('memory route settles', `${memory.commits} commits; ${memory.extra}`);

  return { passed: report.length, report };
}
