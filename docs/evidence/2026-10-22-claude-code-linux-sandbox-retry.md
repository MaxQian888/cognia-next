# Evidence ledger: Claude Code Linux sandbox and unattended retry

- Status: verifying
- Lane: standard
- Created: 2026-10-22
- Updated: 2026-10-22
- Related: ADR-0090, ADR-0065, ADR-0224

## Original request

> 把这两个能力接入 Cognia：Namespace 默认关闭并要求显式授权，无人值守重试要有总等待上限和取消机制，先检查 SDK 兼容性和现有调用链。

## Knowledge

| ID  | Statement                                                                                                                                | State    | Basis                                                                                                                                | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| O1  | Installed SDK 0.3.302 embeds Claude Code 2.1.302 and lacks the namespace field.                                                          | Verified | Installed package metadata, executable --version, sdk.d.ts inspected 2026-10-22 on macOS.                                            | -          |
| O2  | SDK 0.3.305 embeds Claude Code 2.1.305 and supports typed sandbox.allowNestedUserNamespaces.                                             | Verified | Official npm registry tarball and sdk.d.ts; same top-level API surface as 0.3.302, 2026-10-22.                                       | -          |
| O3  | Claude MAX_WAIT_MS limits each API request; early usage rechecks are subscription-specific and opt-in.                                   | Verified | https://code.claude.com/docs/en/env-vars, 2026-10-22.                                                                                | -          |
| O4  | Existing per-call hostConfig requests bypass auto-allow and always-allow; dispatch must return synchronously before the host can answer. | Verified | hooks/chat/claude-chat-events.ts, unattended-permission-responder.ts, sidecar host/index.ts; read-only call-chain review 2026-10-22. | -          |
| G1  | Expose both controls in Cognia with Namespace off by default and separate explicit per-invocation approval.                              | Agreed   | User request 2026-10-22.                                                                                                             | -          |
| C1  | Namespace preference is a request only. No query, pool claim or prewarm may start before the current pending approval succeeds.          | Verified | User request and upstream sandbox warning; implementation acceptance constraint 2026-10-22.                                          | G1         |
| C2  | Retry is opt-in, finite and cancellable; ambient or raw environment variables cannot enable watchdog retries.                            | Verified | User request, ADR-0090 environment/retry authority, 2026-10-22.                                                                      | G1         |
| C3  | Preserve concurrent unrelated edits and keep existing Router + Fusion envelope retry accounting authoritative.                           | Verified | Shared checkout status, CLAUDE.md, ADR-0090 section 8, 2026-10-22.                                                                   | -          |

## Problem frame

Add the v2.1.305 namespace and usage-limit recheck capabilities through the existing Claude SDK rail. Reuse Settings, shared serialized option validation, pending approvals and interruption. A saved namespace flag never grants consent. Bound watchdog waiting with both the CLI per-request cap and a stricter fixed invocation elapsed-time deadline (including normal work). Local tests cannot establish real Linux sandbox behavior or a real subscription limit being lifted (G1, C1, C2).

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                                   |
| ------------ | ------ | --------------------------------------------------------------------------------------------- |
| scale        | medium | Settings, contract, renderer resolver and sidecar policy.                                     |
| technical    | medium | Typed SDK option confirmed; lazy query must preserve controls and async iteration.            |
| coupling     | high   | Host registration, pending approvals, prewarm, ledger retries and cancellation interact.      |
| requirement  | low    | Defaults, explicit consent and finite cancellation are specified.                             |
| verification | high   | Deterministic unit/integration checks available; real namespace requires Linux.               |
| risk         | high   | Namespace intentionally weakens a security boundary; retries can otherwise last indefinitely. |

## Risks

| ID  | Risk (impact)                                                                        | Severity | Source                                                | Claim                                                                             | Refuted by                                                                |
| --- | ------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| R1  | A namespace request silently becomes permission to escape SDK restrictions.          | high     | Upstream sandbox docs; ADR-0065                       | Default false; approval precedes every spawn; deny/cancel fails closed.           | Any query/pool spawn before current explicit approval.                    |
| R2  | Ambient watchdog vars or repeated API requests create unbounded work.                | high     | ADR-0090; env-vars documentation                      | Typed finite policy only; one fixed deadline per invocation.                      | Parent/overlay enables retry or later requests reset deadline.            |
| R3  | SDK control RPC stalls cancellation or pending approvals survive teardown.           | high     | Read-only runtime review                              | Local abort, input close and pending drain settle without control RPC completion. | Cancelled query remains blocked or emits repeated terminal frames.        |
| R4  | Config is exposed but never reaches active runtime; old executable ignores controls. | high     | Repository built-but-dormant risk catalog; SDK review | UI maps into only the SDK rail; custom CLI must meet minimum version.             | UI is unmounted, fields are stripped, or old CLI accepts feature request. |
| R5  | Hidden watchdog retries violate envelope accounting.                                 | high     | ADR-0090 section 8                                    | Envelope mode rejects the hidden retry request before a model call.               | A ledgered call enables the watchdog.                                     |

## Verification obligations

| ID  | Risk               | Method                                                        | Independence   | Evidence                                                                                                                                                                                                                                                                                                                | Coverage                                                                                                                                            | Status  |
| --- | ------------------ | ------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1, R2             | Shared contract validation and preference resolver Jest tests | tool           | RED: 9 failures for missing features; GREEN: 103 tests, 2 suites via pnpm test.                                                                                                                                                                                                                                         | Defaults, numeric bounds, request-only namespace, unattended-only retry.                                                                            | passed  |
| V2  | R1, R3, R5         | Sidecar behavior and actual SDK fault injection               | tool           | Final focused sidecar: 150/150 pass; earlier expanded regression: 227/227 pass. Actual SDK0.3.305/CLI2.1.305: cancel returns1ms, one terminal, child exits. Deadline60002ms across8 local HTTP429 attempts, one terminal, alive=0. Evidence: .cache/claude-code-linux-sandbox-retry/real-{cancel,deadline}-result.json. | Deny, unknown, TTL, cancel, hard profile ceiling, fixed deadline, cleanup errors, hook env and ledger refusal. Live subscription recovery excluded. | passed  |
| V3  | R4                 | UI tests and browser SandboxSection flow                      | tool           | Focused UI suites: 59/59 pass. CUA inspected existing Storybook SandboxSection: defaults off,30/1 minutes, invalid181 rejected,45 saved, toggles restored.                                                                                                                                                              | Mounting, validation, store persistence, translated warnings; actual desktop flow carried in V8.                                                    | passed  |
| V4  | R4                 | SDK pins, surface gate, package build and executable tests    | tool           | check:runtime-versions and check:sdk-surface pass for0.3.305. @cognia/agent-config-types build passes. Actual CLI2.1.305 executed; old/unknown/prerelease and private-output diagnostics tested.                                                                                                                        | Installed SDK/manifest, supported override binary, safe diagnostics.                                                                                | passed  |
| V5  | R1, R2, R3, R4, R5 | Independent review and deterministic gates                    | fresh-reviewer | Reviews found/fixed hostConfig ceiling bypass, Support clamp reintroduction, async nested saves and raw version diagnostics. PII/i18n/test-gap audits report no remaining findings. Scoped lint and official static scanner pass. Full type/lint/static-export/architecture blocked by unrelated failures.              | Changed paths audited; broad build acceptance unavailable.                                                                                          | blocked |
| V6  | R1                 | Real Linux/WSL namespace and Chromium smoke                   | real-env       | macOS host; docker info fails: Cannot connect to the Docker daemon.                                                                                                                                                                                                                                                     | Actual kernel namespace/sandbox behavior not exercised.                                                                                             | blocked |
| V7  | R2                 | Live subscription usage limit lifted during wait              | real-env       | No live quota/OAuth test. Local fixture uses fake key and DISABLE_NONESSENTIAL_TRAFFIC=1.                                                                                                                                                                                                                               | Early subscription recheck remains unaccepted; native retries/cancel/deadline separately verified.                                                  | blocked |

| V8 | R4 | Desktop or paired-host Settings integration | real-env | Browser settings route displays Not available on this host before the card mounts; isolated browser smoke passes. | Actual desktop Settings and approval UI require a capable host. | blocked |

## Decisions

| ID  | Date       | Decision                                                                                                                            | Action    | Based on   | Reversal trigger                                             |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- | ------------------------------------------------------------ |
| D1  | 2026-10-22 | Upgrade only to exact SDK 0.3.305 and forward the typed sandbox field, without raw settings escape hatches.                         | implement | O1, O2, C3 | Installed API differs from tarball evidence.                 |
| D2  | 2026-10-22 | Use existing unconditional per-call hostConfig approval and lazy query admission; retain existing renderer-response trust boundary. | harden    | O4, C1     | Any auto-grant, stale approval or pre-consent spawn.         |
| D3  | 2026-10-22 | Use a conservative whole-invocation deadline including normal work, not a counter reset on API retries; explain this in Settings.   | implement | O3, C2     | Deadline resets or cancellation depends on SDK RPC response. |

## Residual risks

| ID  | Residual                                          | From | Why still open                         | Next action                                                                | Status |
| --- | ------------------------------------------------- | ---- | -------------------------------------- | -------------------------------------------------------------------------- | ------ |
| X1  | Real Linux Namespace behavior remains unaccepted. | V6   | No active Linux container or WSL host. | Run Chromium/unshare acceptance on Linux without changing global defaults. | open   |

| X2 | Live subscription early quota recovery remains unaccepted. | V7 | No real subscription quota event. | Exercise configured interval during an actual session/weekly limit. | open |
| X3 | Desktop Settings and actual approval UI remain unaccepted. | V8 | Browser-only host capability gate. | Run Tauri or paired-host settings/approval flow. | open |
| X4 | Full repository build acceptance is blocked. | V5 | Existing root type errors incl unchanged build-options.ts:6226; ai-sdk compaction errors; lint scans public/.p0-native-fixture/bundle.js (15errors/1391warnings); static-export ENOBUFS; architecture3 unrelated imports. | Resolve owning changes, then rerun full gates/build; focused checks do not replace production acceptance. | open |

## Outcome

| ID  | Signal                                                                                                           | How / when measured                                                                                     | Result                                                                                                                      | Status  |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------- |
| M1  | User can request namespace access with explicit per-run approval and run bounded cancellable unattended retries. | UI smoke plus runtime admission/cancellation checks; real Linux/provider acceptance carried separately. | Implemented with local deterministic/native CLI evidence; Linux, live quota, desktop flow and full gates are carried above. | pending |

## Implementation notes

- Dedicated Settings card separates SDK capabilities from the existing OS sandbox card. runtime-policy owns process admission and lifetime rather than SDK option translation.
- Preferences are desktop-only; they are requests and never transfer a Namespace authorization.
- Retry defaults off; opt-in defaults30-minute whole-invocation deadline plus1-minute recheck. All elapsed work counts. Bounds are integer60000..10800000ms.
- Native hook queries keep Namespace off and do not inherit root watchdog env. Protected invocations cannot claim/prewarm processes.
- No commits, pushes, deployments, global Claude settings changes or coverage commands were performed.

## Final local verification (2026-10-22)

| Check                                                                        | Actual result                                                                                      | Evidence                                                                                     |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Root Jest entry point, seven focused suites                                  | 685/685 pass                                                                                       | .cache/claude-code-linux-sandbox-retry/final-jest.log                                        |
| Sidecar test entry point, twelve focused suites after final diagnostic patch | 150/150 pass                                                                                       | .cache/claude-code-linux-sandbox-retry/final-runtime.log                                     |
| Expanded sidecar regression before final diagnostic addition                 | 227/227 pass                                                                                       | .cache/claude-code-linux-sandbox-retry/runtime-unit.log                                      |
| Real native CLI cancellation / fixed deadline                                | One terminal each; no child alive; deadline60002ms across8 requests                                | real-cancel-result.json / real-deadline-result.json in the same cache folder                 |
| Runtime pin, SDK surface, settings-sync generation checks                    | Pass                                                                                               | SDK0.3.305 / CLI2.1.305; surface69 options/30 query methods/39 messages/33 hooks/260 exports |
| Config-types package build                                                   | Pass                                                                                               | .cache/claude-code-linux-sandbox-retry/config-types-build.log                                |
| Scoped ESLint, Prettier and whitespace checks                                | Pass                                                                                               | runtime-eslint.log, scoped-lint-main.log and final command output                            |
| i18n build/check, key/JSX lint, sort                                         | Pass                                                                                               | i18n-final.log, i18n-lint-final.log and command output                                       |
| Official static-export scanner against seven changed bundled sources         | Zero findings                                                                                      | Full gate itself fails ENOBUFS before scanning this large checkout                           |
| Root and sidecar typecheck                                                   | Blocked by existing unrelated errors; no errors in newly added options, policy, card or sync field | typecheck-final.log / sidecar-typecheck-final.log                                            |
| Full repository ESLint / sidecar architecture                                | Blocked by existing fixture bundle and three unrelated imports                                     | lint.log / sidecar-architecture.log                                                          |
| Full production static/Tauri build                                           | Not run after prerequisite repository checks failed                                                | Not production acceptance                                                                    |

Final persistence review reproduced both navigation/remount lost-update cases, then verified leaf-only functional DB updaters preserve the latest Namespace and retry fields. The card updates Zustand from the returned full settings. Pending writes, failures, malformed saved bounds and valid fractional-minute values are covered by the 59 UI tests.

Independent reviews: general security/lifetime, wiring (including final remount fix), PII, i18n and co-located test gaps. All actionable feature findings were resolved. Cross-model CLI review was offered as optional and was not invoked without a user choice.
