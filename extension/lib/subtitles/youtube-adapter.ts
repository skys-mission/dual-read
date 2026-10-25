/** Bounded source probe. No translation, persistent request hooks, or player UI. */
export interface YouTubeCaptionEvent {
  tStartMs: number;
  dDurationMs?: number;
  wWinId?: number;
  aAppend?: number;
  segs?: { utf8: string; tOffsetMs?: number }[];
}

export interface YouTubeSourceProbeOptions {
  expectedVideoId: string;
  /** Enable native CC once if necessary; restore only changes still owned by us. */
  enableNativeCC?: boolean;
  /** Production lease activates CC only after this probe installs its hooks. */
  captionLeaseToken?: string;
  timeoutMs?: number;
}

export interface YouTubeSourceProbeResult {
  status: 'ready' | 'no-tracks' | 'unavailable' | 'stale' | 'unsupported';
  reason?: string;
  videoId: string;
  tracks: { id: string; language: string; kind: 'manual' | 'asr' }[];
  trackId?: string;
  sourceLanguage?: string;
  events: YouTubeCaptionEvent[];
  observations: {
    via: 'player' | 'replay' | 'track';
    status: number;
    bytes: number;
    outcome: 'json3' | 'empty' | 'unsupported' | 'too-large' | 'network';
  }[];
  cc: {
    initial: string;
    final: string;
    enabledByProbe: boolean;
    restored: boolean;
    externalChange: boolean;
  };
  elapsedMs: number;
}

/**
 * Runs via scripting.executeScript({ world: 'MAIN', func: probeYouTubeSource }).
 * Keep every runtime dependency inside this function: Chromium and Firefox
 * serialize it, execute in the page, and return structured-clone data directly.
 * Signed URLs, cookies and raw player responses never leave the MAIN world.
 * Diagnostic CC changes are restored before returning. Production passes a
 * separate lease token to keep its owned CC state until the session stops.
 */
export async function probeYouTubeSource(options: YouTubeSourceProbeOptions): Promise<YouTubeSourceProbeResult> {
  type Track = { vssId?: string; vss_id?: string; languageCode?: string; kind?: string; baseUrl?: string };
  type Player = HTMLElement & {
    getPlayerResponse?: () => {
      videoDetails?: { videoId?: string; isLive?: boolean; isLiveContent?: boolean };
      microformat?: { playerMicroformatRenderer?: { liveBroadcastDetails?: { isLiveNow?: boolean } } };
      captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Track[] } };
    };
    getVideoData?: () => { video_id?: string };
    getOption?: (module: string, option: string) => Track | undefined;
  };
  const started = performance.now();
  const limit = Math.min(10_000, Math.max(300, options.timeoutMs ?? 6_000));
  const deadline = started + limit;
  const maxBytes = 4 * 1024 * 1024;
  const result: YouTubeSourceProbeResult = {
    status: 'unavailable', videoId: options.expectedVideoId, tracks: [], events: [], observations: [],
    cc: { initial: 'unknown', final: 'unknown', enabledByProbe: false, restored: false, externalChange: false },
    elapsedMs: 0,
  };
  const done = () => {
    result.elapsedMs = Math.round(performance.now() - started);
    return result;
  };
  const urlVideo = () => new URL(location.href).searchParams.get('v');
  if (location.origin !== 'https://www.youtube.com' || location.pathname !== '/watch'
    || !/^[\w-]{11}$/.test(options.expectedVideoId) || urlVideo() !== options.expectedVideoId) {
    result.status = 'unsupported';
    return done();
  }
  const player = document.querySelector<Player>('#movie_player');
  const readResponse = () => {
    try { return player?.getPlayerResponse?.(); } catch { return undefined; }
  };
  const readSelected = () => {
    try { return player?.getOption?.('captions', 'track'); } catch { return undefined; }
  };
  const sameVideo = () => {
    try {
      const dataId = player?.getVideoData?.().video_id;
      return document.querySelector('#movie_player') === player && urlVideo() === options.expectedVideoId
        && readResponse()?.videoDetails?.videoId === options.expectedVideoId
        && (!dataId || dataId === options.expectedVideoId);
    } catch { return false; }
  };
  if (!player || !sameVideo()) {
    result.status = 'stale';
    result.reason = 'player-video-mismatch';
    return done();
  }
  if (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) {
    result.reason = 'ad-playing';
    return done();
  }
  const response = readResponse();
  // isLiveContent also marks archived livestreams that are ordinary VOD now.
  if (response?.videoDetails?.isLive || response?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow) {
    result.status = 'unsupported';
    result.reason = 'live-video';
    return done();
  }
  const rawTracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(rawTracks)) {
    // A missing private API field does not prove the video has no captions.
    result.reason = 'missing-track-metadata';
    return done();
  }
  if (!rawTracks.length) {
    result.status = 'no-tracks';
    return done();
  }
  const tracks = rawTracks.slice(0, 100).filter(t => typeof t.vssId === 'string'
    && typeof t.languageCode === 'string' && typeof t.baseUrl === 'string');
  result.tracks = tracks.map(t => ({ id: t.vssId!, language: t.languageCode!, kind: t.kind === 'asr' ? 'asr' : 'manual' }));
  const selected = readSelected();
  const selectedId = selected?.vssId ?? selected?.vss_id;
  const matchSelected = (current: Track | undefined) => {
    const id = current?.vssId ?? current?.vss_id;
    if (id) return tracks.find(t => t.vssId === id);
    if (current?.languageCode) return tracks.find(t => t.languageCode === current.languageCode && (t.kind ?? '') === (current.kind ?? ''));
    return undefined;
  };
  // Native CC's selected track wins. Never silently fall back to a different
  // language when a selected identity cannot be matched to current metadata.
  const initialTrack = selectedId || selected?.languageCode ? matchSelected(selected) : tracks[0];
  if (!initialTrack) {
    result.reason = 'selected-track-unavailable';
    return done();
  }
  let track: Track = initialTrack;
  let resolvingSelection = !selectedId && !selected?.languageCode;
  let captured: YouTubeCaptionEvent[] | null = null;
  let observedUrl: string | undefined;
  const refreshSelection = () => {
    // When CC is off, getOption may return {} even when the remembered track
    // is ASR. Resolve once after activation, before matching the native request.
    if (!resolvingSelection) return;
    const current = matchSelected(readSelected());
    if (!current) return;
    if (current.vssId !== track.vssId) { observedUrl = undefined; captured = null; }
    track = current;
    resolvingSelection = false;
    result.trackId = track.vssId;
    result.sourceLanguage = track.languageCode;
  };
  result.trackId = track.vssId;
  result.sourceLanguage = track.languageCode;
  const sameTrack = () => {
    refreshSelection();
    const current = readSelected();
    const currentId = current?.vssId ?? current?.vss_id;
    return currentId ? currentId === track.vssId
      : !current?.languageCode || (current.languageCode === track.languageCode && (current.kind ?? '') === (track.kind ?? ''));
  };
  const cc = player.querySelector<HTMLButtonElement>('.ytp-subtitles-button');
  const ccState = () => cc?.getAttribute('aria-pressed') ?? 'unknown';
  result.cc.initial = ccState();
  let ownsCC = false;
  let clicking = false;
  let disposed = false;
  const abort = new AbortController();
  const pendingXHR = new Map<XMLHttpRequest, () => void>();
  const originalFetch = window.fetch;
  const originalOpen = XMLHttpRequest.prototype.open;

  const isCaptionUrl = (value: string): boolean => {
    refreshSelection();
    try {
      const url = new URL(value, location.href);
      const base = new URL(track.baseUrl!);
      return url.origin === 'https://www.youtube.com' && url.pathname === '/api/timedtext'
        && url.searchParams.get('v') === options.expectedVideoId
        && url.searchParams.get('lang') === track.languageCode
        && (url.searchParams.get('kind') ?? '') === (track.kind ?? '')
        && (url.searchParams.get('name') ?? '') === (base.searchParams.get('name') ?? '')
        && !url.searchParams.has('tlang');
    } catch { return false; }
  };
  const record = (body: string, status: number, via: 'player' | 'replay' | 'track', trackId: string) => {
    if (disposed || trackId !== track.vssId || result.observations.length >= 8) return;
    const bytes = new TextEncoder().encode(body.slice(0, maxBytes + 1)).byteLength;
    let outcome: YouTubeSourceProbeResult['observations'][number]['outcome'] = body.trim() ? 'unsupported' : 'empty';
    if (bytes > maxBytes) outcome = 'too-large';
    else if (status === 200 && body.trim()) {
      try {
        const parsed = JSON.parse(body) as { events?: YouTubeCaptionEvent[] };
        if (Array.isArray(parsed.events) && parsed.events.length <= 50_000) {
          const clean: YouTubeCaptionEvent[] = [];
          for (const event of parsed.events) {
            if (!event || !Number.isFinite(event.tStartMs) || event.tStartMs < 0) continue;
            if (event.segs && (!Array.isArray(event.segs) || event.segs.length > 2_000)) continue;
            const entry: YouTubeCaptionEvent = { tStartMs: event.tStartMs };
            for (const key of ['dDurationMs', 'wWinId', 'aAppend'] as const) {
              if (typeof event[key] === 'number' && Number.isFinite(event[key]) && event[key]! >= 0) entry[key] = event[key];
            }
            if (event.segs) entry.segs = event.segs.filter(s => s && typeof s.utf8 === 'string').map(s => ({
              utf8: s.utf8,
              ...(typeof s.tOffsetMs === 'number' && Number.isFinite(s.tOffsetMs) && s.tOffsetMs >= 0 ? { tOffsetMs: s.tOffsetMs } : {}),
            }));
            clean.push(entry);
          }
          if (clean.some(e => e.dDurationMs && e.segs?.some(s => s.utf8.trim()))) {
            outcome = 'json3';
            captured = clean;
          }
        }
      } catch { /* Non-JSON3 is a diagnosed capability gap, not an empty track. */ }
    }
    result.observations.push({ via, status, bytes, outcome });
  };
  const readBody = async (response: Response, via: 'player' | 'replay' | 'track', trackId: string) => {
    const reader = response.body?.getReader();
    if (!reader) { record('', response.status, via, trackId); return; }
    const decoder = new TextDecoder();
    let bytes = 0;
    let body = '';
    const cancel = () => { void reader.cancel().catch(() => {}); };
    abort.signal.addEventListener('abort', cancel, { once: true });
    try {
      while (!disposed && !abort.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          cancel();
          if (result.observations.length < 8) result.observations.push({ via, status: response.status, bytes, outcome: 'too-large' });
          return;
        }
        body += decoder.decode(chunk.value, { stream: true });
      }
      if (!abort.signal.aborted) record(body + decoder.decode(), response.status, via, trackId);
    } finally { abort.signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  };
  const wrappedFetch: typeof fetch = function (this: Window, input, init) {
    const promise = originalFetch.call(this, input, init);
    if (disposed) return promise;
    const url = input instanceof Request ? input.url : String(input);
    if (isCaptionUrl(url)) {
      observedUrl = new URL(url, location.href).href;
      const trackId = track.vssId!;
      void promise.then(r => { if (!disposed) return readBody(r.clone(), 'player', trackId); }).catch(() => {});
    }
    return promise;
  };
  const wrappedOpen: typeof XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest, method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null,
  ) {
    originalOpen.call(this, method, url, async, username, password);
    if (disposed) return;
    const previous = pendingXHR.get(this);
    if (previous) { this.removeEventListener('loadend', previous); pendingXHR.delete(this); }
    if (!isCaptionUrl(String(url))) return;
    observedUrl = new URL(String(url), location.href).href;
    const trackId = track.vssId!;
    const onLoad = () => {
      pendingXHR.delete(this);
      try {
        if (!this.responseType || this.responseType === 'text') record(this.responseText, this.status, 'player', trackId);
        else if (this.responseType === 'json') record(JSON.stringify(this.response), this.status, 'player', trackId);
      } catch { /* Do not change the page's XHR behavior. */ }
    };
    pendingXHR.set(this, onLoad);
    this.addEventListener('loadend', onLoad, { once: true });
  };
  const onCCClick = () => {
    if (clicking) return;
    ownsCC = false;
    result.cc.externalChange = true;
  };
  const onCCAttributes = (records: MutationRecord[]) => {
    // YouTube may re-render aria-pressed with the same value. Preserve ownership
    // for these writes, but notice even off -> on edits within one microtask.
    if (records.some((record, i) => record.oldValue !== (i + 1 < records.length ? records[i + 1].oldValue : ccState()))) onCCClick();
  };
  const ccObserver = cc ? new MutationObserver(onCCAttributes) : null;
  const clickCC = () => {
    onCCAttributes(ccObserver?.takeRecords() ?? []);
    clicking = true;
    try { cc?.click(); } finally {
      // Attribute changes caused synchronously by our click belong to us.
      ccObserver?.takeRecords();
      clicking = false;
    }
  };
  const wait = async (until: number) => {
    while (!captured && sameVideo() && sameTrack() && performance.now() < until) {
      await new Promise(resolve => setTimeout(resolve, Math.min(40, Math.max(0, until - performance.now()))));
    }
  };
  const timer = setTimeout(() => abort.abort(), limit);
  try {
    // Performance entries are URL candidates only, never proof of caption data.
    for (const entry of performance.getEntriesByType('resource').slice(-2_000)) {
      if (isCaptionUrl(entry.name)) observedUrl = entry.name;
    }
    window.fetch = wrappedFetch;
    XMLHttpRequest.prototype.open = wrappedOpen;
    cc?.addEventListener('click', onCCClick, true);
    if (cc) ccObserver?.observe(cc, { attributes: true, attributeFilter: ['aria-pressed'], attributeOldValue: true });
    if (options.captionLeaseToken) {
      const lease = (window as Window & { __dualReadSubtitleCCLease?: { token: string; activate: () => boolean } }).__dualReadSubtitleCCLease;
      if (lease?.token !== options.captionLeaseToken || !lease.activate()) throw new Error('Caption lease unavailable');
    }
    if (options.enableNativeCC && cc && ccState() === 'false') {
      clickCC();
      ownsCC = ccState() === 'true';
      result.cc.enabledByProbe = ownsCC;
    }
    // Give a fresh native request a chance before making at most one replay.
    await wait(Math.min(deadline, started + Math.min(1_000, limit / 3)));
    if (!captured && sameVideo() && sameTrack() && !abort.signal.aborted) {
      const candidate = observedUrl ?? track.baseUrl!;
      if (isCaptionUrl(candidate)) {
        const url = new URL(candidate, location.href);
        // Preserve the player's token/signature/client parameters. Only the
        // response format is requested; never generate or transplant tokens.
        url.searchParams.set('fmt', 'json3');
        const trackId = track.vssId!;
        try {
          const fetched = await originalFetch.call(window, url.href, { credentials: 'include', signal: abort.signal });
          await readBody(fetched, observedUrl ? 'replay' : 'track', trackId);
        } catch {
          if (result.observations.length < 8) result.observations.push({ via: observedUrl ? 'replay' : 'track', status: 0, bytes: 0, outcome: 'network' });
        }
      }
    }
    await wait(deadline);
    if (!sameVideo() || !sameTrack()) {
      result.status = 'stale';
      result.reason = 'video-or-track-changed';
    } else if (captured) {
      result.status = 'ready';
      result.events = captured;
    } else {
      result.reason = result.observations.some(o => o.outcome === 'empty') ? 'empty-caption-body' : 'caption-source-unavailable';
    }
  } catch {
    result.reason = 'page-api-error';
  } finally {
    disposed = true;
    clearTimeout(timer);
    abort.abort();
    if (window.fetch === wrappedFetch) window.fetch = originalFetch;
    if (XMLHttpRequest.prototype.open === wrappedOpen) XMLHttpRequest.prototype.open = originalOpen;
    for (const [xhr, listener] of pendingXHR) xhr.removeEventListener('loadend', listener);
    pendingXHR.clear();
    onCCAttributes(ccObserver?.takeRecords() ?? []);
    if (ownsCC && sameVideo() && sameTrack() && player.querySelector('.ytp-subtitles-button') === cc && ccState() === 'true') {
      clickCC();
      result.cc.restored = ccState() === result.cc.initial;
    }
    ccObserver?.disconnect();
    cc?.removeEventListener('click', onCCClick, true);
    result.cc.final = player.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') ?? 'unknown';
  }
  return done();
}
