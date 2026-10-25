import type { SubtitleConfig, SubtitlePreferences, SubtitleStatus } from './types';
import { subtitlePreferencesForm, subtitleText } from './preferences-ui';

export const SUBTITLE_OWNED = '[data-dual-read-subtitle-ui]';
export const SUBTITLE_MANAGED = '[data-dual-read-subtitle-source]';

export function subtitleStateKey(state: SubtitleStatus['state']): string {
  return `subtitleState${state.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('')}`;
}

/** All text is textContent. Native caption nodes/attributes are never edited. */
export class SubtitleRenderer {
  readonly host = document.createElement('div');
  private readonly controlHost = document.createElement('div');
  private readonly nativeStyle = document.createElement('style');
  private readonly token = `s${crypto.randomUUID().replaceAll('-', '')}`;
  private readonly source = document.createElement('span');
  private readonly translation = document.createElement('span');
  private readonly lines = document.createElement('div');
  private readonly button = document.createElement('button');
  private readonly arrow = document.createElement('button');
  private readonly panel = document.createElement('div');
  private readonly status = document.createElement('p');
  private readonly resize: ResizeObserver;
  private readonly abort = new AbortController();
  private lastText = '';
  private config: SubtitleConfig;

  constructor(readonly player: HTMLElement, config: SubtitleConfig, private readonly callbacks: {
    toggle: () => void;
    preferences: (value: SubtitlePreferences) => Promise<void>;
    options: () => void;
  }) {
    this.config = config;
    for (const host of [this.host, this.controlHost, this.nativeStyle]) host.setAttribute('data-dual-read-subtitle-ui', '');
    this.host.style.cssText = 'all:initial;position:absolute;inset:0;display:block;pointer-events:none;z-index:55;';
    const root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `.lines{font-family:system-ui,sans-serif;color:#fff;font-weight:400;position:absolute;left:6%;right:6%;bottom:52px;text-align:center;font-size:var(--size,22px);line-height:1.35;overflow-wrap:anywhere;text-shadow:0 1px 2px #000}
      .lines[data-position=top]{bottom:auto;top:48px}.line{display:table;margin:2px auto;padding:2px 7px;white-space:pre-line;border-radius:3px;background:rgba(0,0,0,.8);max-width:100%;box-sizing:border-box}.source{font-size:.88em}.line:empty{display:none}`;
    this.lines.className = 'lines'; this.source.className = 'line source'; this.translation.className = 'line';
    this.source.dir = 'auto'; this.translation.dir = 'auto';
    this.lines.append(this.source, this.translation); root.append(style, this.lines);
    this.nativeStyle.textContent = `[data-dual-read-subtitle-source="${this.token}"] .ytp-caption-window-container{visibility:hidden!important}
      [data-dual-read-subtitle-menu="${this.token}"] .ytp-chrome-bottom{opacity:1!important;visibility:visible!important}`;
    player.append(this.nativeStyle, this.host);

    this.controlHost.style.cssText = 'all:initial;display:inline-flex;position:relative;height:100%;vertical-align:top;pointer-events:auto;';
    const controls = this.controlHost.attachShadow({ mode: 'open' });
    const controlStyle = document.createElement('style');
    controlStyle.textContent = `:host{font-family:system-ui,sans-serif;color:#fff}button,select{font:inherit}button{cursor:pointer} .toggle,.arrow{border:0;color:white;background:transparent;min-width:24px;height:100%;font-size:13px;padding:0 7px}.toggle[aria-pressed=true]{box-shadow:inset 0 -3px #60a5fa;color:#93c5fd}.arrow{padding:0 5px}button:focus-visible,select:focus-visible{outline:2px solid #93c5fd;outline-offset:-2px}
      .panel{position:absolute;bottom:calc(100% + 8px);right:0;width:264px;max-width:var(--panel-width,264px);max-height:var(--panel-height,320px);overflow:auto;box-sizing:border-box;background:#202124;color:#fff;border:1px solid #555;border-radius:10px;padding:14px;box-shadow:0 8px 28px #0008;font-size:13px;line-height:1.4;z-index:70}.panel[hidden]{display:none}.status{margin:0 0 10px;color:#ddd}.subtitle-preferences label{display:block;margin:10px 0}.subtitle-preferences select{display:block;box-sizing:border-box;width:100%;margin-top:4px;padding:6px;color:inherit;background:#303134;border:1px solid #777;border-radius:5px}.subtitle-preferences button{color:inherit;border:0;background:transparent;text-align:start;padding:0;line-height:1.5} @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}`;
    this.button.type = 'button'; this.button.className = 'toggle';
    this.arrow.type = 'button'; this.arrow.className = 'arrow'; this.arrow.textContent = '▾';
    this.arrow.setAttribute('aria-expanded', 'false'); this.arrow.setAttribute('aria-controls', this.token);
    this.panel.id = this.token; this.panel.className = 'panel'; this.panel.hidden = true;
    this.panel.setAttribute('role', 'dialog');
    this.status.className = 'status'; this.status.setAttribute('role', 'status');
    this.panel.append(this.status);
    controls.append(controlStyle, this.button, this.arrow, this.panel);
    this.button.addEventListener('click', event => { event.stopPropagation(); callbacks.toggle(); });
    this.arrow.addEventListener('click', event => { event.stopPropagation(); this.open(this.panel.hidden); });
    controls.addEventListener('focusin', () => this.updateControlVisibility());
    controls.addEventListener('focusout', () => { setTimeout(() => this.updateControlVisibility(), 0); });
    controls.addEventListener('keydown', event => {
      if ((event as KeyboardEvent).key === 'Escape' && !this.panel.hidden) {
        event.stopPropagation(); event.preventDefault(); this.open(false); this.arrow.focus();
      }
    });
    // Keyboard interaction within the settings must not seek/pause the video.
    this.panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); this.open(false); this.arrow.focus(); }
      event.stopPropagation();
    });
    document.addEventListener('pointerdown', event => {
      if (!event.composedPath().includes(this.controlHost)) this.open(false);
    }, { signal: this.abort.signal });
    document.addEventListener('scroll', () => { if (!this.panel.hidden) this.layout(); }, { capture: true, passive: true, signal: this.abort.signal });
    const container = player.querySelector('.ytp-right-controls');
    const cc = container?.querySelector('.ytp-subtitles-button');
    if (container && cc) container.insertBefore(this.controlHost, cc.nextSibling);
    this.resize = new ResizeObserver(() => this.layout()); this.resize.observe(player);
    this.configure(config);
  }
  private open(value: boolean): void {
    if (value) this.layout();
    this.panel.hidden = !value;
    this.arrow.setAttribute('aria-expanded', String(value));
    this.updateControlVisibility();
  }
  private updateControlVisibility(): void {
    if (!this.abort.signal.aborted && (!this.panel.hidden || this.controlHost.shadowRoot?.activeElement)) this.player.setAttribute('data-dual-read-subtitle-menu', this.token);
    else if (this.player.getAttribute('data-dual-read-subtitle-menu') === this.token) this.player.removeAttribute('data-dual-read-subtitle-menu');
  }
  private layout(): void {
    const rect = this.player.getBoundingClientRect();
    const factor = this.config.preferences.textSize === 'small' ? .8 : this.config.preferences.textSize === 'large' ? 1.25 : 1;
    this.host.style.setProperty('--size', `${Math.max(14, Math.min(34, rect.width / 36)) * factor}px`);
    this.controlHost.style.setProperty('--panel-width', `${Math.max(100, rect.width - 32)}px`);
    // At browser zoom or after scrolling, only part of the player may be in
    // view. Keep the menu above the control and inside the visible viewport.
    const visibleAbove = this.controlHost.getBoundingClientRect().top - Math.max(0, rect.top) - 12;
    this.controlHost.style.setProperty('--panel-height', `${Math.max(48, Math.min(rect.height - 90, visibleAbove, innerHeight - 60))}px`);
    this.arrow.hidden = rect.width < 380;
    this.button.textContent = rect.width < 380 ? 'CC+' : subtitleText(this.config, 'subtitleBilingual');
  }
  configure(config: SubtitleConfig): void {
    this.config = config;
    this.lines.dataset.position = config.preferences.position;
    this.translation.lang = config.targetLang;
    const label = subtitleText(config, 'subtitleOptions');
    this.arrow.setAttribute('aria-label', label); this.panel.setAttribute('aria-label', label);
    this.panel.querySelector('.subtitle-preferences')?.remove();
    this.panel.append(subtitlePreferencesForm(config, { change: this.callbacks.preferences, auto: async () => config.youtubeAuto, autoInSettings: this.callbacks.options }));
    this.layout();
  }
  updateStatus(value: SubtitleStatus): void {
    this.button.setAttribute('aria-pressed', String(value.enabled));
    this.button.setAttribute('aria-label', subtitleText(this.config, value.enabled ? 'subtitleDisable' : 'subtitleEnable'));
    this.button.title = subtitleText(this.config, subtitleStateKey(value.state));
    this.status.textContent = this.button.title;
  }
  show(source: string, translation: string, sourceLanguage: string): void {
    const key = JSON.stringify([source, translation, sourceLanguage]);
    if (key === this.lastText) return;
    this.lastText = key;
    this.source.textContent = source; this.translation.textContent = translation; this.source.lang = sourceLanguage;
    if (source) this.player.setAttribute('data-dual-read-subtitle-source', this.token);
    else if (this.player.getAttribute('data-dual-read-subtitle-source') === this.token) this.player.removeAttribute('data-dual-read-subtitle-source');
  }
  dispose(): void {
    this.show('', '', ''); this.open(false); this.abort.abort(); this.resize.disconnect();
    this.controlHost.remove(); this.host.remove(); this.nativeStyle.remove();
    this.updateControlVisibility();
  }
}
