import type { ContentRequest, PingResponse } from './messaging';
import type { PublicSessionConfig, TranslateStatus } from './types';

const CONTENT_FILE = 'dual-read.js';
const CONTENT_CSS = 'dual-read.css';

function pingFrame(tabId: number, frameId: number): Promise<PingResponse | null> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      { action: 'ping' } satisfies ContentRequest,
      { frameId },
      (response) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response?.pong ? (response as PingResponse) : null);
      },
    );
  });
}

/**
 * Reuse a live content script in the selected frame; inject only when missing.
 * Context-menu clicks grant activeTab until navigation, so the initial ping
 * does not consume the permission. Avoiding unconditional re-execution keeps
 * overlay/session module state and document listeners singular.
 */
export async function ensureFrameContentScript(tabId: number, frameId: number): Promise<boolean> {
  const expected = chrome.runtime.getManifest().version;
  if (isLivePing(await pingFrame(tabId, frameId), expected)) return true;
  try {
    await injectFiles(tabId, [frameId]);
  } catch (err) {
    console.warn('[Dual Read] frame inject failed:', err);
    return false;
  }
  return isLivePing(await pingFrame(tabId, frameId), expected);
}

/**
 * Run selection translate in a specific frame via executeScript (more reliable
 * than tabs.sendMessage after context-menu clicks / activeTab races).
 */
export async function runSelectionInFrame(
  tabId: number,
  frameId: number,
  config: PublicSessionConfig,
  text: string,
): Promise<boolean> {
  type FrameReply = { ok: boolean; payload: unknown };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: (cfg: PublicSessionConfig, selected: string) => {
        const g = (globalThis as {
          __DUAL_READ__?: {
            handleMessage: (
              req: ContentRequest,
              sender: unknown,
              reply: (r: unknown) => void,
            ) => boolean;
          };
        }).__DUAL_READ__;
        if (!g?.handleMessage) return { ok: false, payload: null };
        return new Promise<FrameReply>((resolve) => {
          let settled = false;
          const reply = (r: unknown) => {
            if (settled) return;
            settled = true;
            resolve({ ok: true, payload: r });
          };
          try {
            const keep = g.handleMessage(
              { action: 'translateSelection', config: cfg, text: selected },
              null,
              reply,
            );
            if (!keep && !settled) {
              settled = true;
              resolve({
                ok: false,
                payload: {
                  success: false,
                  error: 'selection handler declined without a reply',
                },
              });
            }
          } catch (err) {
            resolve({
              ok: false,
              payload: {
                success: false,
                error: err instanceof Error ? err.message : String(err),
              },
            });
          }
        });
      },
      args: [config, text],
    });
    const result = results[0]?.result as FrameReply | undefined;
    return Boolean(result?.ok);
  } catch (err) {
    console.warn('[Dual Read] runSelectionInFrame failed:', err);
    return false;
  }
}

function pingMainFrame(tabId: number): Promise<PingResponse | null> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'ping' } satisfies ContentRequest, (response) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response?.pong ? (response as PingResponse) : null);
    });
  });
}

function isLivePing(ping: PingResponse | null, expectedVersion: string): boolean {
  if (!ping?.pong || ping.version !== expectedVersion) return false;
  // Orphaned injects (post extension reload) often still reply to ping via a
  // direct handleMessage probe, but runtime messaging requires a matching id.
  const selfId = chrome.runtime?.id;
  if (!selfId) return true;
  if (ping.runtimeId == null) return false;
  return ping.runtimeId === selfId;
}

async function injectFiles(tabId: number, frameIds?: number[]): Promise<void> {
  const target = frameIds?.length
    ? { tabId, frameIds }
    : { tabId, allFrames: true as const };
  await chrome.scripting.executeScript({ target, files: [CONTENT_FILE] });
  await chrome.scripting.insertCSS({ target, files: [CONTENT_CSS] });
}

/**
 * Top up SPA/late iframes that never received the content script.
 * Never re-executes dual-read.js on a frame that already has the expected
 * build — re-injection calls stopWatch and orphans the live session
 * (popup progress polling used to hit this every 400ms).
 */
async function injectMissingFrames(tabId: number, expected: string): Promise<void> {
  const selfId = chrome.runtime?.id ?? null;
  let probes: chrome.scripting.InjectionResult<{ version: string | null; runtimeId: string | null } | null>[];
  try {
    probes = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const g = (globalThis as {
          __DUAL_READ__?: { version?: string; runtimeId?: string | null };
        }).__DUAL_READ__;
        return {
          version: g?.version ?? null,
          runtimeId: g?.runtimeId ?? null,
        };
      },
    });
  } catch {
    return;
  }

  const missing = probes
    .filter((r) => {
      const v = r.result;
      if (!v || v.version !== expected) return true;
      // Orphan after extension reload: version matches but runtime id does not.
      if (selfId && v.runtimeId !== selfId) return true;
      return false;
    })
    .map((r) => r.frameId)
    .filter((id): id is number => typeof id === 'number');
  if (!missing.length) return;

  try {
    await injectFiles(tabId, missing);
  } catch {
    /* individual frames may reject; main frame is enough to proceed */
  }
}

/** Inject (or reuse) the content script into every reachable frame of a tab. */
export async function ensureContentScript(tabId: number): Promise<boolean> {
  const expected = chrome.runtime.getManifest().version;
  const existing = await pingMainFrame(tabId);
  if (isLivePing(existing, expected)) {
    // Main frame is current — only inject frames that still lack this build.
    await injectMissingFrames(tabId, expected);
    return true;
  }
  try {
    await injectFiles(tabId);
  } catch (err) {
    console.warn('[Dual Read] inject failed:', err);
    return false;
  }
  return isLivePing(await pingMainFrame(tabId), expected);
}

export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  return /^(chrome|chrome-extension|edge|about|moz-extension|view-source|file):/i.test(url);
}

export function originPattern(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

export interface FrameRelayResult {
  /** Aggregated counts across frames that answered. */
  status: TranslateStatus;
  /** Per-frame raw replies (null = inject/runtime failure). */
  frames: unknown[];
  /** True when at least one frame reported success for mutating actions. */
  success: boolean;
  error?: string;
}

function emptyStatus(): TranslateStatus {
  return {
    translating: false,
    count: 0,
    failed: 0,
    total: 0,
    watching: false,
    frames: { sameOrigin: 0, crossOrigin: 0, opaque: 0 },
    shadowRoots: 0,
    perf: {},
  };
}

function aggregateStatuses(parts: TranslateStatus[]): TranslateStatus {
  const out = emptyStatus();
  const frames = { sameOrigin: 0, crossOrigin: 0, opaque: 0 };
  let shadowRoots = 0;
  let lastIndexMs = 0;
  let lastMutationIndexMs = 0;
  for (const s of parts) {
    out.translating = out.translating || Boolean(s.translating);
    out.watching = out.watching || Boolean(s.watching);
    out.count += s.count ?? 0;
    out.failed += s.failed ?? 0;
    out.total += s.total ?? 0;
    if (s.sessionId) out.sessionId = s.sessionId;
    if (s.revision != null) out.revision = s.revision;
    if (s.frames) {
      frames.sameOrigin += s.frames.sameOrigin;
      frames.crossOrigin += s.frames.crossOrigin;
      frames.opaque += s.frames.opaque;
    }
    shadowRoots += s.shadowRoots ?? 0;
    if (s.perf?.lastIndexMs != null) lastIndexMs = Math.max(lastIndexMs, s.perf.lastIndexMs);
    if (s.perf?.lastMutationIndexMs != null) {
      lastMutationIndexMs = Math.max(lastMutationIndexMs, s.perf.lastMutationIndexMs);
    }
  }
  out.frames = frames;
  out.shadowRoots = shadowRoots;
  out.perf = { lastIndexMs, lastMutationIndexMs };
  return out;
}

/**
 * Deliver a content-script action to every reachable frame and aggregate replies.
 * Uses scripting.executeScript so same-origin iframes participate even when
 * tabs.sendMessage would only hit the main frame.
 */
export async function broadcastToFrames(
  tabId: number,
  message: ContentRequest,
): Promise<FrameRelayResult> {
  type FrameReply = {
    ok: boolean;
    payload: unknown;
  };

  let results: chrome.scripting.InjectionResult<FrameReply | null>[];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (msg: ContentRequest) => {
        const g = (globalThis as { __DUAL_READ__?: {
          handleMessage: (
            req: ContentRequest,
            sender: unknown,
            reply: (r: unknown) => void,
          ) => boolean;
        } }).__DUAL_READ__;
        if (!g?.handleMessage) return { ok: false, payload: null };
        return new Promise<FrameReply>((resolve) => {
          let settled = false;
          const reply = (r: unknown) => {
            if (settled) return;
            settled = true;
            resolve({ ok: true, payload: r });
          };
          try {
            const asyncKeep = g.handleMessage(msg, null, reply);
            if (!asyncKeep && !settled) {
              // Sync handlers must call reply; if they forgot, still settle.
              settled = true;
              resolve({ ok: true, payload: null });
            }
          } catch (err) {
            resolve({
              ok: false,
              payload: { success: false, error: err instanceof Error ? err.message : String(err) },
            });
          }
        });
      },
      args: [message],
    });
  } catch (err) {
    return {
      status: emptyStatus(),
      frames: [],
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const frames = results.map((r) => r.result?.payload ?? null);
  const statuses: TranslateStatus[] = [];
  let success = false;
  let error: string | undefined;

  for (const payload of frames) {
    if (!payload || typeof payload !== 'object') continue;
    const p = payload as Record<string, unknown>;
    if ('count' in p || 'total' in p || 'watching' in p || 'translating' in p) {
      statuses.push(payload as TranslateStatus);
    }
    if (p.success === true) success = true;
    if (p.success === false && typeof p.error === 'string' && !error) error = p.error;
  }

  // getStatus / ping may not set success — treat any payload as ok.
  if (!success && frames.some((f) => f != null)) {
    const action = message.action;
    if (action === 'getStatus' || action === 'ping' || action === 'restoreOriginal') {
      success = true;
    }
  }

  return {
    status: aggregateStatuses(statuses),
    frames,
    success,
    error: success ? undefined : error || 'no frame responded',
  };
}

/** Convenience: broadcast and return a popup-friendly translate/restore result. */
export async function sendToContentFrames(
  tabId: number,
  message: ContentRequest,
): Promise<Record<string, unknown>> {
  const relay = await broadcastToFrames(tabId, message);
  if (message.action === 'getStatus') {
    return { ...relay.status, success: relay.success };
  }
  if (message.action === 'ping') {
    return { pong: relay.success, success: relay.success };
  }
  // Prefer the richest successful frame payload for sessionId etc.
  const primary =
    (relay.frames.find((f) => f && typeof f === 'object' && (f as { success?: boolean }).success) as
      | Record<string, unknown>
      | undefined)
    ?? (relay.frames.find((f) => f && typeof f === 'object') as Record<string, unknown> | undefined)
    ?? {};
  return {
    ...primary,
    success: relay.success,
    count: relay.status.count || (primary.count as number | undefined) || 0,
    failed: relay.status.failed || (primary.failed as number | undefined) || 0,
    total: relay.status.total || (primary.total as number | undefined) || 0,
    watching: relay.status.watching || Boolean(primary.watching),
    shadowRoots: relay.status.shadowRoots,
    frames: relay.status.frames,
    error: relay.success ? primary.error : relay.error || primary.error,
  };
}
