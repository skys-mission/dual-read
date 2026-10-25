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
    getOption?: (module: string, name: string) => { vssId?: string; vss_id?: string };
  } | null;
  const cc = player?.querySelector<HTMLButtonElement>('.ytp-subtitles-button');
  const sameVideo = () => {
    const id = player?.getPlayerResponse?.()?.videoDetails?.videoId;
    const data = player?.getVideoData?.()?.video_id;
    return document.querySelector('#movie_player') === player && id === options.videoId && (!data || data === id)
      && new URL(location.href).searchParams.get('v') === id;
  };
  if (!player || !cc || !sameVideo()) return false;
  const trackId = () => { const t = player.getOption?.('captions', 'track'); return t?.vssId ?? t?.vss_id; };
  const initial = cc.getAttribute('aria-pressed');
  let owned = false;
  let clicking = false;
  let disposed = false;
  let touched = false;
  let activated = false;
  let selected: string | undefined;
  const external = () => { if (!clicking) { owned = false; touched = true; } };
  const menuChanged = (event: Event) => {
    if (event.target instanceof Element && event.target.closest('.ytp-settings-menu')) owned = false;
  };
  cc.addEventListener('click', external, true);
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
    disposed = true;
    attributes(observer.takeRecords()); observer.disconnect();
    cc.removeEventListener('click', external, true); player.removeEventListener('click', menuChanged, true);
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
