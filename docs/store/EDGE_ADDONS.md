# Microsoft Edge Add-ons — Dual Read

Use [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview)
to update the existing Dual Read listing. Follow Microsoft's
[publishing guide](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)
for the current submission fields.

Existing public listing: [Dual Read on Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/hpkdnnlmodeggabfieondnamlmamibik).
This link does not establish that 0.2.0 is available there.

## Package and listing

1. Download `dual-read-extension-0.2.0-chrome.zip` from the published GitHub
   Release and [verify it](../RELEASE.md#verify-a-download). Use this CI-built
   Chromium package for Edge; do not upload the Firefox or source ZIP.
2. Test that package in Edge using `edge://extensions` → Developer mode →
   Load unpacked, selecting the extracted directory containing `manifest.json`.
3. Upload the ZIP as an update to the existing product in Partner Center.
4. Use [English](LISTING.en.md) / [Chinese](LISTING.zh-CN.md) copy, the shared
   [permission justifications](PERMISSIONS.md), and the public
   [privacy policy](https://github.com/skys-mission/dual-read/blob/main/PRIVACY.md).

The single purpose is bilingual reading of user-selected web content, including
webpage text and YouTube captions. Review notes must explain the new YouTube-only
host access, idle controls without translation traffic, and separately enabled
subtitle automation that is off by default. The
[Chrome reviewer notes](CHROME_WEB_STORE.md#reviewer-notes-optional-field)
describe the shared Chromium package behavior.

## Before submitting

- [ ] Uploaded manifest version is `0.2.0` and matches the verified CI artifact
- [ ] Listing, privacy answers, and permissions include enabled subtitle text and adjacent context
- [ ] Screenshots show the submitted production build and contain no credentials
- [ ] Edge smoke: page translate/restore, selection, and API setup
- [ ] YouTube smoke: idle controls, enable, seek, stop/restore CC, and default-off automation
- [ ] Upgrade from 0.1.x: new site-access acceptance and refresh behavior checked

## After review

Confirm the public listing and a fresh installation offer 0.2.0 before marking
Edge as updated in the READMEs or GitHub release notes. Complete the
[post-store documentation checklist](../RELEASE.md#documentation-pass-after-store-availability)
independently of Chrome and Firefox review results.
