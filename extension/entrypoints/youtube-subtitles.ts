import { SubtitleSession } from '../lib/subtitles/session';
import type { SubtitleConfig } from '../lib/subtitles/types';

export default defineUnlistedScript(() => {
  if (window.top !== window) return;
  document.dispatchEvent(new Event('dual-read:subtitles-destroy'));
  const instanceId = crypto.randomUUID();
  const session = new SubtitleSession();
  let disposed = false;
  const listener = (message: { action?: string; enabled?: boolean; config?: SubtitleConfig; instanceId?: string }, _sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => {
    if (disposed) return;
    if (message?.action === 'subtitle:ping') { reply({ ready: true, instanceId }); return; }
    if (message?.action === 'subtitle:status') { reply(session.getStatus()); return; }
    if (message?.action === 'subtitle:apply') {
      if (message.instanceId && message.instanceId !== instanceId) { reply({ success: false }); return; }
      session.apply(message.enabled === true, message.config);
      reply({ success: !disposed });
      return;
    }
  };
  const destroy = () => {
    if (disposed) return;
    disposed = true;
    session.dispose();
    document.removeEventListener('dual-read:subtitles-destroy', destroy);
    try { chrome.runtime.onMessage.removeListener(listener); } catch { /* orphan */ }
  };
  document.addEventListener('dual-read:subtitles-destroy', destroy);
  chrome.runtime.onMessage.addListener(listener);
});
