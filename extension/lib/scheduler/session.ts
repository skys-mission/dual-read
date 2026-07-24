import type { PublicSessionConfig, TranslateStatus, TranslationPayload, TranslationUnit } from '../types';
import { collectUnits, collectUnitsAsync, mutationHasNewContent, mutationIndexDelta } from '../collector';
import { yieldToMain } from '../runtime/yield';
import { renderBatch, renderError, restoreDom, clearNode, restoreUnit } from '../renderer';
import { lookup, store } from '../cache';
import { isLikelyAlreadyTarget } from '../provider';
import { translateBatchViaPort, isAbortError } from '../messaging';
import { getUiMessage } from '../i18n';
import { DualReadError, toUserFacingError, type DualReadErrorCode } from '../errors';
import { adaptiveBatchSize, canAffordRetry, retryDelay } from './backoff';
import {
  RootRegistry,
  diagnoseFrames,
  summarizeDiagnostics,
  type WatchRoot,
} from '../roots';

const PREFETCH_MARGIN = '100% 0px';
const FLUSH_DEBOUNCE_MS = 250;
/** Steady-state render coalesce window. */
const RENDER_BUFFER_MS = 150;
/**
 * During the first viewport settle, hold paints longer so multiple batch
 * results land in one layout turn (cuts cumulative CLS from staggered inserts).
 */
const RENDER_BUFFER_INITIAL_MS = 320;
const INITIAL_SETTLE_MS = 1_200;
const INITIAL_MAX_MS = 8_000;
/** Soft CPU budget per index turn — leave headroom under the 50ms Long Task floor. */
const INDEX_SLICE_MS = 12;

export type DisposeReason =
  | 'restore'
  | 'replace'
  | 'stop'
  | 'navigation'
  | 'reinject'
  | 'disabled';

type EntryStatus = 'idle' | 'queued' | 'inflight' | 'done' | 'error';

interface Entry {
  unit: TranslationUnit;
  attempts: number;
  status: EntryStatus;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

interface SlotJob {
  entry: Entry;
  slotIndex: number;
  text: string;
}

export interface PageResult {
  success: boolean;
  count: number;
  failed: number;
  total: number;
  watching: boolean;
  error?: string;
  code?: DualReadErrorCode;
  sessionId?: string;
  shadowRoots?: number;
  frames?: {
    sameOrigin: number;
    crossOrigin: number;
    opaque: number;
  };
  /** See TranslateStatus.perf — returned so E2E can read index cost without a second relay. */
  perf?: {
    lastIndexMs?: number;
    lastMutationIndexMs?: number;
  };
}

export function configChanged(
  a: PublicSessionConfig | null | undefined,
  b: PublicSessionConfig | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.revision !== b.revision
    || a.targetLang !== b.targetLang
    || a.mode !== b.mode
    || a.providerFingerprint !== b.providerFingerprint
  );
}

/**
 * Per-frame translation session. Owns observers, queues, ports, and counts.
 * After `dispose()`, in-flight batch results are ignored (late-response guard).
 */
export class ContentSession {
  readonly id: string;
  readonly config: PublicSessionConfig;

  private disposed = false;
  private disposeReason: DisposeReason | null = null;
  /** Bumped on dispose so async work can detect staleness cheaply. */
  private generation = 0;

  private readonly entries = new Map<HTMLElement, Entry>();
  private readonly activePorts = new Set<chrome.runtime.Port>();
  private queue: Entry[] = [];
  private inflight = 0;
  private pendingRetries = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  /** Automatic retry attempts spent this session (manual retry excluded). */
  private retryCost = 0;
  private counts = { translated: 0, failed: 0, total: 0 };
  private lastIndexMs = 0;
  private lastMutationIndexMs = 0;

  private renderBuf: { unit: TranslationUnit; payload: TranslationPayload }[] = [];
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private initialCheck: (() => void) | null = null;

  private io: IntersectionObserver | null = null;
  private registry: RootRegistry | null = null;
  private moTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingMutations: MutationRecord[] = [];
  private watching = false;
  /** True while awaiting the first viewport drain — longer render coalesce. */
  private initialDrainActive = false;
  private diagnostics = summarizeDiagnostics(0, []);
  /** Aborts all in-flight port batches for this session. */
  private batchAbort: AbortController | null = null;

  constructor(config: PublicSessionConfig) {
    this.id = config.sessionId;
    this.config = config;
  }

  get alive(): boolean {
    return !this.disposed;
  }

  status(): TranslateStatus {
    const translating = this.inflight > 0 || this.queue.length > 0 || this.pendingRetries > 0;
    return {
      translating: translating && this.alive,
      count: this.counts.translated,
      failed: this.counts.failed,
      total: this.counts.total,
      watching: this.watching && this.alive,
      sessionId: this.id,
      revision: this.config.revision,
      shadowRoots: this.diagnostics.shadowRoots,
      frames: this.diagnostics.frames,
      perf: {
        lastIndexMs: this.lastIndexMs,
        lastMutationIndexMs: this.lastMutationIndexMs,
      },
    };
  }

  /**
   * Start indexing + viewport scheduling. Resolves after the first visible
   * batch settles (or max wait), while watchers keep running.
   */
  async start(): Promise<PageResult> {
    if (this.disposed) {
      return this.pageResult(false, 'SESSION_CANCELLED', 'session disposed');
    }
    if (this.config.disabled) {
      this.dispose('disabled');
      return this.pageResult(false, 'PAGE_UNSUPPORTED', 'site disabled');
    }

    try {
      this.batchAbort?.abort();
      this.batchAbort = new AbortController();
      this.io = new IntersectionObserver((records) => this.onIntersect(records), {
        rootMargin: PREFETCH_MARGIN,
      });
      this.watching = true;
      this.initialDrainActive = true;

      this.startMutationWatch();
      await this.indexFullDocument();

      if (!this.counts.total) {
        this.initialDrainActive = false;
        return this.pageResult(true);
      }

      await this.awaitInitialDrain();
      this.initialDrainActive = false;
      // Paint any renders still held in the initial coalesce window.
      if (this.renderTimer) {
        clearTimeout(this.renderTimer);
        this.renderTimer = null;
      }
      this.flushRenders();
      if (this.disposed) {
        return this.pageResult(false, 'SESSION_CANCELLED', 'session disposed');
      }
      return this.pageResult(true);
    } catch (err) {
      this.initialDrainActive = false;
      console.error('[Dual Read] ContentSession.start:', err);
      if (isAbortError(err)) {
        return this.pageResult(false, 'SESSION_CANCELLED', 'aborted');
      }
      const uf = toUserFacingError(err);
      return this.pageResult(false, uf.code, uf.detail);
    }
  }

  /** Stop observers/ports but keep translated DOM and entry bookkeeping. */
  pause(): void {
    if (this.disposed) return;
    // Bump generation so in-flight dispatch continuations (flushNow/finalize/
    // fail) go stale: a paused session must not keep dispatching queued batches.
    this.generation++;
    this.batchAbort?.abort();
    this.batchAbort = null;
    this.registry?.dispose();
    this.registry = null;
    this.io?.disconnect();
    if (this.moTimer) clearTimeout(this.moTimer);
    this.moTimer = null;
    this.pendingMutations = [];
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const entry of this.entries.values()) {
      if (entry.retryTimer) clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
      // Batches cancelled above must not stay stranded — make them schedulable.
      if (entry.status === 'queued' || entry.status === 'inflight') {
        entry.status = 'idle';
      }
    }
    // Dispatch finally-blocks skip stale generations, so counters are owned here.
    this.queue = [];
    this.inflight = 0;
    this.pendingRetries = 0;
    this.disconnectPorts();
    this.watching = false;
    this.io = null;
  }

  /** Re-attach observers after `pause()` without wiping entries. */
  resumeWatch(): void {
    if (this.disposed) return;
    if (this.watching && this.io) return;
    this.batchAbort?.abort();
    this.batchAbort = new AbortController();
    this.io = new IntersectionObserver((records) => this.onIntersect(records), {
      rootMargin: PREFETCH_MARGIN,
    });
    this.watching = true;
    // Reset entries stranded mid-flight (e.g. by an older pause) so they can
    // be re-queued when visible again.
    for (const entry of this.entries.values()) {
      if (entry.status === 'queued' || entry.status === 'inflight') {
        entry.status = 'idle';
      }
    }
    this.startObserving();
    this.startMutationWatch();
    this.ignoreFloating(this.indexFullDocument());
  }

  restore(): void {
    this.dispose('restore');
    this.flushRenders();
    restoreDom();
  }

  dispose(reason: DisposeReason = 'stop'): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeReason = reason;
    this.generation++;
    this.watching = false;
    this.initialDrainActive = false;

    this.batchAbort?.abort();
    this.batchAbort = null;

    for (const entry of this.entries.values()) {
      if (entry.retryTimer) clearTimeout(entry.retryTimer);
    }
    this.entries.clear();
    this.queue = [];
    this.inflight = 0;
    this.pendingRetries = 0;
    this.consecutiveFailures = 0;
    this.retryCost = 0;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.renderBuf = [];
    this.disconnectPorts();
    this.io?.disconnect();
    this.registry?.dispose();
    this.registry = null;
    if (this.moTimer) clearTimeout(this.moTimer);
    this.moTimer = null;
    this.pendingMutations = [];
    this.io = null;
    this.initialCheck = null;
  }

  private pageResult(success: boolean, code?: DualReadErrorCode, detail?: string): PageResult {
    const uf = code ? toUserFacingError(new DualReadError(code, { detail })) : undefined;
    const locale = this.config.uiLocale || 'en';
    const error = uf
      ? getUiMessage(uf.messageKey, null, locale)
      : undefined;
    return {
      success,
      count: this.counts.translated,
      failed: this.counts.failed,
      total: this.counts.total,
      watching: this.watching && this.alive,
      error,
      code,
      sessionId: this.id,
      shadowRoots: this.diagnostics.shadowRoots,
      frames: this.diagnostics.frames,
      perf: {
        lastIndexMs: this.lastIndexMs,
        lastMutationIndexMs: this.lastMutationIndexMs,
      },
    };
  }

  private disconnectPorts(): void {
    for (const port of this.activePorts) {
      try {
        port.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.activePorts.clear();
  }

  private errMsg(code: DualReadErrorCode = 'UNKNOWN'): string {
    const lang = this.config.uiLocale || 'en';
    const key = toUserFacingError(new DualReadError(code)).messageKey;
    return getUiMessage(key, null, lang);
  }

  private renderOpts() {
    return { targetLang: this.config.targetLang, uiLocale: this.config.uiLocale };
  }

  private effectiveBatchSize(): number {
    const base = Math.max(1, this.config.batchSize || 6);
    return adaptiveBatchSize(base, this.consecutiveFailures);
  }

  private flushRenders(): void {
    const items = this.renderBuf;
    this.renderBuf = [];
    if (this.disposed && this.disposeReason === 'restore') {
      // DOM is about to be restored; skip pending paints.
      return;
    }
    const mode = this.config.mode ?? 'bilingual';
    const opts = this.renderOpts();
    // Batch render: mount+fill all units, then stabilize block shells in
    // read/write passes so the browser coalesces forced layouts across the batch.
    renderBatch(items, mode, opts);
  }

  private bufferRender(unit: TranslationUnit, payload: TranslationPayload): void {
    if (this.disposed) return;
    this.renderBuf.push({ unit, payload });
    if (!this.renderTimer) {
      const delay = this.initialDrainActive ? RENDER_BUFFER_INITIAL_MS : RENDER_BUFFER_MS;
      this.renderTimer = setTimeout(() => {
        this.renderTimer = null;
        if (this.disposed) {
          this.renderBuf = [];
          return;
        }
        requestAnimationFrame(() => this.flushRenders());
      }, delay);
    }
  }

  private expandJobs(batch: Entry[]): SlotJob[] {
    const jobs: SlotJob[] = [];
    for (const entry of batch) {
      const slots = entry.unit.rich?.slots;
      if (slots?.length) {
        slots.forEach((text, slotIndex) => {
          jobs.push({ entry, slotIndex, text });
        });
      } else {
        jobs.push({ entry, slotIndex: -1, text: entry.unit.text });
      }
    }
    return jobs;
  }

  private unobserve(entry: Entry): void {
    this.io?.unobserve(entry.unit.el);
  }

  private enqueue(entry: Entry): void {
    if (!this.alive || entry.status !== 'idle') return;

    if (isLikelyAlreadyTarget(entry.unit.text, this.config.targetLang)) {
      entry.status = 'done';
      this.counts.translated++;
      this.unobserve(entry);
      this.checkSettle();
      return;
    }
    entry.status = 'queued';
    this.queue.push(entry);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (!this.alive) return;
    const budget = this.effectiveBatchSize();
    let weight = 0;
    for (const e of this.queue) {
      weight += this.slotWeight(e);
      if (weight >= budget) break;
    }
    if (weight >= budget) {
      this.flushNow();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushNow();
      }, FLUSH_DEBOUNCE_MS);
    }
  }

  private slotWeight(entry: Entry): number {
    return Math.max(1, entry.unit.rich?.slots?.length ?? 1);
  }

  private flushNow(): void {
    if (!this.alive) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const concurrency = Math.max(1, this.config.maxConcurrent || 3);
    while (this.queue.length && this.inflight < concurrency) {
      const budget = this.effectiveBatchSize();
      const batch: Entry[] = [];
      let weight = 0;
      while (
        this.queue.length
        && (batch.length === 0 || weight + this.slotWeight(this.queue[0]) <= budget)
      ) {
        const next = this.queue.shift()!;
        batch.push(next);
        weight += this.slotWeight(next);
      }
      void this.dispatch(batch);
    }
  }

  private async dispatch(batch: Entry[]): Promise<void> {
    if (!this.alive) return;
    const gen = this.generation;
    this.inflight++;
    for (const e of batch) e.status = 'inflight';

    const slotResults = new Map<Entry, (string | null)[]>();
    for (const e of batch) {
      const n = e.unit.rich?.slots?.length ?? 1;
      slotResults.set(e, Array.from({ length: n }, () => null));
    }

    const markSlot = (job: SlotJob, translation: string): void => {
      const arr = slotResults.get(job.entry);
      if (!arr) return;
      const idx = job.slotIndex < 0 ? 0 : job.slotIndex;
      arr[idx] = translation;
    };

    const finalizeEntry = (entry: Entry): void => {
      if (!this.isCurrent(gen)) return;
      const arr = slotResults.get(entry);
      if (!arr || arr.some((t) => t == null)) {
        this.fail(entry, toUserFacingError(new DualReadError('RESPONSE_MALFORMED', { detail: 'empty' })), gen);
        return;
      }
      const filled = arr as string[];
      const payload: TranslationPayload =
        entry.unit.rich?.slots?.length ? filled : filled[0] ?? '';
      this.succeed(entry, payload, gen);
    };

    try {
      const config = this.config;
      const jobs = this.expandJobs(batch);
      const texts = jobs.map((j) => j.text);
      const cached = await lookup(texts, config);
      if (!this.isCurrent(gen)) return;

      const missJobs: SlotJob[] = [];
      const missTexts: string[] = [];
      jobs.forEach((job, i) => {
        const hit = cached[i];
        if (hit) markSlot(job, hit);
        else {
          missJobs.push(job);
          missTexts.push(job.text);
        }
      });

      if (missJobs.length) {
        try {
          const translations = await translateBatchViaPort(missTexts, {
            sessionId: this.id,
            ports: this.activePorts,
            signal: this.batchAbort?.signal,
          });
          if (!this.isCurrent(gen)) return;

          this.consecutiveFailures = 0;
          const fresh: { text: string; translation: string }[] = [];
          missJobs.forEach((job, i) => {
            const tr = translations[i];
            if (tr) {
              markSlot(job, tr);
              fresh.push({ text: job.text, translation: tr });
            }
          });
          if (fresh.length) this.ignoreFloating(store(fresh, config));
        } catch (err) {
          if (!this.isCurrent(gen)) return;
          // Session pause/dispose/restore cancelled the fetch — not a unit failure.
          if (isAbortError(err)) return;
          this.consecutiveFailures++;
          const detail = err instanceof Error ? err.message : String(err);
          console.error('[Dual Read] batch:', detail);
          const uf = toUserFacingError(err);
          const failed = new Set<Entry>();
          for (const job of missJobs) {
            const arr = slotResults.get(job.entry);
            const idx = job.slotIndex < 0 ? 0 : job.slotIndex;
            if (arr && arr[idx] == null) failed.add(job.entry);
          }
          for (const e of failed) this.fail(e, uf, gen);
          for (const e of batch) {
            if (e.status === 'inflight') finalizeEntry(e);
          }
          return;
        }
      }

      for (const e of batch) {
        if (e.status !== 'inflight') continue;
        finalizeEntry(e);
      }
    } finally {
      if (this.isCurrent(gen)) {
        this.inflight = Math.max(0, this.inflight - 1);
        this.flushNow();
        this.checkSettle();
      }
    }
  }

  private isCurrent(gen: number): boolean {
    return this.alive && this.generation === gen;
  }

  /**
   * Floating async work (re-index, cache store) must never reject unhandled:
   * aborts from pause/dispose are expected, anything else is logged.
   */
  private ignoreFloating(p: Promise<unknown>): void {
    void p.catch((err) => {
      if (isAbortError(err)) return;
      console.error('[Dual Read] background task failed:', err);
    });
  }

  private succeed(entry: Entry, payload: TranslationPayload, gen: number): void {
    if (!this.isCurrent(gen)) return;
    entry.status = 'done';
    this.counts.translated++;
    this.bufferRender(entry.unit, payload);
    this.unobserve(entry);
  }

  private fail(
    entry: Entry,
    error: ReturnType<typeof toUserFacingError> | string,
    gen: number,
  ): void {
    if (!this.isCurrent(gen)) return;
    entry.attempts++;
    const uf = typeof error === 'string' ? toUserFacingError(new Error(error)) : error;
    // Non-retryable failures (auth/model/config…) go terminal immediately:
    // retrying them only burns the page retry budget and delays the real error.
    const delay = uf.retryable === false ? -1 : retryDelay(entry.attempts);
    if (delay < 0 || !canAffordRetry(this.retryCost)) {
      entry.status = 'error';
      this.counts.failed++;
      const locale = this.config.uiLocale || 'en';
      const message = getUiMessage(uf.messageKey, null, locale);
      const detailParts = [uf.detail];
      if (delay >= 0 && !canAffordRetry(this.retryCost)) {
        detailParts.push('page retry budget exhausted');
      }
      const detail = detailParts.filter(Boolean).join(' · ') || undefined;
      if (detail) console.info('[Dual Read] translation error detail:', uf.code, detail);
      renderError(entry.unit, message, detail, this.renderOpts());
      return;
    }
    this.retryCost++;
    entry.status = 'idle';
    this.pendingRetries++;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      this.pendingRetries = Math.max(0, this.pendingRetries - 1);
      if (!this.isCurrent(gen)) return;
      if (entry.status === 'idle') this.requeue(entry);
      this.checkSettle();
    }, delay);
  }

  private requeue(entry: Entry): void {
    if (!this.alive) return;
    entry.status = 'queued';
    this.queue.push(entry);
    this.scheduleFlush();
  }

  private manualRetry(entry: Entry): void {
    if (!this.alive || entry.status === 'inflight' || entry.status === 'queued') return;
    if (entry.status === 'error') this.counts.failed = Math.max(0, this.counts.failed - 1);
    clearNode(entry.unit.el);
    entry.attempts = 0;
    entry.status = 'idle';
    this.requeue(entry);
  }

  /** Re-queue every unit currently in `error` status. Returns how many were queued. */
  retryFailed(): number {
    if (!this.alive) return 0;
    let n = 0;
    for (const entry of Array.from(this.entries.values())) {
      if (entry.status !== 'error') continue;
      this.manualRetry(entry);
      n++;
    }
    if (n) this.flushNow();
    return n;
  }

  private checkSettle(): void {
    if (this.queue.length === 0 && this.inflight === 0 && this.pendingRetries === 0) {
      this.initialCheck?.();
    }
  }

  private ensureEntry(unit: TranslationUnit): Entry | null {
    if (this.entries.has(unit.el)) return null;
    const entry: Entry = { unit, attempts: 0, status: 'idle', retryTimer: null };
    this.entries.set(unit.el, entry);
    return entry;
  }

  private dropEntry(host: HTMLElement): void {
    const entry = this.entries.get(host);
    if (!entry) return;
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    this.unobserve(entry);
    this.queue = this.queue.filter((e) => e !== entry);
    this.entries.delete(host);
    if (entry.status === 'done') this.counts.translated = Math.max(0, this.counts.translated - 1);
    if (entry.status === 'error') this.counts.failed = Math.max(0, this.counts.failed - 1);
    this.counts.total = Math.max(0, this.counts.total - 1);
  }

  private startObserving(): void {
    if (!this.io) return;
    for (const entry of this.entries.values()) {
      if (entry.unit.el.isConnected) this.io.observe(entry.unit.el);
    }
  }

  private onIntersect(records: IntersectionObserverEntry[]): void {
    if (!this.alive) return;
    for (const rec of records) {
      if (!rec.isIntersecting) continue;
      const entry = this.entries.get(rec.target as HTMLElement);
      if (entry && entry.status === 'idle') this.enqueue(entry);
    }
  }

  /**
   * Full-document index — used only on session start / resume.
   * Cooperative: wide forests are collected in child batches; registration
   * also yields so a 20k page does not produce a multi-hundred-ms Long Task.
   * `lastIndexMs` counts active CPU only (excludes yield waits).
   */
  private async indexScopes(scopes: WatchRoot[]): Promise<number> {
    if (!this.alive || !this.io) return 0;
    let added = 0;
    let cpuMs = 0;
    let sliceCpu = 0;

    for (const scope of scopes) {
      if (!this.alive || !this.io) break;
      const collected = await collectUnitsAsync(scope, {
        budgetMs: INDEX_SLICE_MS,
        signal: this.batchAbort?.signal,
      });
      cpuMs += collected.cpuMs;
      sliceCpu = 0;

      for (const unit of collected.units) {
        if (!this.alive || !this.io) break;
        const t0 = performance.now();
        const entry = this.ensureEntry(unit);
        if (entry) {
          this.counts.total++;
          this.io.observe(unit.el);
          added++;
        }
        const dt = performance.now() - t0;
        cpuMs += dt;
        sliceCpu += dt;
        if (sliceCpu >= INDEX_SLICE_MS) {
          await yieldToMain();
          if (!this.alive || !this.io) break;
          sliceCpu = 0;
        }
      }
    }

    if (added) this.checkSettle();
    return cpuMs;
  }

  private refreshDiagnostics(): void {
    const shadowCount = this.registry
      ? this.registry.roots.filter((r) => r instanceof ShadowRoot).length
      : 0;
    this.diagnostics = summarizeDiagnostics(shadowCount, diagnoseFrames());
  }

  private async indexFullDocument(): Promise<void> {
    if (!this.alive || !this.io || !this.registry) return;
    const cpuMs = await this.indexScopes(this.registry.roots);
    this.refreshDiagnostics();
    this.lastIndexMs = cpuMs;
  }

  /**
   * Incremental re-index from MutationRecords: only scan added/changed roots,
   * drop disconnected hosts, and invalidate characterData hosts.
   */
  private indexFromMutations(mutations: MutationRecord[]): void {
    if (!this.alive || !this.io) return;
    const t0 = performance.now();

    this.registry?.pruneDisconnected();
    this.refreshDiagnostics();

    const delta = mutationIndexDelta(mutations, this.entries.keys());

    for (const host of delta.removed) {
      this.dropEntry(host);
    }

    // Restore + drop first so re-collection can see source text without DONE.
    for (const host of delta.invalidated) {
      try {
        restoreUnit(host);
      } catch {
        /* ignore */
      }
      this.dropEntry(host);
    }

    // Sweep any other disconnected hosts the mutation list might have missed.
    for (const host of Array.from(this.entries.keys())) {
      if (!host.isConnected) this.dropEntry(host);
    }

    const toAdd = [...delta.added];
    for (const host of delta.invalidated) {
      if (!host.isConnected) continue;
      for (const unit of collectUnits(host)) toAdd.push(unit);
    }

    let added = 0;
    const seen = new Set<HTMLElement>();
    for (const unit of toAdd) {
      if (!unit.el.isConnected || seen.has(unit.el)) continue;
      seen.add(unit.el);
      const entry = this.ensureEntry(unit);
      if (entry) {
        this.counts.total++;
        this.io.observe(unit.el);
        added++;
      }
    }
    if (added || delta.removed.length || delta.invalidated.length) this.checkSettle();
    this.lastMutationIndexMs = performance.now() - t0;
  }

  private startMutationWatch(): void {
    if (!this.alive || this.registry) return;
    this.registry = new RootRegistry(
      (mutations) => {
        if (!this.alive) return;
        this.pendingMutations.push(...mutations);
        if (this.moTimer) clearTimeout(this.moTimer);
        this.moTimer = setTimeout(() => {
          this.moTimer = null;
          const batch = this.pendingMutations;
          this.pendingMutations = [];
          if (!this.alive || !batch.length) return;
          const lateShadows = this.registry?.rescan(document) ?? [];
          if (lateShadows.length) this.ignoreFloating(this.indexScopes(lateShadows));
          if (mutationHasNewContent(batch) || lateShadows.length) {
            if (mutationHasNewContent(batch)) this.indexFromMutations(batch);
            else this.refreshDiagnostics();
            return;
          }
          let pruned = false;
          for (const host of Array.from(this.entries.keys())) {
            if (!host.isConnected) {
              this.dropEntry(host);
              pruned = true;
            }
          }
          this.registry?.pruneDisconnected();
          if (pruned) this.checkSettle();
        }, 320);
      },
      (addedRoots) => {
        if (!this.alive) return;
        this.ignoreFloating(this.indexScopes(addedRoots));
        this.refreshDiagnostics();
      },
    );
    this.registry.bootstrap(document);
    this.refreshDiagnostics();
  }

  private awaitInitialDrain(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(maxTimer);
        clearTimeout(idleTimer);
        this.initialCheck = null;
        resolve();
      };
      this.initialCheck = () => {
        if (this.queue.length === 0 && this.inflight === 0 && this.pendingRetries === 0) finish();
      };
      const idleTimer = setTimeout(() => this.initialCheck?.(), INITIAL_SETTLE_MS);
      const maxTimer = setTimeout(finish, INITIAL_MAX_MS);
    });
  }
}
