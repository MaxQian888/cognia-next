# Evidence ledger: Region-aware provider quick setup

- Status: verifying
- Lane: standard
- Created: 2026-10-26
- Updated: 2026-10-26
- Related: components/settings/provider/provider-onboarding-banner.tsx

## Original request

> 上面这个如果检测到是在中国，就改成中国的提供商

## Knowledge

| ID  | Statement                                                                     | State    | Basis                                                       | Depends on |
| --- | ----------------------------------------------------------------------------- | -------- | ----------------------------------------------------------- | ---------- |
| O1  | Quick Setup was fixed to OpenAI, Anthropic and Google.                        | Verified | Source inspection and failing behavioral tests, 2026-10-26. | -          |
| O2  | fetchIpInfo uses proxyFetch and returns country or an error result.           | Verified | lib/network/ip-info.ts and its tests, 2026-10-26.           | -          |
| C1  | IP lookup must honor networkProxy.ipLookupEnabled.                            | Verified | Existing IP tab and transport contract, 2026-10-26.         | O2         |
| G1  | China detection selects Chinese provider shortcuts with working destinations. | Agreed   | User request, 2026-10-26.                                   | -          |

## Problem frame

Replace the fixed shortlist (O1) with DeepSeek, Qwen and Doubao for CN network egress (G1). Reuse the existing IP lookup (O2) and its opt-out (C1). When unavailable or disabled, a China device timezone is an approximate fallback; language alone never decides location. This changes shortcuts only.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                        |
| ------------ | ------ | ------------------------------------------------------------------ |
| scale        | low    | One existing component, co-located tests and two translation keys. |
| technical    | low    | Existing country lookup and native Intl timezone.                  |
| coupling     | low    | Existing shared browser/Tauri transport; no protocol changes.      |
| requirement  | low    | User identifies the exact shortcut group.                          |
| verification | medium | Deterministic region tests plus browser interaction.               |
| risk         | medium | Automatic IP lookup must retain the existing opt-out.              |

## Risks

| ID  | Risk (impact)                                                     | Severity | Source                           | Claim                                                                                                 | Refuted by                                         |
| --- | ----------------------------------------------------------------- | -------- | -------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| R1  | IP lookup ignores opt-out or hidden onboarding.                   | medium   | Existing network IP tab contract | No lookup when disabled, dismissed or already configured.                                             | A mocked request fires in those states.            |
| R2  | Incorrect regional shortcuts or broken navigation.                | medium   | Screenshot and provider catalog  | CN selects three catalog providers; non-CN keeps existing providers.                                  | Wrong buttons or callback IDs in behavioral tests. |
| R3  | Async response affects an unmounted banner or breaks export/i18n. | low      | Repository risk catalog          | Effect cleanup suppresses stale results; only browser-safe existing dependencies and translated copy. | Audit finding, lint error or missing key.          |

## Verification obligations

| ID  | Risk   | Method                                                    | Independence | Evidence                                                                                                                                                                                                                   | Coverage                                                                                                                                      | Status  |
| --- | ------ | --------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1, R2 | Co-located Jest tests and provider integration suite.     | tool         | 106 tests passed across provider-onboarding-banner and provider-settings. Before implementation 9 new cases failed for missing regional behavior.                                                                          | CN, US precedence, Shanghai/Urumqi fallback, opt-out, hidden banner, each Chinese provider callback, missing country, stale-response cleanup. | passed  |
| V2  | R3     | Lint, i18n generation/parity checks, targeted auditors.   | tool         | pnpm lint, lint:i18n, i18n:build, i18n:build:check, i18n:sort:check, focused Prettier, lint:static-export passed; i18n, test-gap and egress audits passed.                                                                 | Source, translations, 11733 bundled TS files.                                                                                                 | passed  |
| V3  | R2     | Local browser: inspect quick setup and choose a shortcut. | real-env     | Local browser displayed DeepSeek/Qwen/Doubao with IP lookup off and China timezone; Qwen opened its settings. Screenshot .cache/ui-verification/provider-china-quick-setup.png. Original IP lookup preference restored on. | China timezone fallback and Qwen navigation; no real CN-IP route exercised.                                                                   | passed  |
| V4  | R3     | Repository typecheck and production build.                | tool         | pnpm typecheck failed: 8 errors in hooks/chat/use-claude-chat.test.ts and lib/connectors/adapters/discord/avatar{,.test}.ts; none in touched files. Full production build unrun with only 3.4 GiB free.                    | Full shared repository.                                                                                                                       | blocked |

## Decisions

| ID  | Date       | Decision                                                                                    | Action    | Based on       | Reversal trigger                                      |
| --- | ---------- | ------------------------------------------------------------------------------------------- | --------- | -------------- | ----------------------------------------------------- |
| D1  | 2026-10-26 | Reuse IP country with device-timezone fallback, retain global defaults for unknown signals. | implement | O1, O2, C1, G1 | Lookup no longer respects proxy transport or opt-out. |

## Residual risks

| ID  | Residual                                     | From | Why still open                                       | Next action                                                               | Status |
| --- | -------------------------------------------- | ---- | ---------------------------------------------------- | ------------------------------------------------------------------------- | ------ |
| X1  | Static and i18n checks complete.             | V2   | All passed.                                          | None.                                                                     | closed |
| X2  | Local browser acceptance complete.           | V3   | China fallback displayed and Qwen navigation worked. | None.                                                                     | closed |
| X3  | Whole-repository typecheck/build incomplete. | V4   | 8 unrelated type errors; 3.4 GiB disk space.         | Owning tasks repair errors; recover disk space then run production build. | open   |

## Outcome

| ID  | Signal                                                              | How / when measured                             | Result                                                                                                                                  | Status |
| --- | ------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | CN uses Chinese shortcuts and all three open the matching provider. | Behavioral tests and local browser, 2026-10-26. | CN-IP fixture and China-timezone fallback select the Chinese shortlist; all three callback IDs pass; browser Qwen destination verified. | met    |
