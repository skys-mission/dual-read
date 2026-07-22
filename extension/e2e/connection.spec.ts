import { extTest as test, expectExt as expect } from './helpers/ext-fixture';
import { startMockServer } from './helpers/mock-server';

/**
 * Connection diagnostics via Options UI:
 * mock OpenAI-compatible loopback + Test connection button.
 */
test.describe('options connection test', () => {
  test('Connected on healthy /v1 chat completions', async ({ extContext, extensionId }) => {
    const mock = await startMockServer();
    try {
      const options = await extContext.newPage();
      await options.goto(`chrome-extension://${extensionId}/options.html`);
      await expect(options.locator('#testConnectionBtn')).toBeVisible();

      await options.locator('#uiLocale').selectOption('en');
      await expect(options.locator('#testConnectionBtn')).toHaveText(/Test connection/i);

      await options.locator('#apiBase').fill(mock.apiBase);
      await options.locator('#model').fill('e2e-mock');
      await options.locator('#apiKey').fill('e2e-test-key');

      await options.locator('#testConnectionBtn').click();
      await expect
        .poll(async () => ((await options.locator('#testConnectionStatus').textContent()) ?? '').trim(), {
          timeout: 15_000,
        })
        .toMatch(/^Connected/i);
    } finally {
      await mock.close();
    }
  });

  test('401 maps to API key rejected', async ({ extContext, extensionId }) => {
    const mock = await startMockServer();
    mock.setMode('auth_fail');
    try {
      const options = await extContext.newPage();
      await options.goto(`chrome-extension://${extensionId}/options.html`);
      await options.locator('#uiLocale').selectOption('en');
      await options.locator('#apiBase').fill(mock.apiBase);
      await options.locator('#model').fill('e2e-mock');
      await options.locator('#apiKey').fill('bad-key');

      await options.locator('#testConnectionBtn').click();
      await expect
        .poll(async () => ((await options.locator('#testConnectionStatus').textContent()) ?? '').trim(), {
          timeout: 15_000,
        })
        .toMatch(/API key rejected/i);
      await expect(options.locator('#testConnectionStatus')).toHaveClass(/is-error/);
    } finally {
      await mock.close();
    }
  });

  test('proxy route can test without a plugin API key', async ({ extContext, extensionId }) => {
    const mock = await startMockServer();
    try {
      const options = await extContext.newPage();
      await options.goto(`chrome-extension://${extensionId}/options.html`);
      await options.locator('#uiLocale').selectOption('en');
      await options.locator('#connectionMode').selectOption('proxy');
      await options.locator('#apiBase').fill(mock.apiBase);
      await options.locator('#model').fill('e2e-mock');
      await options.locator('#apiKey').fill('');

      await options.locator('#testConnectionBtn').click();
      await expect
        .poll(async () => ((await options.locator('#testConnectionStatus').textContent()) ?? '').trim(), {
          timeout: 15_000,
        })
        .toMatch(/^Connected/i);
    } finally {
      await mock.close();
    }
  });

});
