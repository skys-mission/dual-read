export type TranslationMode = 'bilingual' | 'replace';
export type ConnectionMode = 'direct' | 'proxy';

export type TargetLang = 'zh-CN' | 'en' | 'ru' | 'es' | 'fr';

/** Languages available for extension UI chrome (independent of translation target). */
export type UiLocale = 'en' | 'zh-CN' | 'zh-TW' | 'ru' | 'es' | 'fr';

export interface SiteRule {
  /** Hostname (lowercased, no port). */
  host: string;
  /** When true, never translate this site (blacklist). */
  disabled?: boolean;
  /** When true, translate automatically on page load. */
  auto?: boolean;
  mode?: TranslationMode;
  targetLang?: TargetLang;
}

/** Full settings — trusted contexts only (background / options / popup). */
export interface Settings {
  /** Schema version; older storage is migrated before use. */
  schemaVersion: 4;
  /**
   * Direct requests use the extension's API key. Proxy requests use the
   * repository's OpenAI V1-compatible Dual Read proxy and may omit that key.
   */
  connectionMode: ConnectionMode;
  apiBase: string;
  apiKey: string;
  model: string;
  targetLang: TargetLang;
  /** Interface language; independent of translation target. */
  uiLocale: UiLocale;
  mode: TranslationMode;
  maxConcurrent: number;
  batchSize: number;
  customHeaders: Record<string, string>;
  siteRules: SiteRule[];
  /**
   * Monotonic revision bumped on every save that affects translation or
   * provider identity. Content sessions compare this instead of deep equality.
   */
  revision: number;
}

/**
 * Public session config sent to content scripts. Never includes API keys,
 * custom secret headers, or raw endpoint credentials.
 */
export interface PublicSessionConfig {
  sessionId: string;
  revision: number;
  targetLang: TargetLang;
  uiLocale: UiLocale;
  mode: TranslationMode;
  maxConcurrent: number;
  batchSize: number;
  /** Irreversible provider identity for cache keys. */
  providerFingerprint: string;
  disabled: boolean;
}

/** Kind determines how a translation is mounted next to the original. */
export type UnitKind = 'block' | 'inner' | 'inline' | 'nav';

/**
 * Rich (structured) bilingual unit: keep a *safe* inline skeleton
 * (links, code, emphasis) and only translate the text-node slots.
 * Renderer rebuilds allowlisted markup — never cloneNode identity attrs.
 */
export interface RichMeta {
  /** Translatable text-node values in document order (NO_TEXT parents skipped). */
  slots: string[];
}

export interface TranslationUnit {
  el: HTMLElement;
  /** Joined plain text (cache key / skip detection / logging). */
  text: string;
  kind: UnitKind;
  /** Present for mixed-content segments (replace-mode aware). */
  nodes?: Text[];
  segment?: boolean;
  /** When set, render via safe rich skeleton + filled slots. */
  rich?: RichMeta;
}


/** Payload handed from scheduler → renderer. */
export type TranslationPayload = string | string[];

export interface TranslateStatus {
  translating: boolean;
  count: number;
  failed: number;
  total: number;
  watching: boolean;
  sessionId?: string;
  revision?: number;
  /** Open / feature-detected shadow roots currently watched in this frame. */
  shadowRoots?: number;
  /** iframe barriers visible from this frame (same-origin handled via allFrames). */
  frames?: {
    sameOrigin: number;
    crossOrigin: number;
    opaque: number;
  };
  /**
   * Lightweight wall-clock timings for the perf lab.
   * Optional — absent on older builds / empty status.
   */
  perf?: {
    /** Last full-document index active CPU ms (excludes cooperative yield waits). */
    lastIndexMs?: number;
    /** Last MutationObserver incremental index, ms. */
    lastMutationIndexMs?: number;
  };
}

