# Interactive online subtitle validation

These opt-in tools make real requests to the service in the ignored
`extension/dev-settings.json`. They are not run by CI. Run from `extension/`
after `npm run build:firefox` and installing the Playwright Firefox browser.

```sh
node tools/youtube-live-validation/provider.mjs
node tools/youtube-live-validation/run.mjs --controlled-source
node tools/youtube-live-validation/run.mjs
```

`provider.mjs` sends five self-authored English subtitle samples through the
production subtitle prompt, transport and strict parser. It allows at most two
requests and reports status, latency, token usage and the sample translations.
This checks the service contract independently; it does not prove YouTube source
acquisition or browser rendering.

`--controlled-source` runs the production Firefox extension against the real
configured API with self-authored manual and ASR append-event fixtures. It checks
all ten displayed translations, warm-cache restart/seek, native restoration and
user track ownership. The player screenshot carries a visible controlled-source
label. Only YouTube/player/media routes are fulfilled locally; model traffic is
real. This automated mode exits and cleans up its temporary browser after saving
the report. It is useful when online source access or login is unavailable, but
does not count as an authenticated YouTube source test.

`run.mjs` opens a separate Firefox profile with the production addon bundles and
a diagnostic relay. Sign in through the normal YouTube UI when authenticated
coverage is needed. Audio is disabled for that profile and newly created media
elements are muted. The disposable test manifest grants YouTube and the exact
configured service origin; this run does not test toolbar `activeTab` acquisition
or the production installation permission prompt.

Google can reject sign-in from automated browser configurations. If that happens,
record the rejection and leave authenticated coverage pending. Do not change the
user agent, export cookies, suppress security checks or relabel a controlled-source
result as online success. A later manual validation in a normally authenticated
Firefox configuration is a separate test.

Enter one JSON command per line in its terminal:

```json
{"command":"status"}
{"command":"source"}
{"command":"start"}
{"command":"metrics"}
{"command":"shot"}
{"command":"stop"}
{"command":"exit"}
```

Use the normal player UI for playback, track selection and navigation. `source`
calls the production source adapter and normalizer; it reports only track
metadata, event counts, ownership restoration and word-preservation counts.
`start` and `stop` use the production subtitle session. `metrics` reports real
model requests, and `shot` captures only the player. The diagnostic request cap
is 12 per background lifetime; inspect the cumulative report between cases and
stop before the cap. A cap error is a diagnostic limit, not a product failure.

The configuration is supplied once over a random loopback URL. The API key is
held in extension session storage, not copied into the addon or reports. No
cookies, account identifiers, signed caption URLs, complete captions or model
request bodies are logged. Exit closes and removes this temporary profile.
Never copy login sessions from another browser to this tool.

Results are written under ignored `test-results/youtube-live/`. The screenshot
is overwritten on each `shot`; preserve selected, reviewed evidence separately.
Other Playwright suites clear `test-results`, so run them sequentially and copy
sanitized evidence before starting another suite. Online observations apply to
the measured session and model; they are not broad availability or latency
guarantees.
