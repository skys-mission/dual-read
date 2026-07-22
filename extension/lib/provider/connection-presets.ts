import type { ConnectionMode } from '../types';
import {
  DEFAULT_API_BASE, DEFAULT_MODEL, DEFAULT_PROXY_API_BASE,
} from '../settings/schema';

export interface ConnectionPreset {
  mode: ConnectionMode;
  labelKey: 'connectionModeDirect' | 'connectionModeProxy';
  hintKey: 'connectionModeDirectHint' | 'connectionModeProxyHint';
  apiBase: string;
  model: string;
}

/**
 * The extension supports one API protocol with two connection routes:
 * direct to an API provider, or through the repository's Dual Read proxy.
 */
export const CONNECTION_PRESETS: readonly ConnectionPreset[] = [
  {
    mode: 'direct',
    labelKey: 'connectionModeDirect',
    hintKey: 'connectionModeDirectHint',
    apiBase: DEFAULT_API_BASE,
    model: DEFAULT_MODEL,
  },
  {
    mode: 'proxy',
    labelKey: 'connectionModeProxy',
    hintKey: 'connectionModeProxyHint',
    apiBase: DEFAULT_PROXY_API_BASE,
    model: DEFAULT_MODEL,
  },
] as const;

export function getConnectionPreset(mode: ConnectionMode): ConnectionPreset {
  return CONNECTION_PRESETS.find((preset) => preset.mode === mode) ?? CONNECTION_PRESETS[0]!;
}
