import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-ext',
      testMatch: /(popup|translate|lab|perf|connection|real-proxy|live-upstream)\.spec\.ts/,
    },
    {
      name: 'firefox-ext',
      testMatch: /firefox\.spec\.ts/,
      use: { browserName: 'firefox' },
    },
  ],
});
