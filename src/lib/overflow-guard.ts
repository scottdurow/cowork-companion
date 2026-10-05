// Narrow-layout acceptance: document.body.scrollWidth must never exceed documentElement.clientWidth.
// `measureOverflow` is a pure DOM measurement (used by the dev-time guard and runnable from the browser console);
// `useOverflowGuard` re-measures after layout and route changes and reports offenders in development only.
import { useEffect } from 'react';

export interface OverflowReport { clientWidth: number; scrollWidth: number; overflow: number; offenders: { tag: string; id: string; classes: string; right: number }[] }

export function measureOverflow(doc: Document = document, limit = 5): OverflowReport {
  const clientWidth = doc.documentElement.clientWidth;
  const scrollWidth = doc.body.scrollWidth;
  const overflow = Math.max(0, scrollWidth - clientWidth);
  const offenders: OverflowReport['offenders'] = [];
  if (overflow > 0) {
    for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>('*'))) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.right > clientWidth + 0.5 && getComputedStyle(el).position !== 'fixed') {
        offenders.push({ tag: el.tagName.toLowerCase(), id: el.id, classes: el.className.toString().slice(0, 80), right: Math.round(rect.right) });
        if (offenders.length >= limit) break;
      }
    }
  }
  return { clientWidth, scrollWidth, overflow, offenders };
}

export function useOverflowGuard(dependency: unknown) {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const handle = window.setTimeout(() => {
      const report = measureOverflow();
      if (report.overflow > 0) console.warn(`[layout] horizontal overflow: body ${report.scrollWidth}px > viewport ${report.clientWidth}px (+${report.overflow}px)`, report.offenders);
    }, 300);
    return () => window.clearTimeout(handle);
  }, [dependency]);
}
