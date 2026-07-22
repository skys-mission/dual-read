import { test, expect } from './fixtures';

// Smoke test: the built extension loads, its service worker starts, and the
// popup entrypoint renders + localizes. This guards the WXT build wiring end
// to end (manifest, entrypoints, _locales, bundling).
test('popup renders and localizes', async ({ context, extensionId }) => {
  expect(extensionId).not.toEqual('');

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  await expect(popup.locator('#primaryBtn')).toBeVisible();
  await expect(popup.locator('#targetLang')).toBeVisible();
  await expect(popup.locator('#mode')).toBeVisible();
  await expect(popup.locator('#sitePolicy')).toBeAttached();

  // i18n runtime replaced the default English button copy with a catalog value.
  const translateLabel = await popup.locator('#primaryBtn').textContent();
  expect((translateLabel ?? '').trim().length).toBeGreaterThan(0);
});

test('options: target language change does not flip UI locale', async ({ context, extensionId }) => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);

  await expect(options.locator('#uiLocale')).toBeVisible();
  await expect(options.locator('#targetLang')).toBeEnabled();

  await options.locator('#uiLocale').selectOption('en');
  // Wait for localizePage to settle on English catalog.
  await expect(options.locator('#saveBtn')).toHaveText(/Save/i);

  const before = ((await options.locator('#saveBtn').textContent()) ?? '').trim();
  await options.locator('#targetLang').selectOption('zh-CN');
  await expect.poll(async () => ((await options.locator('#saveBtn').textContent()) ?? '').trim()).toBe(before);

  await options.locator('#uiLocale').selectOption('zh-CN');
  await expect(options.locator('#saveBtn')).toHaveText(/保存/);
});

test('options re-localizes existing dynamic cards in every UI language', async ({ context, extensionId }) => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.locator('#uiLocale')).toBeVisible();

  await options.locator('#advancedConnection').click();
  await options.locator('#addHeaderBtn').click();
  await options.locator('#addSiteRuleBtn').click();
  const locales: Record<string, string> = {
    en: 'en',
    'zh-CN': 'zh-CN',
    'zh-TW': 'zh-TW',
    ru: 'ru',
    es: 'es',
    fr: 'fr',
  };
  for (const [locale, htmlLang] of Object.entries(locales)) {
    await options.locator('#uiLocale').selectOption(locale);
    await expect(options.locator('html')).toHaveAttribute('lang', htmlLang);
    await expect(options.locator('#siteRuleRows .site-card label').first()).toHaveText(/.+/);
    await expect(options.locator('#customHeaderRows [data-action="remove-header"]')).toHaveAttribute(
      'aria-label',
      /.+/,
    );
  }
});

test('options page renders site rules + cache controls', async ({ context, extensionId }) => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);

  await expect(options.locator('#apiBase')).toBeVisible();
  await expect(options.locator('#addSiteRuleBtn')).toBeVisible();
  await expect(options.locator('#clearCacheBtn')).toBeVisible();

  // Adding a site rule card works.
  await options.locator('#addSiteRuleBtn').click();
  await expect(options.locator('#siteRuleRows .site-card')).toHaveCount(1);
  await expect(options.locator('#includeSecrets')).not.toBeChecked();
  await expect(options.locator('#includeCustomHeaders')).not.toBeChecked();
});

test('popup and options have no serious axe violations', async ({ context, extensionId }) => {
  const { AxeBuilder } = await import('@axe-core/playwright');

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator('#primaryBtn')).toBeVisible();
  const popupResults = await new AxeBuilder({ page: popup })
    .withTags(['wcag2a', 'wcag2aa', 'best-practice'])
    .analyze();
  const popupSerious = popupResults.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(popupSerious, JSON.stringify(popupSerious, null, 2)).toEqual([]);

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.locator('#apiBase')).toBeVisible();
  const optionsResults = await new AxeBuilder({ page: options })
    .withTags(['wcag2a', 'wcag2aa', 'best-practice'])
    .analyze();
  const optionsSerious = optionsResults.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(optionsSerious, JSON.stringify(optionsSerious, null, 2)).toEqual([]);

  const onboarding = await context.newPage();
  await onboarding.goto(`chrome-extension://${extensionId}/onboarding.html`);
  await expect(onboarding.locator('#panel1')).toBeVisible();
  const onboardingResults = await new AxeBuilder({ page: onboarding })
    .withTags(['wcag2a', 'wcag2aa', 'best-practice'])
    .analyze();
  const onboardingSerious = onboardingResults.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(onboardingSerious, JSON.stringify(onboardingSerious, null, 2)).toEqual([]);
});
