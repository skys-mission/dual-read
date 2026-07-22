/**
 * Performance budgets (docs/PERF_LAB.md).
 *
 * Default CI uses slightly relaxed ceilings for shared runners.
 * Set PERF_STRICT=1 to enforce strict numbers. Set PERF_FULL=1 to enable
 * 20k long-task + 30× SPA heap suites (slower).
 */

export interface PerfBudgets {
  /** 5k-element initial index (session lastIndexMs). */
  index5kMs: number;
  /** Max single long task during 20k index+translate. */
  longTask20kMs: number;
  /** MutationObserver incremental index. */
  mutationMs: number;
  /** Cumulative layout-shift attributed to the page during translate. */
  cls: number;
  /** Time from translate start → first .dual-read-target (mock API). */
  firstPaintMockMs: number;
  /** Heap growth after N SPA navigations while watching (fraction). */
  spaHeapGrowth: number;
  spaNavCount: number;
}

function envFlag(name: string): boolean {
  const v = process.env[name];
  return v === '1' || v === 'true' || v === 'yes';
}

export const PERF_STRICT = envFlag('PERF_STRICT');
export const PERF_FULL = envFlag('PERF_FULL');

/** Allow tiny wall-clock / VM jitter on timing assertions (ms). */
export const PERF_TIMING_SLACK_MS = PERF_STRICT ? 5 : 0;

/** Budgets applied by assertions. */
export const PERF_BUDGETS: PerfBudgets = PERF_STRICT
  ? {
      index5kMs: 100,
      longTask20kMs: 50,
      mutationMs: 16,
      cls: 0.05,
      firstPaintMockMs: 500,
      spaHeapGrowth: 0.1,
      spaNavCount: 30,
    }
  : {
      // Shared CI VMs are noisy; keep gates meaningful but not flaky.
      index5kMs: 300,
      longTask20kMs: 200,
      mutationMs: 80,
      // Bilingual companions insert flow content; stable shells + coalesce keep
      // dense pages within budget under PERF_STRICT. Default CI uses a thrash ceiling.
      cls: 0.35,
      firstPaintMockMs: 900,
      spaHeapGrowth: 0.25,
      spaNavCount: 30,
    };

export function p95(samples: number[]): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}
