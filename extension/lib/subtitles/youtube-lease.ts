/**
 * A tiny MAIN-world lease owns only the native CC switch. Keeping the original
 * node reference and querying the current native track here makes restoration
 * safe even when a track changes between an isolated-world check and cleanup.
 * No credentials or caption payloads are retained in the page.
 */
export function manageYouTubeCaptionLease(options: { action: 'acquire' | 'release'; token: string; videoId: string; deferActivation?: boolean }): boolean {
  const page = window as Window & { __dualReadSubtitleCCLease?: { token: string; activate: () => boolean; dispose: () => void } };
  if (options.action === 'release') {
    if (page.__dualReadSubtitleCCLease?.token === options.token) page.__dualReadSubtitleCCLease.dispose();
    return true;
  }
  if (page.__dualReadSubtitleCCLease?.token === options.token) return true;
  page.__dualReadSubtitleCCLease?.dispose();
  const player = document.querySelector('#movie_player') as HTMLElement & {
    getPlayerResponse?: () => { videoDetails?: { videoId?: string } };
    getVideoData?: () => { video_id?: string };
    getOption?: (module: string, name: string) => { vssId?: string; vss_id?: string; translationLanguage?: { languageCode?: string } };
  } | null;
  const cc = player?.querySelector<HTMLButtonElement>('.ytp-subtitles-button');
  const sameVideo = () => {
    const id = player?.getPlayerResponse?.()?.videoDetails?.videoId;
    const data = player?.getVideoData?.()?.video_id;
    return document.querySelector('#movie_player') === player && id === options.videoId && (!data || data === id)
      && new URL(location.href).searchParams.get('v') === id;
  };
  if (!player || !cc || !sameVideo()) return false;
  const trackId = () => {
    const t = player.getOption?.('captions', 'track');
    const id = t?.vssId ?? t?.vss_id;
    return id ? JSON.stringify([id, t?.translationLanguage?.languageCode ?? Boolean(t?.translationLanguage)]) : undefined;
  };
  const initial = cc.getAttribute('aria-pressed');
  let owned = false;
  let clicking = false;
  let disposed = false;
  let touched = false;
  let activated = false;
  let selected: string | undefined;
  let menuTimer: ReturnType<typeof setTimeout> | undefined;
  const inAd = () => player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
  const external = () => {
    if (clicking || disposed || !sameVideo() || player.querySelector('.ytp-subtitles-button') !== cc || inAd()) return;
    owned = false; touched = true;
    if (cc.getAttribute('aria-pressed') === 'false') {
      document.dispatchEvent(new Event(`dual-read:subtitles-cc-off:${options.token}`));
    }
  };
  const onCCClick = () => {
    if (!clicking && !disposed && sameVideo() && !inAd()) { owned = false; touched = true; }
  };
  const menuChanged = (event: Event) => {
    if (!(event.target instanceof Element) || !event.target.closest('.ytp-settings-menu')) return;
    // Read after the native handler, including Chromium's isolated/MAIN-world
    // event ordering. Speed/quality changes do not relinquish caption ownership.
    clearTimeout(menuTimer);
    menuTimer = setTimeout(() => {
      if (!disposed && sameVideo() && !inAd() && selected && trackId() !== selected) { owned = false; touched = true; }
    }, 0);
  };
  cc.addEventListener('click', onCCClick, true);
  player.addEventListener('click', menuChanged, true);
  const attributes = (records: MutationRecord[]) => {
    if (records.some((r, i) => r.oldValue !== (i + 1 < records.length ? records[i + 1].oldValue : cc.getAttribute('aria-pressed')))) external();
  };
  const observer = new MutationObserver(attributes);
  observer.observe(cc, { attributes: true, attributeFilter: ['aria-pressed'], attributeOldValue: true });
  const activate = () => {
    attributes(observer.takeRecords());
    if (disposed || !sameVideo() || touched) return false;
    if (!activated && initial === 'false' && cc.getAttribute('aria-pressed') === 'false') {
      clicking = true;
      try { cc.click(); owned = cc.getAttribute('aria-pressed') === 'true'; } finally { observer.takeRecords(); clicking = false; }
    }
    activated = true; selected = trackId();
    return cc.getAttribute('aria-pressed') === 'true';
  };
  const releaseEvent = `dual-read:subtitles-release:${options.token}`;
  const dispose = () => {
    if (disposed) return;
    // Pending records can record an external change, but must not emit a new
    // stop while a lease is being released for a restart/navigation.
    const records = observer.takeRecords();
    if (records.some((r, i) => r.oldValue !== (i + 1 < records.length ? records[i + 1].oldValue : cc.getAttribute('aria-pressed'))) && !inAd()) owned = false;
    disposed = true; observer.disconnect(); clearTimeout(menuTimer);
    cc.removeEventListener('click', onCCClick, true); player.removeEventListener('click', menuChanged, true);
    document.removeEventListener('dual-read:subtitles-destroy', dispose);
    document.removeEventListener('yt-navigate-start', dispose);
    document.removeEventListener(releaseEvent, dispose);
    if (page.__dualReadSubtitleCCLease?.token === options.token) delete page.__dualReadSubtitleCCLease;
    try {
      if (owned && selected && sameVideo() && player.querySelector('.ytp-subtitles-button') === cc
        && trackId() === selected && cc.getAttribute('aria-pressed') === 'true') cc.click();
    } catch { /* Page teardown or private player API changed. */ }
  };
  page.__dualReadSubtitleCCLease = { token: options.token, activate, dispose };
  document.addEventListener('dual-read:subtitles-destroy', dispose);
  document.addEventListener('yt-navigate-start', dispose);
  // A loaded content script must be able to release ownership even after
  // the browser revokes permission for new MAIN-world script execution.
  document.addEventListener(releaseEvent, dispose);
  return options.deferActivation ? true : activate();
}
