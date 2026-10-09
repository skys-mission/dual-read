# Changelog

All notable changes to Dual Read are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Honor the active session's target language for site and selection translation;
  reject batches whose provider changed, and invalidate old language cache entries.
- Retranslate source text replaced by dynamic pages, discard obsolete requests
  and buffered paints, and preserve source content and node identity when pages
  reparent rich-text descendants, including transfers between hosts and shadow
  roots. Merge text appended around filled slots back into the source, and keep
  independent link translations intact during parent updates.
- Apply translation styles and restore original content in nested and late
  Shadow DOM roots, including translation mode switches.
- Preserve source Text nodes when pages split or normalize translated text;
  recover transferred source before newly discovered shadow roots are indexed.
- Preserve edits between rich-text slots and recover cross-host source transfers
  after normalization, including a merged survivor moved into a new wrapper.
- Replay edits made after normalization and repeated text splitting; recover
  normalized transfers into untranslated containers without losing source Texts.
- Recover complete source slots independently after normalized text is split,
  wrapped, reordered, transferred or removed, including identical translations
  and another normalization at the destination. Preserve page changes to rich
  element attributes when restoring the original nodes, and keep new page Texts
  and real removals intact even when text values match a translation.
- Recover complete retained slots beside emptied slots after normalization and
  transfers, including single-slot `splitText(0)` transfers and another
  normalization at the destination.
- Keep the last known source in its original position when a transfer was
  normalized before its destination was observed, or a merged range edit has
  indistinguishable equal-valued source slots. Leave the page's current text
  intact when its ownership cannot be proven; do not rewrite equal-valued new
  page Texts or revive explicitly replaced source nodes.
- Preserve page deletions and replacements inside containers unwrapped by the
  rich-text skeleton, retaining original wrappers and the order of new text
  between their surviving children.
- Restore reordered rich-text siblings through omitted and nested wrappers
  without moving surrounding prose; preserve page order when runs from multiple
  omitted containers are interleaved.
- Use the extension's public session config in the live Chrome translation
  probe, including provider identity, local headers and site overrides.
- Propagate cache clears to existing tabs and frames; enforce TTL and memory
  limits for in-memory translations, including private browsing.

### Security

- Update the server's indirect `golang.org/x/sys` dependency to v0.44.0.

### Changed

- Update the pinned Go linter to support the project's Go toolchain and newer
  developer installations.
- Measure SPA retained heap after warm-up and explicit GC instead of optional
  page GC and quantized memory sampling; retain the existing performance budgets.

## [0.1.1] - 2026-08-04

### Changed

- Renderer performance: eliminate batch layout thrashing via read/write
  passes, time-slice render flush and rank sort across frames, and settle
  block shells on clean layout — zero forced synchronous layouts.
- E2E perf lab: exclude page parse from the 20k longtask gate and
  calibrate strict budgets.

### Added

- Store listings: Firefox Add-ons and Microsoft Edge Add-ons install
  links in README (EN / zh-CN).

## [0.1.0] - 2026-07-23

Initial public release.

### Added

- Browser extension (Chrome / Edge / Firefox, Manifest V3):
  bilingual overlay and replace translation via any OpenAI-compatible API,
  on-demand content-script injection, viewport-first lazy translation,
  incremental MutationObserver indexing, automatic retry with backoff,
  local translation cache, selection overlay, context menu, keyboard
  shortcuts, per-site rules, and settings import/export.
- UI locales: English, Simplified Chinese, Traditional Chinese, Russian,
  Spanish, French.
- Optional Go proxy server (`dual-read-server`): OpenAI-compatible reverse
  proxy with singleflight coalescing, BigCache / Valkey two-tier caching,
  API-key auth, model aliases, Admin UI, `/livez` `/readyz` `/metrics`,
  and a hardened Docker image.
- Playwright E2E (Chromium + Firefox), Vitest unit tests, performance
  budget lab, and nightly CI.
- Tag release pipeline: extension zips, multi-arch server binaries, GHCR
  image, SBOM, SHA256SUMS, and GitHub artifact attestations.

### Security

- Content scripts receive public session config only (no API keys in page
  context).
- Remote API bases require HTTPS (HTTP limited to loopback).
- Production artifacts are scanned for secret markers in CI.
- Server: SSRF controls around upstream dialing, admin hardening.
