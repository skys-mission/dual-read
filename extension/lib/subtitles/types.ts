import type { PublicSessionConfig, TargetLang } from '../types';

export interface SubtitlePreferences {
  targetLang: TargetLang | null;
  textSize: 'small' | 'medium' | 'large';
  position: 'bottom' | 'top';
}

export interface SubtitleCue {
  id: string;
  revision: number;
  startMs: number;
  endMs: number;
  text: string;
  /** Stable adjacent context, selected before cache lookup or batching. */
  context: string;
}

export interface SubtitleIdentity {
  videoId: string;
  trackId: string;
  generation: number;
}

export interface SubtitleItem {
  id: string;
  revision: number;
  text: string;
  context: string;
}

export interface SubtitleTranslation {
  id: string;
  revision: number;
  text: string;
}

export type SubtitleState = 'off' | 'preparing' | 'ready' | 'catching-up' | 'realtime'
  | 'no-tracks' | 'source-error' | 'translation-error' | 'same-language' | 'unsupported' | 'original-required';

export interface SubtitleStatus {
  enabled: boolean;
  state: SubtitleState;
  sourceLanguage?: string;
  kind?: 'manual' | 'asr';
  retryAt?: number;
}

export interface SubtitleConfig extends PublicSessionConfig {
  preferences: SubtitlePreferences;
  youtubeAuto: boolean;
  /** Prepared in the background: content scripts need no packaged-file fetch. */
  messages?: Record<string, string>;
}

export const YOUTUBE_ORIGIN = 'https://www.youtube.com';
export const YOUTUBE_PERMISSION = `${YOUTUBE_ORIGIN}/*`;
export const SUBTITLE_PROTOCOL_VERSION = 'subtitle-v1';

export function youtubeVideoId(raw: string | undefined): string | null {
  try {
    const url = new URL(raw ?? '');
    const id = url.searchParams.get('v');
    return url.origin === YOUTUBE_ORIGIN && url.pathname === '/watch' && id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

export function sameSubtitleLanguage(source: string, target: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/_/g, '-');
  const a = normalize(source);
  const b = normalize(target);
  // Do not conflate Traditional Chinese with the Simplified Chinese target.
  if (b === 'zh-cn') return ['zh', 'zh-cn', 'zh-hans'].includes(a);
  return a.split('-')[0] === b.split('-')[0];
}
