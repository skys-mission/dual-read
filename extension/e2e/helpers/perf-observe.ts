import type { Page } from '@playwright/test';

export interface PerfObserverSnapshot {
  longTaskMaxMs: number;
  longTaskCount: number;
  cls: number;
  /** Wall clock when observers were installed (performance.now). */
  installedAt: number;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Install PerformanceObservers before navigation/translation.
 * Stores results on window.__DR_PERF__.
 */
export async function installPerfObservers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Store = {
      longTasks: number[];
      cls: number;
      installedAt: number;
    };
    const g = globalThis as unknown as { __DR_PERF__?: Store };
    const store: Store = { longTasks: [], cls: 0, installedAt: 0 };
    g.__DR_PERF__ = store;

    const boot = () => {
      store.installedAt = performance.now();
      try {
        const lt = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) store.longTasks.push(e.duration);
        });
        lt.observe({ type: 'longtask', buffered: true });
      } catch {
        /* longtask unsupported */
      }
      try {
        const ls = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            const le = e as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
            if (le.hadRecentInput) continue;
            store.cls += le.value ?? 0;
          }
        });
        ls.observe({ type: 'layout-shift', buffered: true });
      } catch {
        /* layout-shift unsupported */
      }
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  });
}

export async function readPerfObservers(page: Page): Promise<PerfObserverSnapshot> {
  return page.evaluate(() => {
    const g = globalThis as unknown as {
      __DR_PERF__?: { longTasks: number[]; cls: number; installedAt: number };
    };
    const s = g.__DR_PERF__;
    const tasks = s?.longTasks ?? [];
    return {
      longTaskMaxMs: tasks.length ? Math.max(...tasks) : 0,
      longTaskCount: tasks.length,
      cls: s?.cls ?? 0,
      installedAt: s?.installedAt ?? 0,
    };
  });
}

/** Count translation companions. */
export async function countTranslationTargets(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('.dual-read-target').length);
}

/**
 * Measure ms until first translation target appears (wall clock from call site).
 * Returns null if none appear before timeout.
 */
export async function waitFirstPaintMs(
  page: Page,
  timeoutMs: number,
): Promise<number | null> {
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  while (Date.now() < deadline) {
    const n = await countTranslationTargets(page);
    if (n > 0) return Date.now() - t0;
    await sleep(50);
  }
  return null;
}

export async function readHeapUsed(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return mem?.usedJSHeapSize ?? null;
  });
}
