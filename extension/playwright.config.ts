import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // CI shards the large regression files by test; each runner still uses one
  // worker so layout and performance assertions do not compete for resources.
  fullyParallel: !!process.env.CI,
  workers: 1,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-ext',
      testMatch: /(popup|translate|lab|regression|perf|connection|real-proxy|live-upstream|youtube-source|youtube-subtitles|youtube-subtitles-regression|youtube-subtitles-recovery)\.spec\.ts/,
    },
    {
      name: 'firefox-ext',
      testMatch: /(firefox|youtube-source|youtube-subtitles|youtube-subtitles-regression|youtube-subtitles-recovery)\.spec\.ts/,
      use: { browserName: 'firefox' },
    },
  ],
});
