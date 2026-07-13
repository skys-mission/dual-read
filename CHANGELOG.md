# Changelog

All notable changes to Dual Read are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
