/** Registered only after this device opts in and grants YouTube host access. */
export default defineUnlistedScript(() => {
  if (window.top !== window) return;
  const bootstrap = () => { void chrome.runtime.sendMessage({ action: 'subtitles:autoStart' }).catch(() => {}); };
  document.addEventListener('yt-navigate-finish', bootstrap);
  bootstrap();
});
