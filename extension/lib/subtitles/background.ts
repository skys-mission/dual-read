import { getSettings, saveSettings, effectiveForHost } from '../settings/storage';
import { buildPublicSessionConfig, settingsForBatch } from '../settings/session-config';
import { subtitlePreferencesSchema } from '../settings/schema';
import { isConnectionConfigured } from '../provider/connection';
import { DualReadError } from '../errors';
import { probeYouTubeSource } from './youtube-adapter';
import { manageYouTubeCaptionLease } from './youtube-lease';
import { YOUTUBE_ORIGIN, YOUTUBE_PERMISSION, youtubeVideoId, type SubtitleConfig, type SubtitleIdentity, type SubtitleItem } from './types';
import type { Settings } from '../types';
import { getUiMessagesByPrefix } from '../i18n';

const INTENT_PREFIX = 'dualReadSubtitleIntent:';
export const AUTO_PENDING_KEY = 'dualReadSubtitleAutoPending';
const AUTO_SCRIPT = 'dual-read-youtube-auto';
interface Intent {
  origin: typeof YOUTUBE_ORIGIN;
  enabled: boolean;
  manual: boolean;
  sessionId: string;
  generation: number;
  videoId?: string;
  trackId?: string;
  sourceLanguage?: string;
}
const fallbackIntents = new Map<number, Intent>();
const sources = new Map<number, Promise<unknown>>();
const mutations = new Map<number, Promise<unknown>>();
const controls = new Map<number, Promise<unknown>>();

async function serial<T>(queue: Map<number, Promise<unknown>>, tabId: number, fn: () => Promise<T>): Promise<T> {
  const next = (queue.get(tabId) ?? Promise.resolve()).catch(() => {}).then(fn);
  queue.set(tabId, next);
  try { return await next; } finally { if (queue.get(tabId) === next) queue.delete(tabId); }
}

async function readIntent(tabId: number): Promise<Intent | undefined> {
  const key = INTENT_PREFIX + tabId;
  if (chrome.storage.session) return (await chrome.storage.session.get(key))[key] as Intent | undefined;
  return fallbackIntents.get(tabId);
}
async function writeIntent(tabId: number, value: Intent | undefined): Promise<void> {
  const key = INTENT_PREFIX + tabId;
  if (chrome.storage.session) {
    if (value) await chrome.storage.session.set({ [key]: value });
    else await chrome.storage.session.remove(key);
  } else if (value) fallbackIntents.set(tabId, value);
  else fallbackIntents.delete(tabId);
}
function newIntent(enabled: boolean, manual: boolean): Intent {
  return { origin: YOUTUBE_ORIGIN, enabled, manual, sessionId: crypto.randomUUID(), generation: -1 };
}
async function updateIntent(tabId: number, update: (current: Intent | undefined) => Intent | undefined): Promise<Intent | undefined> {
  return serial(mutations, tabId, async () => {
    const next = update(await readIntent(tabId));
    await writeIntent(tabId, next);
    return next;
  });
}
function trustedUI(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && Boolean(sender.url?.startsWith(chrome.runtime.getURL('')));
}
function contentSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.frameId === 0 && Boolean(sender.tab?.id) && Boolean(youtubeVideoId(sender.url));
}
async function resolveTab(message: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<chrome.tabs.Tab> {
  const tabId = trustedUI(sender) ? message.tabId : contentSender(sender) ? sender.tab?.id : undefined;
  if (typeof tabId !== 'number') throw new DualReadError('PAGE_UNSUPPORTED');
  const tab = await chrome.tabs.get(tabId);
  if (!youtubeVideoId(tab.url)) throw new DualReadError('PAGE_UNSUPPORTED');
  return tab;
}
async function configFor(settings: Settings, intent: Intent): Promise<SubtitleConfig> {
  return {
    ...await buildPublicSessionConfig(settings, 'www.youtube.com', {
      sessionId: intent.sessionId, mode: 'bilingual', targetLang: settings.subtitles.targetLang ?? settings.targetLang,
    }),
    preferences: settings.subtitles, youtubeAuto: settings.youtubeAuto,
    messages: await getUiMessagesByPrefix('subtitle', settings.uiLocale),
  };
}
async function send(tabId: number, message: unknown): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => null);
}
async function ensureSession(tabId: number): Promise<void> {
  if (await send(tabId, { action: 'subtitle:ping' })) return;
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['youtube-subtitles.js'] });
}
async function start(tabId: number, intent: Intent, settings: Settings): Promise<void> {
  if (!intent.enabled || !isConnectionConfigured(settings) || effectiveForHost(settings, 'www.youtube.com').disabled) return;
  await ensureSession(tabId);
  await send(tabId, { action: 'subtitle:apply', enabled: true, config: await configFor(settings, intent) });
}

/** Self-contained lightweight MAIN read. No URLs, captions, or credentials. */
export function readYouTubeState(): { videoId?: string; trackId?: string; sourceLanguage?: string; ad: boolean; live: boolean; hasTracks: boolean } {
  const p = document.querySelector('#movie_player') as HTMLElement & {
    getPlayerResponse?: () => { videoDetails?: { videoId?: string; isLive?: boolean }; captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: unknown[] } }; microformat?: { playerMicroformatRenderer?: { liveBroadcastDetails?: { isLiveNow?: boolean } } } };
    getVideoData?: () => { video_id?: string };
    getOption?: (module: string, name: string) => { vssId?: string; vss_id?: string; languageCode?: string; translationLanguage?: unknown };
  } | null;
  const r = p?.getPlayerResponse?.();
  const t = p?.getOption?.('captions', 'track');
  const id = r?.videoDetails?.videoId;
  const dataId = p?.getVideoData?.().video_id;
  const matches = id === new URL(location.href).searchParams.get('v') && (!dataId || id === dataId);
  return { videoId: matches ? id : undefined, trackId: t?.vssId ?? t?.vss_id, sourceLanguage: t?.languageCode,
    ad: Boolean(p?.classList.contains('ad-showing') || p?.classList.contains('ad-interrupting')),
    live: Boolean(r?.videoDetails?.isLive || r?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow),
    hasTracks: Boolean(r?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length),
  };
}

export interface SubtitleBatchIdentity extends SubtitleIdentity {
  sessionId: string;
  targetLang: SubtitleConfig['targetLang'];
  providerFingerprint: string;
  sourceLanguage: string;
  items: SubtitleItem[];
}

export async function authorizeSubtitleBatch(raw: SubtitleBatchIdentity, sender: chrome.runtime.MessageSender, settings: Settings): Promise<Settings> {
  if (!contentSender(sender)) throw new DualReadError('PAGE_UNSUPPORTED');
  const tabId = sender.tab!.id!;
  const [tab, intent] = await Promise.all([chrome.tabs.get(tabId), readIntent(tabId)]);
  if (!intent?.enabled || intent.sessionId !== raw.sessionId || intent.generation !== raw.generation
    || intent.videoId !== raw.videoId || youtubeVideoId(tab.url) !== raw.videoId || intent.trackId !== raw.trackId
    || intent.sourceLanguage !== raw.sourceLanguage || effectiveForHost(settings, 'www.youtube.com').disabled) {
    throw new DualReadError('SESSION_CANCELLED');
  }
  if (!/^[a-z]{2,3}(?:-[a-z\d]{2,8})*$/i.test(raw.sourceLanguage) || raw.sourceLanguage.length > 40
    || !Array.isArray(raw.items) || !raw.items.length || raw.items.length > 5) throw new DualReadError('RESPONSE_MALFORMED');
  const ids = new Set<string>();
  let chars = 0;
  for (const item of raw.items) {
    if (!item || typeof item.id !== 'string' || !/^[\w-]{1,100}$/.test(item.id) || ids.has(item.id)
      || !Number.isSafeInteger(item.revision) || item.revision < 1 || typeof item.text !== 'string' || !item.text.trim()
      || item.text.length > 4000 || typeof item.context !== 'string' || item.context.length > 1000) throw new DualReadError('RESPONSE_MALFORMED');
    ids.add(item.id);
    chars += item.text.length + item.context.length;
  }
  if (chars > 8000 || raw.targetLang !== (settings.subtitles.targetLang ?? settings.targetLang)) throw new DualReadError('SESSION_CANCELLED');
  return settingsForBatch(settings, raw);
}

export function installSubtitleBackground(): void {
  let syncingAuto: Promise<void> = Promise.resolve();
  const syncAuto = () => {
    syncingAuto = syncingAuto.catch(() => {}).then(async () => {
      const settings = await getSettings();
      const granted = await chrome.permissions.contains({ origins: [YOUTUBE_PERMISSION] });
      const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_SCRIPT] });
      if (settings.youtubeAuto && granted && !scripts.length) {
        await chrome.scripting.registerContentScripts([{ id: AUTO_SCRIPT, matches: [YOUTUBE_PERMISSION], js: ['youtube-start.js'], runAt: 'document_idle', allFrames: false }]);
      } else if ((!settings.youtubeAuto || !granted) && scripts.length) {
        await chrome.scripting.unregisterContentScripts({ ids: [AUTO_SCRIPT] });
      }
      if (!settings.youtubeAuto || !granted) {
        for (const tab of await chrome.tabs.query({})) {
          if (!tab.id) continue;
          const tabId = tab.id;
          await serial(controls, tabId, async () => {
            let stopped = false;
            await updateIntent(tabId, current => {
              if (current && !current.manual) { stopped = true; return undefined; }
              return current;
            });
            if (stopped) await send(tabId, { action: 'subtitle:apply', enabled: false });
          });
        }
      }
    });
    return syncingAuto;
  };
  const acceptAutoGrant = async () => {
    const pending = (await chrome.storage.local.get(AUTO_PENDING_KEY))[AUTO_PENDING_KEY];
    if (typeof pending !== 'number' || Date.now() - pending > 120_000) return;
    if (!await chrome.permissions.contains({ origins: [YOUTUBE_PERMISSION] })) return;
    await saveSettings({ youtubeAuto: true });
    await chrome.storage.local.remove(AUTO_PENDING_KEY);
    await syncAuto();
  };
  const autoStart = async (tabId: number) => {
    await serial(controls, tabId, async () => {
    const tab = await chrome.tabs.get(tabId);
    if (!youtubeVideoId(tab.url)) return;
    const settings = await getSettings();
    let intent = await readIntent(tabId);
    if (!intent && settings.youtubeAuto && await chrome.permissions.contains({ origins: [YOUTUBE_PERMISSION] })) {
      intent = newIntent(true, false);
      intent = await updateIntent(tabId, current => current ?? intent);
    }
    if (intent?.enabled && (intent.manual || settings.youtubeAuto)) await start(tabId, intent, settings);
    });
  };

  chrome.runtime.onMessage.addListener((raw: unknown, sender, reply) => {
    if (!raw || typeof raw !== 'object') return;
    const message = raw as Record<string, unknown>;
    if (typeof message.action !== 'string' || !message.action.startsWith('subtitles:')) return;
    void (async () => {
      if (message.action === 'subtitles:autoGranted') {
        if (!trustedUI(sender)) throw new DualReadError('PAGE_UNSUPPORTED');
        await acceptAutoGrant();
        return { success: true };
      }
      if (message.action === 'subtitles:preferences') {
        if (!trustedUI(sender) && !contentSender(sender)) throw new DualReadError('PAGE_UNSUPPORTED');
        await saveSettings({ subtitles: subtitlePreferencesSchema.parse(message.preferences) });
        return { success: true };
      }
      if (message.action === 'subtitles:autoOff') {
        if (!trustedUI(sender)) throw new DualReadError('PAGE_UNSUPPORTED');
        await saveSettings({ youtubeAuto: false });
        await chrome.storage.local.remove(AUTO_PENDING_KEY);
        await syncAuto();
        return { success: true };
      }
      if (message.action === 'subtitles:openOptions') {
        if (!contentSender(sender)) throw new DualReadError('PAGE_UNSUPPORTED');
        await chrome.tabs.create({ url: chrome.runtime.getURL('options.html#subtitleSettings') });
        return { success: true };
      }
      const tab = await resolveTab(message, sender);
      const tabId = tab.id!;
      const settings = await getSettings();
      const intent = await readIntent(tabId);
      if (message.action === 'subtitles:release') {
        if (!contentSender(sender) || typeof message.token !== 'string' || typeof message.videoId !== 'string') throw new DualReadError('PAGE_UNSUPPORTED');
        await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN',
          func: manageYouTubeCaptionLease, args: [{ action: 'release', token: message.token, videoId: message.videoId }] });
        return { success: true };
      }
      if (message.action === 'subtitles:describe') {
        return { success: true, supported: true, configured: isConnectionConfigured(settings), disabled: effectiveForHost(settings, 'www.youtube.com').disabled,
          config: await configFor(settings, intent ?? newIntent(false, false)),
          status: await send(tabId, { action: 'subtitle:status' }) ?? { enabled: intent?.enabled ?? false, state: 'off' } };
      }
      if (message.action === 'subtitles:autoStart') { await autoStart(tabId); return { success: true }; }
      if (message.action === 'subtitles:setEnabled') {
        if (typeof message.enabled !== 'boolean') throw new DualReadError('PAGE_UNSUPPORTED');
        if (message.enabled && (!isConnectionConfigured(settings) || effectiveForHost(settings, 'www.youtube.com').disabled)) throw new DualReadError('CONFIG_REQUIRED');
        const enabled = message.enabled;
        await serial(controls, tabId, async () => {
          const next = newIntent(enabled, true);
          await updateIntent(tabId, () => next);
          if (next.enabled) await start(tabId, next, settings);
          else await send(tabId, { action: 'subtitle:apply', enabled: false });
        });
        return { success: true };
      }
      if (!contentSender(sender) || !intent?.enabled || intent.sessionId !== message.sessionId
        || effectiveForHost(settings, 'www.youtube.com').disabled) throw new DualReadError('SESSION_CANCELLED');
      if (message.action === 'subtitles:state') {
        const result = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN', func: readYouTubeState });
        return { success: true, state: result[0]?.result, config: await configFor(settings, intent) };
      }
      if (message.action === 'subtitles:source') {
        const generation = message.generation;
        const videoId = youtubeVideoId(tab.url)!;
        if (!Number.isSafeInteger(generation) || (generation as number) < intent.generation || message.videoId !== videoId) throw new DualReadError('SESSION_CANCELLED');
        const sessionId = intent.sessionId;
        const next = await updateIntent(tabId, latest => {
          if (!latest?.enabled || latest.sessionId !== sessionId || latest.generation > (generation as number)) throw new DualReadError('SESSION_CANCELLED');
          return { ...latest, generation: generation as number, videoId, trackId: undefined, sourceLanguage: undefined };
        });
        // Never install overlapping probes in a page. Older results cannot
        // authorize a later generation after a seek/navigation/retry.
        return serial(sources, tabId, async () => {
          const matches = (latest: Intent | undefined) => latest?.enabled && latest.sessionId === next!.sessionId && latest.generation === next!.generation;
          if (!matches(await readIntent(tabId))) throw new DualReadError('SESSION_CANCELLED');
          const token = `${sessionId}-${generation}`;
          const leased = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN',
            func: manageYouTubeCaptionLease, args: [{ action: 'acquire', token, videoId, deferActivation: true }] });
          if (!leased[0]?.result) throw new DualReadError('PAGE_UNSUPPORTED');
          try {
            const source = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN',
              func: probeYouTubeSource, args: [{ expectedVideoId: videoId, captionLeaseToken: token, enableNativeCC: false, timeoutMs: 6000 }] });
            const result = source[0]?.result;
            await updateIntent(tabId, latest => {
              if (!matches(latest)) throw new DualReadError('SESSION_CANCELLED');
              return { ...latest!, trackId: result?.trackId, sourceLanguage: result?.sourceLanguage };
            });
            return { success: true, result };
          } catch (error) {
            await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN',
              func: manageYouTubeCaptionLease, args: [{ action: 'release', token, videoId }] }).catch(() => {});
            throw error;
          }
        });
      }
      throw new DualReadError('PAGE_UNSUPPORTED');
    })().then(reply, error => reply({ success: false, code: error instanceof DualReadError ? error.code : 'PAGE_UNSUPPORTED' }));
    return true;
  });
  chrome.tabs.onRemoved.addListener(tabId => { void updateIntent(tabId, () => undefined); });
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    // Without broad tabs permission, leaving an allowed origin can redact the
    // new URL entirely. An inaccessible loading/complete tab ends its intent.
    if (info.url && !info.url.startsWith(`${YOUTUBE_ORIGIN}/`) || info.status && !tab.url) {
      void updateIntent(tabId, () => undefined); return;
    }
    if ((info.status === 'complete' || info.url) && youtubeVideoId(tab.url)) void autoStart(tabId).catch(() => {});
  });
  chrome.runtime.onStartup.addListener(() => {
    fallbackIntents.clear();
    void (async () => {
      if (chrome.storage.session) {
        const all = await chrome.storage.session.get(null);
        await chrome.storage.session.remove(Object.keys(all).filter(k => k.startsWith(INTENT_PREFIX)));
      }
      await syncAuto();
    })().catch(() => {});
  });
  chrome.permissions.onAdded.addListener(() => { void acceptAutoGrant().catch(() => {}); });
  chrome.permissions.onRemoved.addListener(() => {
    void (async () => {
      if (await chrome.permissions.contains({ origins: [YOUTUBE_PERMISSION] })) return;
      await saveSettings({ youtubeAuto: false });
      await syncAuto();
      for (const tab of await chrome.tabs.query({})) {
        if (!tab.id) continue;
        const intent = await readIntent(tab.id);
        if (!intent?.enabled) continue;
        let allowed = false;
        if (intent.manual) {
          try { await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: () => true }); allowed = true; } catch { /* grant revoked */ }
        }
        if (!allowed) {
          await serial(controls, tab.id, async () => {
            const next = await updateIntent(tab.id!, current => current?.sessionId === intent.sessionId ? { ...current, enabled: false } : current);
            if (next?.sessionId === intent.sessionId) await send(tab.id!, { action: 'subtitle:apply', enabled: false });
          });
        }
      }
    })().catch(() => {});
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.youtubeAuto) void syncAuto().catch(() => {});
  });
  void syncAuto().catch(() => {});
}
