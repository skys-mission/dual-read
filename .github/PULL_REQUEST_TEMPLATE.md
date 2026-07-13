## Summary

<!-- Why this change exists (1–3 bullets). -->

-

## Test plan

- [ ] `cd extension && npm run compile && npm run lint && npm test`
- [ ] `cd server && go test ./...` (and `../scripts/check-golangci.sh` if Go changed)
- [ ] If DOM / translate behavior changed: `cd extension && npm run build && npx playwright test --project=chromium-ext`
- [ ] No secrets / `dev-settings.json` in the diff or build artifacts

## Notes

<!-- Breaking changes, migration, screenshots, follow-ups. -->
