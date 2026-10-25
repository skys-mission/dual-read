/** Registered only with YouTube host access. Translation has a separate opt-in. */
export default defineUnlistedScript(() => {
  if (window.top !== window) return;
  const bootstrap = () => { void chrome.runtime.sendMessage({ action: 'subtitles:autoStart' }).catch(() => {}); };
  document.addEventListener('yt-navigate-finish', bootstrap);
  bootstrap();
});
