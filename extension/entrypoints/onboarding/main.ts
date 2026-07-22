import { getSettings, saveSettings } from '../../lib/settings/storage';
import {
  assertSecureApiBase, createDefaultSettings, validationCodeOf,
} from '../../lib/settings/schema';
import { markOnboardingComplete } from '../../lib/settings/onboarding';
import { ensureCatalogs, getUiMessage, localizePage } from '../../lib/i18n';
import type { ConnectionMode } from '../../lib/types';
import {
  ensureApiHostPermission,
  isConnectionConfigured,
  testConnection,
} from '../../lib/provider/connection';
import { getConnectionPreset } from '../../lib/provider/connection-presets';

const defaults = createDefaultSettings();
let uiLocale = defaults.uiLocale;

const els = {
  panel1: document.getElementById('panel1') as HTMLElement,
  panel2: document.getElementById('panel2') as HTMLElement,
  panel3: document.getElementById('panel3') as HTMLElement,
  dots: [
    document.getElementById('stepDot1') as HTMLElement,
    document.getElementById('stepDot2') as HTMLElement,
    document.getElementById('stepDot3') as HTMLElement,
  ],
  connectionMode: document.getElementById('connectionMode') as HTMLSelectElement,
  connectionModeHint: document.getElementById('connectionModeHint') as HTMLElement,
  apiBase: document.getElementById('apiBase') as HTMLInputElement,
  apiKey: document.getElementById('apiKey') as HTMLInputElement,
  model: document.getElementById('model') as HTMLInputElement,
  testBtn: document.getElementById('testBtn') as HTMLButtonElement,
  testStatus: document.getElementById('testStatus') as HTMLElement,
  rememberKey: document.getElementById('rememberKey') as HTMLInputElement,
};

function t(key: string, subs?: (string | number)[]): string {
  return getUiMessage(key, subs ?? null, uiLocale);
}

function validationMessageKey(error: unknown): string {
  const code = validationCodeOf(error);
  const keys: Record<string, string> = {
    API_BASE_REQUIRED: 'errApiBaseRequired',
    API_BASE_INVALID: 'errApiBaseInvalid',
    API_BASE_INSECURE: 'connEndpointInsecure',
  };
  return code ? (keys[code] || 'errUnknown') : 'errUnknown';
}

function showStep(n: number): void {
  els.panel1.hidden = n !== 1;
  els.panel2.hidden = n !== 2;
  els.panel3.hidden = n !== 3;
  els.dots.forEach((dot, i) => {
    dot.classList.toggle('is-active', i + 1 === n);
    dot.classList.toggle('is-done', i + 1 < n);
  });
}

function setTestStatus(text: string, kind: 'ok' | 'error' | ''): void {
  els.testStatus.textContent = text;
  els.testStatus.classList.toggle('is-ok', kind === 'ok');
  els.testStatus.classList.toggle('is-error', kind === 'error');
}

function updateConnectionMode(mode: ConnectionMode, applyDefaults = false): void {
  const preset = getConnectionPreset(mode);
  els.connectionMode.value = mode;
  els.connectionModeHint.textContent = t(preset.hintKey);
  if (applyDefaults) {
    els.apiBase.value = preset.apiBase;
    els.model.value = preset.model;
  }
}

function readConnectionDraft() {
  return {
    connectionMode: els.connectionMode.value as ConnectionMode,
    apiBase: els.apiBase.value.trim(),
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim() || defaults.model,
    customHeaders: {} as Record<string, string>,
    targetLang: defaults.targetLang,
  };
}

async function runTest(): Promise<boolean> {
  setTestStatus(t('connTesting'), '');
  els.testBtn.disabled = true;
  try {
    let draft = readConnectionDraft();
    try {
      draft = { ...draft, apiBase: assertSecureApiBase(draft.apiBase) };
      els.apiBase.value = draft.apiBase;
    } catch (err) {
      setTestStatus(t(validationMessageKey(err)), 'error');
      return false;
    }

    const permitted = await ensureApiHostPermission(draft.apiBase);
    if (!permitted) {
      setTestStatus(t('connPermissionRequired'), 'error');
      return false;
    }

    const result = await testConnection(draft);
    if (!result.ok) {
      if (result.detail) console.info('[Dual Read] connection test detail:', result.code, result.detail);
      setTestStatus(t(result.messageKey), 'error');
      return false;
    }
    setTestStatus(
      result.latencyMs != null ? t('connOkMs', [String(result.latencyMs)]) : t('connOk'),
      'ok',
    );
    return true;
  } finally {
    els.testBtn.disabled = false;
  }
}

document.getElementById('step1Next')!.addEventListener('click', () => {
  showStep(2);
});

document.getElementById('step2Back')!.addEventListener('click', () => showStep(1));
document.getElementById('step2Next')!.addEventListener('click', async () => {
  const draft = readConnectionDraft();
  if (!isConnectionConfigured(draft)) {
    setTestStatus(t('connConfigRequired'), 'error');
    return;
  }
  showStep(3);
});

document.getElementById('step3Back')!.addEventListener('click', () => showStep(2));

els.testBtn.addEventListener('click', () => { void runTest(); });
els.connectionMode.addEventListener('change', () => {
  updateConnectionMode(els.connectionMode.value as ConnectionMode, true);
});

document.getElementById('finishBtn')!.addEventListener('click', async () => {
  const draft = readConnectionDraft();
  try {
    draft.apiBase = assertSecureApiBase(draft.apiBase);
  } catch (err) {
    showStep(2);
    setTestStatus(t(validationMessageKey(err)), 'error');
    return;
  }
  await saveSettings(
    {
      apiBase: draft.apiBase,
      connectionMode: draft.connectionMode,
      apiKey: draft.apiKey,
      model: draft.model,
    },
    { persistApiKey: els.rememberKey.checked },
  );
  await markOnboardingComplete(draft.connectionMode);
  await ensureApiHostPermission(draft.apiBase);
  chrome.runtime.openOptionsPage();
  window.close();
});

void (async () => {
  await ensureCatalogs();
  const settings = await getSettings();
  uiLocale = settings.uiLocale || defaults.uiLocale;
  await localizePage(uiLocale);
  updateConnectionMode(settings.connectionMode);
  els.apiBase.value = settings.apiBase || defaults.apiBase;
  els.apiKey.value = settings.apiKey || '';
  els.model.value = settings.model || defaults.model;
  showStep(1);
})();
