// Binds the pure hash-route helpers to window.location. The hash is the source of truth: every navigation
// writes the hash (pushing a history entry), and the rendered route is always derived from the current hash.
import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_HASH, backTarget, canonicalHash, parseHash, sectionHash, type HashRoute } from '@/lib/cowork-hash-routes';

function readRoute(): HashRoute {
  return parseHash(window.location.hash) ?? { kind: 'section', section: 'dashboard' };
}
function tagEntry(index: number) {
  try { window.history.replaceState({ ...(typeof window.history.state === 'object' && window.history.state ? window.history.state : {}), companionIndex: index }, ''); } catch { /* history API unavailable */ }
}
function currentIndex(): number {
  const state = window.history.state as { companionIndex?: unknown } | null;
  return state && typeof state.companionIndex === 'number' ? state.companionIndex : 0;
}

export function useHashRoute() {
  const [route, setRoute] = useState<HashRoute>(() => {
    // First load: resolve the hash directly (deep links), replacing only an empty or non-canonical hash.
    const raw = window.location.hash;
    const canonical = canonicalHash(raw);
    if (canonical === undefined) window.location.replace(DEFAULT_HASH);
    else if (canonical !== raw) window.location.replace(canonical);
    if (window.history.state?.companionIndex === undefined) tagEntry(0);
    return readRoute();
  });
  // Depth of the current entry within this page load. A hash set by an <a href="#/…"> click or by location.hash=
  // creates a new, untagged entry: tag it one deeper than the entry we came from. Back/Forward land on tagged entries.
  const depth = useRef(currentIndex());
  useEffect(() => {
    const onChange = () => {
      const raw = window.location.hash;
      const canonical = canonicalHash(raw);
      if (canonical === undefined) { window.location.replace(DEFAULT_HASH); return; }
      if (canonical !== raw) { window.location.replace(canonical); return; }
      if (window.history.state?.companionIndex === undefined) { depth.current += 1; tagEntry(depth.current); } else depth.current = currentIndex();
      setRoute(readRoute());
    };
    window.addEventListener('hashchange', onChange);
    window.addEventListener('popstate', onChange);
    return () => { window.removeEventListener('hashchange', onChange); window.removeEventListener('popstate', onChange); };
  }, []);
  const navigate = useCallback((hash: string) => { if (window.location.hash !== hash) window.location.hash = hash; }, []);
  const replace = useCallback((hash: string) => { window.location.replace(hash); }, []);
  const back = useCallback(() => {
    const target = backTarget(window.history.state);
    if (target.kind === 'history') window.history.back(); else navigate(target.hash);
  }, [navigate]);
  return { route, navigate, replace, back, hasHistory: backTarget(window.history.state).kind === 'history', tasksHash: sectionHash('tasks') };
}
