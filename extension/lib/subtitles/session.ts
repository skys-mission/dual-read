import { lookup, store } from '../cache';
import { translateBatchViaPort, isAbortError } from '../messaging';
import { DualReadError } from '../errors';
import { cueAt, nearbyCues, normalizeYouTubeEvents } from './normalize';
import { SubtitleRenderer } from './renderer';
import { sameSubtitleLanguage, SUBTITLE_PROTOCOL_VERSION, youtubeVideoId, type SubtitleConfig, type SubtitleCue, type SubtitleStatus } from './types';
import type { YouTubeSourceProbeResult } from './youtube-adapter';
import type { readYouTubeState } from './background';

type NativeState = ReturnType<typeof readYouTubeState>;

export class SubtitleSession {
  private config?: SubtitleConfig;
  private status: SubtitleStatus = { enabled: false, state: 'off' };
  private generation = 0;
  private epoch = 0;
  private disposed = false;
  private player?: HTMLElement;
  private video?: HTMLVideoElement;
  private renderer?: SubtitleRenderer;
  private videoId = '';
  private trackId = '';
  private sourceLanguage = '';
  private lease?: { token: string; videoId: string };
  private cues: SubtitleCue[] = [];
  private translated = new Map<string, string>();
  private pending = new Set<string>();
  private work = new AbortController();
  private binding = new AbortController();
  private readonly lifetime = new AbortController();
  private pollTimer: ReturnType<typeof setInterval>;
  private frame = 0;
  private polling = false;
  private preparing = false;
  private pumping = false;
  private inFlight = 0;
  private adBlocked = false;
  private checkingTrack = false;
  private realtime = false;
  private domCue?: SubtitleCue;
  private domCounter = 0;
  private domChangedAt = 0;
  private domDispatchedAt = 0;
  private nextPumpAt = 0;

  constructor() {
    this.pollTimer = setInterval(() => { void this.poll(); }, 500);
    document.addEventListener('yt-navigate-start', () => {
      if (!this.status.enabled) return;
      this.checkingTrack = true; this.cancelWork(); this.renderer?.show('', '', '');
    }, { signal: this.lifetime.signal });
    document.addEventListener('yt-navigate-finish', () => {
      if (this.status.enabled) void this.begin();
    }, { signal: this.lifetime.signal });
    chrome.storage.onChanged.addListener(this.onStorage);
  }

  getStatus(): SubtitleStatus { return { ...this.status }; }

  private onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area === 'local' && changes.dualReadCacheGeneration) {
      this.translated.clear(); this.cancelWork(); this.draw();
    }
  };

  private setState(state: SubtitleStatus['state']): void {
    this.status.state = state;
    this.renderer?.updateStatus(this.status);
  }

  private async message<T>(action: string, fields: Record<string, unknown> = {}): Promise<T> {
    const reply = await chrome.runtime.sendMessage({ action: `subtitles:${action}`, sessionId: this.config?.sessionId, ...fields });
    if (!reply?.success) throw new DualReadError(reply?.code ?? 'UPSTREAM_UNAVAILABLE');
    return reply as T;
  }

  apply(enabled: boolean, config?: SubtitleConfig): void {
    if (this.disposed) return;
    if (!enabled) { this.stop(); return; }
    if (!config || config.disabled) { this.stop(); this.renderer?.dispose(); this.renderer = undefined; return; }
    const restart = !this.status.enabled || !this.config || config.sessionId !== this.config.sessionId
      || config.providerFingerprint !== this.config.providerFingerprint || config.targetLang !== this.config.targetLang;
    const changedAppearance = !this.config || config.uiLocale !== this.config.uiLocale || config.youtubeAuto !== this.config.youtubeAuto
      || JSON.stringify(config.preferences) !== JSON.stringify(this.config.preferences);
    this.config = config; this.status.enabled = true;
    if (changedAppearance) this.renderer?.configure(config);
    if (restart) void this.begin();
    else this.renderer?.updateStatus(this.status);
  }

  private cancelWork(): void {
    this.epoch++; this.work.abort(); this.work = new AbortController(); this.pending.clear();
    this.inFlight = 0; this.pumping = false;
    this.nextPumpAt = 0;
  }

  private releaseLease(): void {
    const lease = this.lease;
    this.lease = undefined;
    if (lease) {
      document.dispatchEvent(new Event(`dual-read:subtitles-release:${lease.token}`));
      void this.message('release', lease).catch(() => {});
    }
  }

  private bind(player: HTMLElement, video: HTMLVideoElement): void {
    this.binding.abort(); this.binding = new AbortController();
    if (this.player !== player || !this.renderer?.host.isConnected) {
      this.renderer?.dispose();
      this.renderer = new SubtitleRenderer(player, this.config!, {
        toggle: () => { void this.message('setEnabled', { enabled: !this.status.enabled }).catch(() => this.setState('source-error')); },
        preferences: async preferences => { await this.message('preferences', { preferences }); await this.poll(); },
        options: () => { void this.message('openOptions').catch(() => {}); },
      });
    }
    this.player = player; this.video = video;
    const signal = this.binding.signal;
    for (const type of ['timeupdate', 'pause', 'play', 'ratechange', 'seeked', 'loadedmetadata']) {
      video.addEventListener(type, () => this.draw(), { signal });
    }
    video.addEventListener('seeking', () => {
      this.cancelWork(); this.renderer?.show('', '', ''); this.draw();
    }, { signal });
    player.addEventListener('click', event => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      // Chromium may drain isolated-world microtasks before the MAIN-world
      // click handler runs. Read the native toggle in the next task instead.
      if (event.target.closest('.ytp-subtitles-button')) setTimeout(() => {
        if (!signal.aborted && this.status.enabled && player.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') === 'false') {
          this.stop(); void this.message('setEnabled', { enabled: false }).catch(() => {});
        }
      }, 0);
      if (event.target.closest('.ytp-settings-menu')) {
        this.checkingTrack = true; this.cancelWork(); this.renderer?.show('', '', '');
      }
    }, { capture: true, signal });
  }

  private async begin(): Promise<void> {
    if (!this.status.enabled || !this.config || this.disposed) return;
    const generation = ++this.generation;
    this.cancelWork(); this.releaseLease();
    this.cues = []; this.translated.clear(); this.domCue = undefined; this.realtime = false;
    this.trackId = ''; this.sourceLanguage = ''; delete this.status.sourceLanguage; delete this.status.kind;
    this.renderer?.show('', '', '');
    this.preparing = true; this.checkingTrack = true; this.setState('preparing');
    const current = () => !this.disposed && this.status.enabled && this.generation === generation;
    const videoId = youtubeVideoId(location.href);
    this.videoId = videoId ?? '';
    if (!videoId) { this.preparing = false; this.setState('unsupported'); this.renderer?.dispose(); this.renderer = undefined; return; }
    try {
      let native: NativeState | undefined;
      // SPA often changes the URL before replacing the native player response.
      // Wait only for identity readiness; never repeat the subtitle fetch here.
      for (let attempt = 0; attempt < 8 && current(); attempt++) {
        const response = await this.message<{ state: NativeState }>('state');
        native = response.state;
        if (native?.videoId === videoId) break;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (!current()) return;
      const player = document.querySelector<HTMLElement>('#movie_player');
      const video = player?.querySelector<HTMLVideoElement>('video');
      if (!player || !video || native?.videoId !== videoId) { this.setState('source-error'); return; }
      this.bind(player, video);
      this.renderer!.updateStatus(this.status);
      if (native.live) { this.setState('unsupported'); return; }
      if (native.ad) { this.adBlocked = true; return; }
      this.adBlocked = false;
      if (!native.hasTracks) { this.setState('no-tracks'); return; }
      this.lease = { token: `${this.config.sessionId}-${generation}`, videoId };
      const { result } = await this.message<{ result: YouTubeSourceProbeResult }>('source', { videoId, generation });
      if (!current()) return;
      if (!result || result.videoId !== videoId || result.status === 'stale') { this.setState('source-error'); return; }
      this.trackId = result.trackId ?? ''; this.sourceLanguage = result.sourceLanguage ?? '';
      this.status.sourceLanguage = this.sourceLanguage;
      this.status.kind = result.tracks.find(t => t.id === this.trackId)?.kind;
      if (result.status === 'ready') this.cues = normalizeYouTubeEvents(result.events, this.status.kind ?? 'manual');
      else if (result.status === 'no-tracks') { this.setState('no-tracks'); return; }
      else if (result.status === 'unsupported') { this.setState('unsupported'); return; }
      if (!this.cues.length) {
        if (!this.trackId || !this.sourceLanguage || !this.nativeText()) { this.setState('source-error'); return; }
        this.realtime = true;
      }
      this.checkingTrack = false;
      this.setState(this.realtime ? 'realtime' : sameSubtitleLanguage(this.sourceLanguage, this.config.targetLang) ? 'same-language' : 'catching-up');
      this.loop();
    } catch (error) {
      if (current() && !isAbortError(error)) this.setState('source-error');
    } finally {
      if (current()) { this.preparing = false; this.status.retryAt = Date.now() + 5000; }
    }
  }

  private async poll(): Promise<void> {
    let runtimeValid = false;
    try { runtimeValid = Boolean(chrome.runtime.id); } catch { /* Extension unloaded. */ }
    if (!runtimeValid && !this.disposed) {
      document.dispatchEvent(new Event('dual-read:subtitles-destroy'));
      this.dispose(); return;
    }
    if (!this.status.enabled || !this.config || this.disposed || this.polling) return;
    this.polling = true;
    const generation = this.generation;
    try {
      if (!youtubeVideoId(location.href)) {
        this.renderer?.dispose(); this.renderer = undefined;
        this.cancelWork(); this.releaseLease(); this.setState('unsupported'); return;
      }
      const response = await this.message<{ state: NativeState; config: SubtitleConfig }>('state');
      if (!this.status.enabled || generation !== this.generation) return;
      this.apply(true, response.config);
      if (generation !== this.generation || this.preparing) return;
      const native = response.state;
      if (!native || native.videoId !== youtubeVideoId(location.href)) {
        this.checkingTrack = true; this.renderer?.show('', '', ''); return;
      }
      if (native.ad) {
        if (!this.adBlocked) this.cancelWork();
        this.adBlocked = true; this.renderer?.show('', '', ''); return;
      }
      const playerChanged = document.querySelector('#movie_player') !== this.player || this.player?.querySelector('video') !== this.video;
      if (native.videoId !== this.videoId || playerChanged || (native.trackId && this.trackId && native.trackId !== this.trackId)
        || this.adBlocked && !this.cues.length) {
        void this.begin(); return;
      }
      this.adBlocked = false; this.checkingTrack = false;
      this.draw();
    } catch (error) {
      if (error instanceof DualReadError && error.code === 'SESSION_CANCELLED') this.stop();
      else { this.checkingTrack = true; this.renderer?.show('', '', ''); }
    } finally { this.polling = false; }
  }

  private nativeText(): string {
    return [...this.player?.querySelectorAll('.ytp-caption-segment') ?? []].map(node => node.textContent ?? '').join('').trim();
  }

  private loop(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    const tick = () => {
      this.frame = 0;
      if (this.disposed || !this.status.enabled) return;
      this.draw(); this.frame = requestAnimationFrame(tick);
    };
    tick();
  }

  private draw(): void {
    if (!this.status.enabled || !this.config || this.preparing || !this.video || !this.player || !this.renderer) return;
    if (youtubeVideoId(location.href) !== this.videoId || document.querySelector('#movie_player') !== this.player
      || this.player.classList.contains('ad-showing') || this.player.classList.contains('ad-interrupting') || this.adBlocked || this.checkingTrack) {
      this.renderer.show('', '', ''); return;
    }
    if (['translation-error', 'source-error', 'no-tracks', 'unsupported'].includes(this.status.state)) { this.renderer.show('', '', ''); return; }
    const timeMs = this.video.currentTime * 1000;
    if (this.realtime) {
      const text = this.nativeText();
      if (text !== (this.domCue?.text ?? '')) {
        this.domCue = text ? { id: `d${++this.domCounter}`, revision: 1, text, context: '', startMs: timeMs, endMs: Number.MAX_SAFE_INTEGER } : undefined;
        this.domChangedAt = performance.now();
      }
    }
    const cue = this.realtime ? this.domCue : cueAt(this.cues, timeMs);
    const sameLanguage = sameSubtitleLanguage(this.sourceLanguage, this.config.targetLang);
    const translation = cue && !sameLanguage ? this.translated.get(cue.id) ?? '' : '';
    this.renderer.show(cue?.text ?? '', translation, this.sourceLanguage);
    const nextState = sameLanguage ? 'same-language' : this.realtime ? 'realtime' : cue && !translation ? 'catching-up' : 'ready';
    if (this.status.state !== nextState) this.setState(nextState);
    if (!sameLanguage) void this.pump(timeMs);
  }

  private async pump(timeMs: number): Promise<void> {
    if (!this.config || this.pumping || this.inFlight >= Math.min(2, this.config.maxConcurrent) || !this.status.enabled) return;
    if (this.realtime && (performance.now() - this.domChangedAt < 250 || performance.now() - this.domDispatchedAt < 1000)) return;
    if (performance.now() < this.nextPumpAt) return;
    this.nextPumpAt = performance.now() + 200;
    const candidates = (this.realtime ? this.domCue ? [this.domCue] : [] : nearbyCues(this.cues, timeMs, this.video?.playbackRate ?? 1))
      .filter(c => !this.translated.has(c.id) && !this.pending.has(c.id));
    const selected: SubtitleCue[] = [];
    let chars = 0;
    for (const cue of candidates) {
      if (cue.text.length > 4000) { this.failTranslation(); return; }
      if (selected.length >= 5 || chars + cue.text.length + cue.context.length > 8000) break;
      selected.push(cue); chars += cue.text.length + cue.context.length;
    }
    if (!selected.length) return;
    const epoch = this.epoch;
    const config = this.config;
    const sourceLanguage = this.sourceLanguage;
    const valid = () => !this.disposed && this.status.enabled && this.epoch === epoch;
    const signal = this.work.signal;
    const cacheConfig = { ...config, namespace: 'subtitle-v1' as const };
    const cacheText = (cue: SubtitleCue) => JSON.stringify([SUBTITLE_PROTOCOL_VERSION, sourceLanguage, cue.text, cue.context]);
    for (const cue of selected) this.pending.add(cue.id);
    this.pumping = true;
    let requested = false;
    try {
      const hits = await lookup(selected.map(cacheText), cacheConfig);
      if (!valid()) return;
      hits.forEach((hit, i) => { if (hit) this.translated.set(selected[i].id, hit); });
      const missing = selected.filter((_, i) => !hits[i]);
      if (!missing.length) return;
      this.inFlight++; requested = true; this.pumping = false;
      if (this.realtime) this.domDispatchedAt = performance.now();
      const translations = await translateBatchViaPort(missing.map(c => c.text), {
        config, signal,
        subtitle: { videoId: this.videoId, trackId: this.trackId, generation: this.generation, sourceLanguage,
          items: missing.map(({ id, revision, text, context }) => ({ id, revision, text, context })) },
      });
      if (!valid()) return;
      missing.forEach((cue, i) => this.translated.set(cue.id, translations[i]));
      while (this.translated.size > 1500) this.translated.delete(this.translated.keys().next().value!);
      // Cache complete, validated pairs only. A seek/navigation/clear that
      // supersedes this request cannot write or paint its late response.
      await store(missing.map((cue, i) => ({ text: cacheText(cue), translation: translations[i] })), cacheConfig);
    } catch (error) {
      if (valid() && !isAbortError(error)) this.failTranslation();
    } finally {
      if (valid()) {
        if (requested) this.inFlight--;
        this.pumping = false;
        for (const cue of selected) this.pending.delete(cue.id);
      }
    }
  }

  private failTranslation(): void {
    this.cancelWork(); this.status.retryAt = Date.now() + 5000;
    this.renderer?.show('', '', ''); this.setState('translation-error');
  }

  stop(): void {
    this.status.enabled = false; this.generation++; this.preparing = false;
    this.cancelWork(); this.releaseLease(); this.binding.abort();
    if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0;
    this.cues = []; this.domCue = undefined; this.translated.clear();
    this.renderer?.show('', '', ''); this.setState('off');
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop(); this.disposed = true; this.lifetime.abort(); clearInterval(this.pollTimer);
    try { chrome.storage.onChanged.removeListener(this.onStorage); } catch { /* Extension unloaded. */ }
    this.renderer?.dispose(); this.renderer = undefined;
  }
}
