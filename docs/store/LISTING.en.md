# Store listing copy (English)

Submission copy for **0.2.0**. Update the store listing with the matching package;
this draft does not announce store availability.

## Short description (≤ 132 characters)

```text
Bilingual web pages and YouTube captions using your OpenAI-compatible API or local Dual Read proxy.
```

Character count: 99.

## Detailed description

```text
Dual Read helps you read web pages and YouTube captions bilingually using an API you control. Web pages also support replacing the original text with a translation.

What it does
• Translate the current page on demand (toolbar, Alt+T, or context menu for selections)
• Bilingual overlay or replace mode (Alt+M to switch)
• Viewport-first translation to save tokens; incremental updates for dynamic pages
• Optional per-site auto-translate rules
• YouTube bilingual subtitles with your existing API, a separate language preference, and simple size/position presets
• Bilingual controls appear automatically on desktop YouTube watch pages; click to start translation. YouTube-specific access is declared at install, and automatic translation stays off by default
• Uses available manual or automatic captions; does not transcribe audio. Live streams, Shorts, mobile pages, embedded players, and picture-in-picture subtitles are not supported
• Works with any OpenAI-compatible endpoint, or a local dual-read-server cache proxy

What it does NOT do
• It is not a VPN, ad blocker, shopping tool, or general “AI sidebar”
• It does not send your pages to a Dual Read cloud—only to the endpoint you configure
• It does not request access to all websites at install time

Privacy
• Zero product telemetry by default
• Remote APIs must use HTTPS (HTTP allowed only for localhost)
• API keys and custom HTTP headers stay on the current device; exports exclude them unless explicitly included
• Enabled subtitle text and adjacent context go to your configured API; YouTube cookies and signed caption URLs do not
• Full policy: https://github.com/skys-mission/dual-read/blob/main/PRIVACY.md

Getting started
1. Install Dual Read and open Options
2. Enter your API base URL + key (or point at http://127.0.0.1:8080/v1 for a local server)
3. Open a page → click Translate

For YouTube, open a video with captions and click the bilingual button beside CC, or use the extension popup's Subtitles tab. After upgrading, accept YouTube site access if prompted and refresh already-open video pages.

Open source (Apache-2.0): https://github.com/skys-mission/dual-read
```

## Category / tags

- Category: Productivity  
- Suggested tags: translation, bilingual, reading, openai, privacy, self-hosted
