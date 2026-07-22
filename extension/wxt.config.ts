import { defineConfig } from 'wxt';

// Single source of truth for the extension version; keep in sync with package.json.
export default defineConfig({
  srcDir: '.',
  // No leading dot: Chrome/Edge "Load unpacked" file pickers hide .* directories.
  outDir: 'output',
  // Both Chrome and Firefox (109+) run MV3; this keeps a single background +
  // scripting API surface and matches the pre-migration baseline.
  manifestVersion: 3,
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    icons: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
    action: {
      default_title: 'Dual Read',
      default_icon: {
        16: 'icons/icon16.png',
        32: 'icons/icon32.png',
        48: 'icons/icon48.png',
        128: 'icons/icon128.png',
      },
    },
    permissions: ['storage', 'contextMenus', 'activeTab', 'scripting'],
    host_permissions: ['http://localhost/*', 'http://127.0.0.1/*', 'http://[::1]/*'],
    // Remote hosts must be HTTPS. Loopback HTTP is covered by host_permissions.
    optional_host_permissions: ['https://*/'],
    commands: {
      'toggle-translate': {
        suggested_key: { default: 'Alt+T' },
        description: '__MSG_cmdToggleTranslate__',
      },
      'toggle-mode': {
        suggested_key: { default: 'Alt+M' },
        description: '__MSG_cmdToggleMode__',
      },
    },
    browser_specific_settings: {
      // `data_collection_permissions` is a newer AMO field not yet in the
      // bundled manifest types; cast until upstream types catch up.
      gecko: {
        id: 'dual-read@skysmission.github.io',
        // Firefox 140+ ships built-in data-transmission consent; avoid
        // maintaining a custom consent flow for older versions.
        strict_min_version: '140.0',
        // Firefox data-consent: page/selection text is transmitted to the
        // user's own configured LLM endpoint. Declared honestly for AMO.
        data_collection_permissions: {
          required: ['websiteContent'],
        },
      } as Record<string, unknown>,
    },
  },
  // The content logic is an unlisted script injected on demand via
  // browser.scripting.executeScript so we never auto-inject into every page
  // (preserves site compatibility and the activeTab permission model).
  zip: {
    // Never ship local developer secrets in Firefox AMO sources packages.
    excludeSources: [
      'dev-settings.json',
      '**/dev-settings.json',
      'public/dev-settings.json',
    ],
  },
});
