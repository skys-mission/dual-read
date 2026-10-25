import type { BrowserContext, Page } from '@playwright/test';
import type { YouTubeSourceProbeOptions, YouTubeSourceProbeResult } from '../../lib/subtitles/youtube-adapter';

type BridgedResult = YouTubeSourceProbeResult & { isolated: boolean };
export function launchProbeBrowser(name: 'chromium' | 'firefox', options?: { headless?: boolean }): Promise<{
  context: BrowserContext;
  version: string;
  close(): Promise<void>;
}>;
export function runSourceProbe(page: Page, options: YouTubeSourceProbeOptions): Promise<BridgedResult>;
export function summarizeProbe(result: BridgedResult): Omit<BridgedResult, 'events'> & {
  eventCount: number;
  textEventCount: number;
  firstStartMs: number | null;
  lastStartMs: number | null;
  wordOffsetCount: number;
};
