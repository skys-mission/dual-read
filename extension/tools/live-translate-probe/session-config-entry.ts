import { buildPublicSessionConfig } from '../../lib/settings/session-config';
import { getSettings, hostOf } from '../../lib/settings/storage';

/** Executed in the trusted background; only the public config leaves it. */
export async function configForTab(tabId: number) {
  const tab = await chrome.tabs.get(tabId);
  return buildPublicSessionConfig(await getSettings(), hostOf(tab.url));
}
