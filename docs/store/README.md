# Store release overview

| Doc | Use |
|-----|-----|
| [CHROME_WEB_STORE.md](CHROME_WEB_STORE.md) | CWS dashboard checklist + reviewer notes |
| [FIREFOX_AMO.md](FIREFOX_AMO.md) | AMO checklist + sources package |
| [PERMISSIONS.md](PERMISSIONS.md) | Permission / data justifications |
| [LISTING.en.md](LISTING.en.md) | English store copy |
| [LISTING.zh-CN.md](LISTING.zh-CN.md) | Chinese store copy |

## One-shot prep

```bash
# From repo root
make build-extension
make check-store
make package-amo-sources
```

Outputs:

- Chrome / Firefox zips under `dist/` and `extension/output/`
- AMO sources: `dist/store/dual-read-*-amo-sources.zip`

CI also runs `make check-store` (privacy / permissions / listing alignment) on every PR.

Privacy policy (public): https://github.com/skys-mission/dual-read/blob/main/PRIVACY.md
