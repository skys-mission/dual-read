# Store release overview

These are submission materials for **0.2.0**. Preparing this copy does not mean
that a store has accepted or published the update. Follow the four-stage flow in
[`docs/RELEASE.md`](../RELEASE.md): documentation, GitHub Release, store
submission, then a documentation update after verified store availability.

| Doc | Use |
|-----|-----|
| [CHROME_WEB_STORE.md](CHROME_WEB_STORE.md) | CWS dashboard checklist + reviewer notes |
| [EDGE_ADDONS.md](EDGE_ADDONS.md) | Microsoft Edge Add-ons update checklist |
| [FIREFOX_AMO.md](FIREFOX_AMO.md) | AMO checklist + sources package |
| [PERMISSIONS.md](PERMISSIONS.md) | Permission / data justifications |
| [LISTING.en.md](LISTING.en.md) | English store copy |
| [LISTING.zh-CN.md](LISTING.zh-CN.md) | Chinese store copy |

## Packages for public submission

Download and [verify](../RELEASE.md#verify-a-download) the assets from the
published **v0.2.0** GitHub Release. Submit the same CI-built packages:

| Store | Release assets |
|-------|----------------|
| Chrome Web Store / Microsoft Edge Add-ons | `dual-read-extension-0.2.0-chrome.zip` |
| Firefox AMO | `dual-read-extension-0.2.0-firefox.zip` and `dual-read-0.2.0-amo-sources.zip` |

The Firefox ZIP is unsigned; AMO handles signing. Do not substitute a local
rebuild, a dry-run artifact, or a different version's source archive.

For 0.2.0, all stores must describe YouTube subtitles, the new site-specific
access, default-off automatic translation, and caption text sent to the user's
configured service. Keep webpage and subtitle translation under the shared
purpose of bilingual reading.

## Local preparation and review

```bash
# From repo root
make build-extension
make check-store
make package-amo-sources
```

Outputs:

- Chrome / Firefox zips under `dist/` and `extension/output/` (local verification)
- AMO sources: `dist/store/dual-read-*-amo-sources.zip`

CI runs `make check-store` when store/privacy/manifest-related paths change,
and during tag releases. The script checks selected metadata and wording;
manually compare listing claims and reviewer notes with the shipped behavior.

Privacy policy (public): [PRIVACY.md](https://github.com/skys-mission/dual-read/blob/main/PRIVACY.md).
After each store is live, complete the [post-store documentation checklist](../RELEASE.md#documentation-pass-after-store-availability).
