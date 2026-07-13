import type { PublicSessionConfig, TranslateStatus } from '../types';
import { restoreDom } from '../renderer';
import { ContentSession, configChanged, type PageResult } from './session';

export type { PageResult, DisposeReason } from './session';
export { ContentSession, configChanged } from './session';

/**
 * Frame-scoped active session. Stored on globalThis (not module scope) so
 * re-injecting dual-read.js after an extension reload can re-bind handlers
 * without orphaning a live ContentSession — module state resets on every exec.
 */
const SESSION_KEY = '__DUAL_READ_SESSION__';

interface SessionHolder {
  active: ContentSession | null;
}

function holder(): SessionHolder {
  const g = globalThis as typeof globalThis & { [SESSION_KEY]?: SessionHolder };
  if (!g[SESSION_KEY]) g[SESSION_KEY] = { active: null };
  return g[SESSION_KEY];
}

function getActive(): ContentSession | null {
  return holder().active;
}

function setActive(session: ContentSession | null): void {
  holder().active = session;
}

export function getActiveSession(): ContentSession | null {
  const active = getActive();
  return active?.alive ? active : null;
}

export function stopWatch(): void {
  getActive()?.pause();
}

export function retryFailed(): { success: boolean; retried: number; sessionId?: string } {
  const session = getActiveSession();
  if (!session) return { success: false, retried: 0 };
  const retried = session.retryFailed();
  return { success: true, retried, sessionId: session.id };
}

export function getStatus(): TranslateStatus {
  const active = getActive();
  if (!active) {
    return {
      translating: false,
      count: 0,
      failed: 0,
      total: 0,
      watching: false,
    };
  }
  if (!active.alive) {
    const stale = active.status();
    return {
      translating: false,
      count: stale.count,
      failed: stale.failed,
      total: stale.total,
      watching: false,
      sessionId: stale.sessionId,
      revision: stale.revision,
    };
  }
  return active.status();
}

export function restoreOriginal(): void {
  const active = getActive();
  if (active) {
    active.restore();
    setActive(null);
    return;
  }
  restoreDom();
}

export function isTranslated(): boolean {
  return Boolean(document.querySelector('[data-dual-read-done]')) || Boolean(getActiveSession());
}

/**
 * Start or reuse a translation session for the given public config.
 * Disposes the previous session when config identity changes.
 */
export async function translatePage(config: PublicSessionConfig): Promise<PageResult> {
  if (config.disabled) {
    const active = getActive();
    if (active) {
      active.dispose('disabled');
      setActive(null);
    }
    return {
      success: false,
      count: 0,
      failed: 0,
      total: 0,
      watching: false,
      error: 'This site is disabled in Dual Read site rules',
      code: 'PAGE_UNSUPPORTED',
      sessionId: config.sessionId,
    };
  }

  const current = getActiveSession();
  if (current) {
    const status = current.status();
    // Same provider/config identity and already working — no-op.
    if (!configChanged(current.config, config) && (status.translating || status.watching)) {
      if (!status.watching) current.resumeWatch();
      const s = current.status();
      return {
        success: true,
        count: s.count,
        failed: s.failed,
        total: s.total,
        watching: true,
        sessionId: current.id,
      };
    }
  }

  const hasExisting = Boolean(document.querySelector('[data-dual-read-done]'));
  const sameConfig = current && !configChanged(current.config, config);

  if (sameConfig && hasExisting) {
    // Re-attach watchers on the existing session (legacy stopWatch + continue).
    current.pause();
    current.resumeWatch();
    const s = current.status();
    return {
      success: true,
      count: s.count,
      failed: s.failed,
      total: s.total,
      watching: true,
      sessionId: current.id,
    };
  }

  // Config changed or first run — tear down previous session and DOM.
  if (current) {
    current.restore();
  } else if (hasExisting) {
    restoreDom();
  }
  setActive(null);

  const session = new ContentSession(config);
  setActive(session);
  const result = await session.start();

  // A newer translatePage may have superseded us.
  if (getActive() !== session) {
    if (session.alive) session.dispose('replace');
    return {
      ...result,
      success: false,
      watching: false,
      error: result.error || 'session superseded',
    };
  }

  if (!session.alive) setActive(null);
  return result;
}
