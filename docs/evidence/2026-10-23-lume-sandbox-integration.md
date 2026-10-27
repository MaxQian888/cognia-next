# Evidence ledger: lume sandbox integration

- Status: verifying
- Lane: deep
- Created: 2026-10-23
- Updated: 2026-10-26
- Related: [implementation plan](../plans/2026-10-23-lume-sandbox-integration.md)

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 按这份方案开始实现 Lume 接入，完成 P0–P3，并补齐对应测试和验证。用户后续明确先实现代码，真实 VM 验收暂缓。

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                         | State    | Basis                                                      | Depends on |
| --- | ----------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------- | ---------- |
| O1  | At baseline Lume had no adapter; versioned native-backed rows now resolve while legacy rows remain dormant.       | Verified | adapter-registry regression, 2026-10-24                    | -          |
| C1  | Preserve existing sandbox policy, permission, lease and target boundaries; no Host fallback.                      | Verified | approved implementation plan, 2026-10-23                   | -          |
| C2  | Implement code first; real VM acceptance is deferred.                                                             | Verified | explicit repeated user deferral, latest request 2026-10-24 | -          |
| G1  | Implement P0 contracts and ownership, P1 VM lifecycle, P2 SSH/helper and P3 Driver/viewer integration with tests. | Agreed   | user implementation request, 2026-10-23                    | C1, C2     |

## Problem frame

Add a local Lume provider through existing sandbox contracts (G1), keeping ownership and execution authority in the native Host (C1). Automated tests must demonstrate refusal of legacy or stale identities and transport failures. Real VM, cold boot and TCC acceptance remain explicitly pending under C2.

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                             |
| ------------ | ------ | ----------------------------------------------------------------------- |
| scale        | high   | Native lifecycle, guest executable, plugin contract and settings/viewer |
| technical    | high   | SSH identity, process supervision, persistent journal and MCP framing   |
| coupling     | high   | Session binding, policy, permissions and shared desktop control         |
| requirement  | medium | Approved P0–P3 plan; real acceptance deferred                           |
| verification | high   | Headless contracts available; real guest unavailable                    |
| risk         | high   | VM deletion, credentials, command execution and GUI input               |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                      | Severity | Source                             | Claim                                                                          | Refuted by                                                       |
| --- | ------------------------------------------------------------------ | -------- | ---------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| R1  | Unowned or replaced VM is mutated or deleted.                      | high     | plan identity review               | Host journal identity gates every mutation.                                    | A stale or legacy ref changes a VM.                              |
| R2  | SSH interpolation or weakened policy executes unintended work.     | high     | plan transport review              | Fixed SSH command and structured bounded requests; unsupported policy refuses. | Payload changes Host argv or unsupported confinement succeeds.   |
| R3  | Cancellation leaves mutation running while reporting success.      | high     | plan cleanup review                | Uncertain cleanup quarantines and stops the VM.                                | A timeout returns reusable readiness without stopped inspection. |
| R4  | GUI bypasses existing lease/frame/permission gates.                | high     | existing desktop contracts         | Driver input uses the shared control domain and frozen identity.               | Stale frame, revoked lease or old boot can send input.           |
| R5  | Environment or unrelated repository failures prevent verification. | medium   | ENOSPC and Node engine observation | Report actual evidence and preserve pending acceptance.                        | Mock results are described as real VM acceptance.                |

| R6 | The main integration is mistaken for fully accepted workspace and continuous execution support. | high | final native and wiring review | Native source revision/CAS and frozen same-group continuation; real acceptance is separate. | Logical mapping is treated as authority, a conflict overwrites source, or background work survives a human handoff. |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk               | Method                                                              | Independence   | Evidence                                                                                                                                                                                                                  | Coverage                                                                                              | Status  |
| --- | ------------------ | ------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1                 | Registry, identity, journal and stale epoch regression              | tool           | Versioned/legacy TS tests passed; native lock, restart, idempotency and queued-send tests passed                                                                                                                          | Automated contracts; no real Lume lifecycle acceptance                                                | passed  |
| V2  | R2                 | Guest framing, path, CAS, hardlink and exclusive upload tests       | tool           | cargo test --locked -p cognia-desktop-guest: latest result below; focused TS policy and typed file/CAS tests passed                                                                                                       | Structured IO and refusal; no real SSH guest execution                                                | passed  |
| V3  | R3                 | Lifecycle cancellation and journal write failure injection          | tool           | Native fake CLI confirms Stop during journal failure; revocation and late snapshot tests passed; auditors found and corrected cleanup early returns                                                                       | Native state/control tests; hostile real descendants remain V5                                        | passed  |
| V4  | R4                 | Driver contract and existing desktop control regression             | tool           | 212 Jest tests passed across 15 suites; native frame/lease and composed-fence tests passed in broader sandbox run                                                                                                         | Viewer routing, typed effects, shared admission and queued revocation; no real Driver/TCC             | passed  |
| V5  | R1, R2, R3, R4     | A1–A18 real macOS guest acceptance                                  | real-env       | User explicitly continued real VM deferral; no qualified guest was used                                                                                                                                                   | Real CLI/SSH/GUI/cold boot and TCC remain unverified                                                  | blocked |
| V6  | R5                 | Additional repository governance gates                              | tool           | Command parity, Companion manifest and Rust architecture all exited 0 in the final follow-up; baseline byte-identical; details below                                                                                      | Three requested governance gates; existing two Rust baseline findings remain recorded                 | passed  |
| V7  | R6                 | Check the complete P0–P3 acceptance contract against implementation | subagent       | Closed the code gaps through explicit import/review/adopt, native canonical root/source revision checks, normal same-group continuation and human handoff refusal until Stop                                              | Local code/contract evidence; real VM behavior remains V5                                             | passed  |
| V17 | R5                 | Full production build and exported artifact validation              | tool           | 2026-10-26: full prebuild/build/postbuild passed with cache disabled; 129 static/0 dynamic routes, 127 HTML files; 802 referenced assets matched their HTTP-served bytes; build-no-cache.log and export-verification.json | Actual exported HTML/JS/CSS and local HTTP serving; no fresh browser session or native/VM interaction | passed  |
| V18 | R1, R2, R3, R4, R6 | Adversarial lifecycle, binding, file and GUI contract review        | fresh-reviewer | 2026-10-25: extracted Start/Stop and guest CAS witnesses demonstrate defects; five real TS integration assertions fail; native binding and Driver identity gaps confirmed in source; details below                        | Offline fake CLI, copied protocol code and actual TS adapters/hooks; no real VM acceptance            | failed  |
| V19 | R1, R2, R3, R4, R6 | Remediation regressions and final repository checks                 | tool           | 2026-10-26: 244 Jest tests, 260 native sandbox tests, 26 guest tests and 8 scanner tests passed; strict Clippy, lint/i18n/governance and the complete production export passed; see remediation addendum                  | Actual native fake-CLI and TS production paths, bounded guest fault injection; real VM remains V5     | passed  |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                                                                                                                                                                                 | Action    | Based on       | Reversal trigger                                                                                      |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| D1  | 2026-10-23 | Extend existing sandbox architecture with a versioned local Host seam and isolated Lume modules; new modules are needed because Docker lifecycle and Linux guest entrypoints cannot safely own Darwin VM behavior.                                                                       | implement | O1, C1, C2, G1 | Actual source contradicts the planned ownership boundary                                              |
| D2  | 2026-10-23 | Proceed with code and bounded local checks; do not install Lume, download images or clear unrelated data.                                                                                                                                                                                | implement | C2             | User provides a suitable acceptance environment                                                       |
| D3  | 2026-10-24 | Retain normal commands in the same exclusive execution group without claiming descendant cleanup. Require Stop for timeout/cancel/uncertainty/retirement and before human control after Shell work.                                                                                      | harden    | C1, G1         | Real guest evidence contradicts group retention/control handoff                                       |
| D4  | 2026-10-26 | Enforce native session consent and renewable binding leases. Permanently exclude typed writes/uploads once arbitrary Shell or GUI writers may exist; require a fresh clean resource for that profile. Preserve watchdog cleanup on disable and validate stale cleanup before preemption. | harden    | C1, C2, G1     | A retained or rebooted writer can reach a typed mutation, or revoked work has no native cleanup owner |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                    | From     | Why still open                                                                                                                                         | Next action                                                                                                            | Status |
| --- | --------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------ |
| X1  | Real guest acceptance and complete UI journey remain pending.               | V5       | Explicit user deferral; no qualified guest; local automated checks cannot prove real SSH, GUI or TCC                                                   | Run A1–A18 on an Apple Silicon qualification host when acceptance resumes                                              | open   |
| X2  | Requested governance and production static export blockers.                 | V6, V17  | Closed by final governance checks and full production build plus local artifact/browser validation                                                     | No further action in this scope; VM acceptance remains X1                                                              | closed |
| X3  | Task Workspace handoff code gap                                             | V7, R6   | Closed by native import/review/adopt using existing source revision and bounded CAS; source drift refusal tested                                       | Complete real A9 under X1                                                                                              | closed |
| X4  | Same-group continuation code gap                                            | V7, R6   | Normal exec retains its frozen binding; repeated Shell/file/GUI routing tested; human acquisition blocked until Stop                                   | Verify real descendants and takeover under X1                                                                          | closed |
| X5  | Tauri release packaging and cross-platform compilation.                     | R5       | This increment compiled the macOS app crate and exported the web app; signed desktop/mobile packages were not built                                    | Perform packaging and platform qualification when that release scope is requested                                      | open   |
| X6  | Adversarial review found lifecycle, binding, typed-file and shared UI gaps. | V18, V19 | Closed by the seven remediation groups plus disable-cleanup and stale-preemption regressions; original V18 witnesses remain historical defect evidence | Real VM validation remains X1; writer exposure permanently requires a fresh clean resource for typed mutations/uploads | closed |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                | How / when measured                                             | Result                                                                                                                                                     | Status  |
| --- | ----------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| M1  | P0–P3 implementation and automated verification       | Current production paths, colocated regressions and final gates | Seven audit groups repaired within the documented clean-clone writer restriction; automated checks and production export passed; typecheck skipped by user | met     |
| M2  | Real Lume guest satisfies complete release acceptance | A1–A18 qualification on a disposable guest                      | Deferred by user                                                                                                                                           | pending |

## Verification details — 2026-10-24

- Focused Jest command used the repository wrapper, explicit 15 test files, `--runInBand --no-cache --cacheDirectory=.cache/lume-jest`: **15 suites, 212 tests passed**. It includes Docker/E2B compatibility, Lume legacy/version gates, session epoch changes, cancellation propagation, typed file CAS refusal, viewer lease preservation, binary transfer and unframed settings regression. Existing test fixtures emit expected audit persistence warnings in Node.
- Final native Lume run: `CARGO_INCREMENTAL=0 cargo test --locked -p cognia-automation --lib cua_sandbox::lume`: **24 passed**. This includes source root replacement, committed-effect receipts, source drift/CAS, source exclusions, normal receipt retention and malformed reply refusal. The desktop handoff test and final guest/host check results are recorded in the final verification addendum below.
- `CARGO_INCREMENTAL=0 cargo test --locked -p cognia-task-workspace --lib bounded_`: **9 passed**. Includes disabled repository fsmonitor sentinel, bounded file reads, a sparse oversized source, source growth between capture and validation, and existing revision/CAS parity. Ordinary Task Workspace callers keep their existing capture profile.
- Broader `cargo test --locked -p cognia-automation --lib cua_sandbox`: **200 passed, 4 failed, 11 ignored**. Failures are in untouched managed modules: `incremental_bundle_header_is_bounded_and_requires_complete_header`, `host_preparation_missing_sha_refuses_and_cancelled_fetch_cleans_staging`, `exact_build_response_cannot_spend_after_admission_is_revoked`, and `native_smoke_rejects_expiry_without_a_successful_delete_retry`. No baseline checkout comparison was performed; this run is not a clean regression pass.
- `pnpm lint` passed after the Lume effect/layout fixes. `pnpm i18n:build`, `i18n:build:check`, `lint:i18n`, and `i18n:sort:check` passed. No coverage command ran.
- Latest `pnpm typecheck`: **2 errors in 2 files**, outside Lume: `lib/claude/provider-attempt-options.ts:157` (`protocol` missing) and `scripts/smoke/builtin-agent-budget-live.ts:594` (callback index passed as checkpoint anchors). Earlier counts changed as other tasks edited the shared tree. Log: `.cache/lume-sandbox/typecheck-final.log`.
- `pnpm companion-api:check` passed: **944 remote commands, 116 classified routes**. `audit:command-parity` reports seven managed desktop command registrations; `audit:companion-command-manifest` reports missing idempotency for `sandbox_preview_create/open`; `audit:rust-architecture` reports CC Switch→skills and magpie/siwc module findings. None are newly added Lume commands.
- `pnpm lint:static-export` failed collecting tracked source files with `spawnSync /bin/sh ENOBUFS` (the gate's default child output buffer). Using the gate's existing exported `buildDenySet/scanSource` functions, a scoped scan of eight changed browser modules passed with zero Node-only imports. Independent i18n/static source review also found no new export violation. This does not substitute for a full export build.
- Actual read-only native smoke: `node scripts/smoke/lume-sandbox.mjs` passed through the running macOS Tauri shell: contractVersion=1, Lume lock=0.6.1, featureEnabled=false, resourceCount=0, unknown operation refused. Content-free artifact: `.cache/lume-sandbox/native-smoke.json`. No VM creation, startup, GUI input or deletion ran; no running debug process owned by another task was stopped or navigated.
- `node --test scripts/smoke/lume-sandbox.test.mjs`: **1 passed**. Native smoke is an executable IPC test, not A17's complete Settings→VM→SSH→GUI journey.
- Read-only preflight native/wiring/i18n audits found and prompted fixes for journal output persistence, Stop short-circuiting, process cleanup uncertainty, account ABA/cancellation registration, disabled upload, inherited fences, Driver interrupted cleanup, raw UI states, viewer lease and transfer wiring. Follow-up reviews found and corrected retained-work human takeover, unbounded capture/CAS reads, repository fsmonitor execution and export exclusions. X3/X4 code gaps are closed; real acceptance remains X1.
- Fresh static export, full Tauri packaging, cross-platform compilation and real guest qualification were not completed. Current Data volume remained below roughly 1 GiB during the final runs; Node/pnpm report an engine warning (shell Node 24 versus repository requirement >=26).

## Current phase status

| Phase | Implemented code                                                                                                                                 | Remaining exit requirements                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| P0    | Version lock, DTOs, account-scoped ownership journal, default-off diagnose, legacy refusal, command/ACL integration                              | Requested repository gates and static build passed; guest requirements remain below |
| P1    | Create/clone/attach/start/setup/connect/health/stop/delete, identity/capacity checks, foreground child ownership and durable quarantine/recovery | Real A1–A5/A15 and image/host qualification                                         |
| P2    | Darwin helper, strict SSH trust, source revision/replica import/review/CAS adoption, typed IO, same-group exec and Stop recovery                 | Real A6–A9/A14 and hostile process cleanup acceptance                               |
| P3    | Driver MCP/schema pinning, live GUI profile checks, existing viewer/control domain, settings/chat/character/workflow reachability                | Complete A2/A10–A18 guest/UI acceptance                                             |

P0–P3 are **not declared complete**. Changes are uncommitted; no installation,
VM image download, unrelated cleanup, commit, push or PR creation was performed.

## Final verification addendum — 2026-10-24

- Native Lume: **24 passed**; guest package: **22 passed across 4 suites**;
  bounded Task Workspace: **9 passed**; retained-work desktop handoff: **1 passed**.
  Builds used `CARGO_INCREMENTAL=0` after disk exhaustion, preserving test semantics.
  Native `cargo check --locked -p cognia-automation --lib --features tauri-host` passed.
- Final Jest: **15 suites / 212 tests passed**. The UI regression first failed
  because review/adoption controls did not exist; it passed after wiring. The
  executable-bit regression first failed with mode=0 after replacement, then
  passed after anchored atomic writes preserved the owner execute bit.
- `pnpm lint`, i18n build/check/lint/sort passed. Read-only review confirms
  **53 Lume translation leaf keys** in both locales and no new static-export imports.
- Full `pnpm typecheck` still fails on the two unrelated files listed above.
  No coverage check was requested or run. `clippy -D warnings` was blocked by
  `cognia-net/src/proxy_config/detect.rs:431` (`needless_late_init`). The repository
  Rust format check also reported unrelated existing formatting differences;
  owned Lume modules were formatted and modified Task Workspace hunks were formatted
  without rewriting the rest of those shared files.
- Several Rust runs failed with exact `No space left on device` before the
  successful bounded reruns. Only this task's failed/previous test artifacts and
  `.cache/lume-jest` were reclaimed. No other task's source, VM data or caches
  were cleaned.
- The earlier real read-only Tauri IPC smoke passed against contract 1 with
  feature disabled and zero VMs. A later rerun failed `debug_connection_lost`
  (`ECONNREFUSED 127.0.0.1:49522`) after the shared app stopped. The earlier
  content-free report is retained; it does not verify the final workspace UI.
- Native/wiring review findings were fixed and rechecked. Git fsmonitor/hooks
  are disabled for bounded source capture; all bounded CAS reads preserve the
  budget, and successful publication remains `Applied` even if a subsequent
  source recapture exceeds it. Normal success explicitly retains the exclusive
  group; human acquisition refuses until a confirmed Stop. Real guest behavior,
  full Settings/chat/workflow journeys, fresh export/package builds and
  cross-platform compilation remain pending under X1/X2.

- Final root identity follow-up: imported sources pin canonical path plus
  device/inode; bind and adoption revalidate the root. The regression refuses
  both a symlink to identical contents and a new directory at the same path.
  Read-only wiring review confirmed the reported replacement issue is closed.
- Final test-gap audit found no missing co-located test. Its two stale-test
  findings were closed with lifecycle receipt/AbortSignal identity and Lume
  `/workspace` upload regressions. The full focused rerun is **212/212**, and
  the final native Lume rerun is **24/24**.
- Host adoption preserves an `Applied` receipt if ownership/status journal
  persistence fails after source publication, flags journal recovery and
  quarantines further work. A regression verifies that committed effects are
  not reported as an operation with no applied effect.
- An attempted full `cargo check --locked -p cognia-next --lib` aborted with
  exit **134** during another disk-exhaustion period and produced no diagnostic
  output. It is not a successful app-crate check. Final native `tauri-host`
  checking passed; fresh app build/packaging still requires sufficient space.

## Support continuation — 2026-10-24

The user requested further support work while retaining code-first scope.
This increment closes operation observation, cancellation and recovery UI gaps.
It does not claim real guest qualification or change the version/profile.

| ID  | Statement                                                                     | State    | Basis                                                                          | Depends on |
| --- | ----------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------ | ---------- |
| O2  | Settings previously awaited long operations without progress or cancellation. | Verified | pre-increment LumeSettings source and failing RTL regression, 2026-10-24       | G1         |
| O3  | Renderer AbortSignal previously hid a successful native adoption receipt.     | Verified | pre-increment client post-success signal check, 2026-10-24                     | C1         |
| O4  | An inherited raw descriptor can extend a closed Host's flock ownership.       | Verified | cloned-descriptor regression failed with lume_host_already_running, 2026-10-24 | C1         |

| ID  | Risk (impact)                                                                 | Severity | Source | Claim                                                                                        | Refuted by                                                                                         |
| --- | ----------------------------------------------------------------------------- | -------- | ------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| R7  | A late cancellation is reported as no effect after source adoption committed. | high     | O3     | Terminal Host receipts survive cancellation races.                                           | Applied files are hidden behind a cancelled renderer result.                                       |
| R8  | Long work remains invisible or appears cancelled before Host confirmation.    | medium   | O2     | UI shows bounded progress, waits for terminal cancellation and retires observers on unmount. | UI unlocks early, a late response replaces current state, or unmount keeps observing indefinitely. |
| R9  | A retired Host's inherited descriptor prevents safe ownership handoff.        | medium   | O4     | The last authoritative owner releases the lock; a live durable writer retains it.            | A raw fd clone blocks reopening, or reopening succeeds while a writer Arc still exists.            |

| ID  | Risk   | Method                                                          | Independence | Evidence                                                              | Coverage                                                                                                        | Status |
| --- | ------ | --------------------------------------------------------------- | ------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------ |
| V8  | R7     | Client receipt/cancel/poll-loss regression                      | tool         | Client suite: 8 passed; native actual source publication tests passed | Host success races, exactly-once cancel, no replay, content-free progress, post-publication epoch/write failure | passed |
| V9  | R7, R8 | Settings through real LumeClient with recorded native transport | tool         | Settings suite: 11 passed                                             | Progress, pending cancellation, unmount, translated recovery, stale success/failure, committed recovery flag    | passed |
| V10 | R8     | Native approval cancellation and stable error-code regression   | tool         | Native Lume: 31 passed                                                | Pre-dispatch cancellation, blocked stage transition and sanitised error projection                              | passed |
| V11 | R9     | Inherited descriptor and retained durable writer lock tests     | tool         | Both tests passed in native 31/31                                     | Raw fd inheritance cannot extend retired authority; writer Arc preserves exclusion                              | passed |

Acceptance: cancellation never implies a confirmed VM stop before native acknowledgement;
late successful effects remain visible; leaving Settings aborts its observer; Stop stays
available during foreground work; recovery text uses translated categories and never raw
SSH stderr/paths. Verify with co-located client/RTL/Rust tests, lint/type/i18n checks and
read-only preflight. Real Settings/VM acceptance remains V5/X1.

### Continuation verification

- Three native behavioral regressions failed before their fixes: inherited
  raw descriptor (`lume_host_already_running`), cancellation blocked on the
  stage lock (operation dispatched), and real source publication followed by
  epoch rotation (`lume_stale_resource`). Final native run:
  `CARGO_INCREMENTAL=0 cargo test --locked -p cognia-automation --lib cua_sandbox::lume`:
  **31 passed**. This also includes real source publication followed by an
  injected ownership journal write failure. No VM was used by these tests.
- Settings regressions first failed for missing progress/cancel controls,
  stale diagnostic rejection overwriting fresh state, and an applied receipt's
  recovery flag being ignored. Final focused client/settings run:
  **2 suites / 19 tests passed**. The final broader sandbox rerun passed
  **15 suites / 223 tests** (`.cache/lume-sandbox/jest-continuation-final.log`).
  Native transport is recorded; these tests
  are not desktop UI or real guest acceptance.
- Native `cargo check --locked -p cognia-automation --lib --features tauri-host`
  passed. Full `pnpm lint` passed after correcting the initial effect scheduling
  issue. Changed TS/TSX, locale sources and runbook passed Prettier checking.
- `pnpm i18n:build`, `i18n:build:check`, `lint:i18n`, and `i18n:sort:check` passed.
  Both locale sources contain **74 Lume leaf keys**. Read-only wiring/i18n
  review confirmed dynamic keys and receipt recovery routing.
- `pnpm typecheck` still fails with the same two errors outside Lume:
  `lib/claude/provider-attempt-options.ts:157` and
  `scripts/smoke/builtin-agent-budget-live.ts:594`. Log:
  `.cache/lume-sandbox/typecheck-continuation.log`.
- `pnpm lint:static-export` again failed collecting source paths with
  `spawnSync /bin/sh ENOBUFS`. The gate's exported scanner passed both changed
  browser modules with zero violations. This is a scoped import check, not
  a production static export. The smoke script contract test passed (1 test).
- `pnpm tauri:debug:agent:status` reported `bridge_unavailable` at
  `http://127.0.0.1:49522`. No new real-shell or guest UI result is claimed.
  Fresh app export/packaging and V5 remain blocked by the existing environment.
- Repeated ENOSPC interrupted one native build and a broader Jest run before
  all suites could load. Only this task's `.cache/lume-jest`, failed temporary
  file and exact native test artifact/object files were reclaimed. No unrelated
  cache, source, VM data or worktree was cleaned. The earlier native executable
  also needed a byte-identical APFS clone at a fresh inode after launch SIGKILL;
  its successful rebuild/runs above supersede that failed launch.
- Read-only preflight found the stale diagnostic failure, ignored recovery
  flag, pre-dispatch cancellation and post-publication epoch races. Fixes and
  corresponding tests were reviewed; no further concrete findings remained.
  No coverage run, installation, commit, push or PR was performed.

## Lifecycle, SSH and GUI exception review — 2026-10-24

The user explicitly requested further lifecycle, SSH and GUI exception-path
support with real VM acceptance deferred. Native contract regressions and
fake CLI/stdio peers own these checks; no new browser E2E is needed for these
native-only boundaries. Real integration remains V5/X1.

| ID  | Statement                                                                                                              | State    | Basis                                                                          | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------ | ---------- |
| O5  | Failed requalification/live profile checks can preserve old native readiness; delayed cleanup can revoke a newer boot. | Verified | Native/wiring review and failing native regressions, 2026-10-24                | C1         |
| O6  | Equivalent SSH keys compare as different raw strings; pre-cancelled subprocesses still spawn.                          | Verified | Canonical-key and pre-cancel regressions failed, 2026-10-24                    | C1         |
| O7  | Failed creation or ambiguous deletion can leave a permanently owned record after the VM path is absent.                | Verified | Fake CLI removal/nonzero and absent reservation regressions failed, 2026-10-24 | G1         |

| ID  | Risk (impact)                                                            | Severity | Source | Claim                                                                                       | Refuted by                                                                                                           |
| --- | ------------------------------------------------------------------------ | -------- | ------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| R10 | Failed probes or stale cleanup grant/revoke the wrong desktop authority. | high     | O5     | Qualification failures revoke old authority; full resource identity fences cleanup.         | An old fence stays usable after probe failure, or old cleanup changes a newer boot.                                  |
| R11 | Cancelled SSH work or duplicated key identity crosses a trust boundary.  | high     | O6     | Cancellation reaches subprocesses and commits; SSH key identity is canonical and validated. | A pre-cancelled process spawns, cancelled qualification commits readiness, or whitespace bypasses key reuse refusal. |
| R12 | Uncertain lifecycle effects cannot be reconciled safely.                 | high     | O7     | Durable intent and confirmed absence allow retirement; partial disks stay isolated.         | An existing/symlinked disk is retired as absent, or an absent native reservation cannot be cleared.                  |

| ID  | Risk | Method                                                    | Independence | Evidence                                                                                                           | Coverage                                                                                                                 | Status |
| --- | ---- | --------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| V12 | R10  | Native authority and stdio MCP fault injection            | tool         | Native Lume final: 56 passed; initial relevant regressions failed before fixes                                     | Invalid frames/coordinates/RGBA budget, stale cleanup, qualification/commit revocation, MCP handshake/order/timeout/drop | passed |
| V13 | R11  | Real subprocess cancellation and SSH key canonicalization | tool         | Canonical-key, pre-cancel, running qualification and final-lock cancellation cases passed in 56-test run           | Wire peer is test-only; no real guest SSH authentication                                                                 | passed |
| V14 | R12  | Fake CLI lifecycle and on-disk postconditions             | tool         | Interrupted delete, absent creation, retained disk, dangling symlink and active-writer cases passed in 56-test run | Stop-before-delete, durable intent, settled child ownership, confirmed absence, partial-disk retention                   | passed |

### Exception-path implementation and evidence

- The first fault-injection run failed **9 cases** (30 passed), establishing
  the stale qualification, stale cleanup, canonical-key bypass, pre-cancel
  spawn, invalid observations/captures and lifecycle recovery defects. A
  separate malformed-inspection regression failed because its old send fence
  stayed valid. A 5000×5000 grayscale PNG also reproduced a frame that passed
  the Driver but exceeded the shared RGBA frame budget. All are now refused
  or reconciled in the owning native layer.
- The final `CARGO_INCREMENTAL=0 cargo test --locked -p cognia-automation --lib cua_sandbox::lume`
  passed **56 tests**. stdio peers execute the production MCP handshake and
  ordered calls; errors/timeouts kill and reap the child, and a dropped call
  cannot reuse its response. The interrupted-input guard invokes the actual
  Stop implementation against the fake CLI and revokes its send fence.
- Healthy Shell Health/Connect tests create a real frozen binding, use a
  test-only framed helper peer through the shared production reply decoder,
  retain the binding/fence and approved schema pin when the optional GUI probe
  fails, then revoke authority on a mismatched Hello. This replaces only SSH
  transport in test builds; it does not attest real guest authentication or TCC.
- Final qualification publication checks cancellation, complete ResourceRef,
  native/account fence and current quarantine under the same journal lock.
  Tests cover cancellation while awaiting that lock and a stale snapshot after
  quarantine. Healthy rechecks do not retire active Shell bindings.
- Deletion persists intent, requires confirmed Stop and reconciles its actual
  absent-path postcondition even after CLI failure. Creation/deletion absence
  is never acknowledged while its lifecycle child can still publish files.
  Partial directories, dangling symlinks and missing paths without a matching
  native intent remain owned/quarantined. Reaped foreground processes no longer
  consume VM capacity. Secret-store cleanup failures retain a retryable recovery
  flag on the retired record.
- The UI regressions first failed for successful resource receipts containing
  GUI/recovery warnings. Settings now translates those stable categories too;
  host-key errors also route to the existing SSH guidance. Final related Jest:
  **15 suites / 225 tests passed**, including the real LumeClient with recorded
  native receipts. Log: `.cache/lume-sandbox/jest-exceptions.log`.
- Native `cargo check --locked -p cognia-automation --lib --features tauri-host`
  passed. `pnpm i18n:build:check`, `lint:i18n`, and `i18n:sort:check` passed;
  no locale keys were added. The smoke script contract test passed (1 test).
- Full `CARGO_INCREMENTAL=0 cargo check --locked -p cognia-next --lib` now
  **passed** (746 crates compiled), superseding the earlier space-exhaustion
  abort for that check. Log: `.cache/lume-sandbox/app-check-exceptions.log`.
  This checks the app crate; it is not Tauri packaging or GUI acceptance.
- Focused ESLint over the four changed TS/TSX source/test files passed with
  zero warnings. Full `pnpm lint` failed outside this increment at
  `sidecar/src/tools/state/host-background-shells.test.ts:360`
  (`@typescript-eslint/no-floating-promises`); the file was not modified by
  this Lume work. Log: `.cache/lume-sandbox/lint-exceptions.log`.
- `cargo clippy --locked -p cognia-automation --lib --features tauri-host -- -D warnings`
  stopped at diagnostics in `cognia-net` and `cognia-task-workspace`, including
  `detect.rs:431` and `revision_patch.rs:389`. It is not a clean Clippy pass.
  Those lines were not changed in this increment. Log:
  `.cache/lume-sandbox/clippy-exceptions.log`.
- Full `pnpm typecheck` still reports the same two errors outside Lume at
  `lib/claude/provider-attempt-options.ts:157` and
  `scripts/smoke/builtin-agent-budget-live.ts:594`; see
  `.cache/lume-sandbox/typecheck-exceptions.log`. The full static-export gate
  again hit `spawnSync /bin/sh ENOBUFS` while listing source files; its scoped
  scanner passed both changed browser modules with zero violations.
- Fresh native debug status is `bridge_unavailable` at `127.0.0.1:49522`.
  Real desktop UI and VM/SSH/Driver acceptance remain V5/X1 under the user's
  explicit deferral. Available disk increased during this increment; this
  does not qualify a guest or authorize automatic image installation.
- Read-only native, wiring/i18n and test-gap review found and checked the final
  writer-settlement, qualification-commit and RGBA boundary corrections. No
  remaining concrete finding was reported. No coverage, installation, VM
  mutation, commit, push or PR was performed.

## Requested gate repair — 2026-10-24

The user authorized fixing the remaining lint, typecheck, Clippy and
static-export-check blockers while continuing to defer real VM acceptance.
This section supersedes the earlier failures of those four checks. Additional
governance audits and production export/packaging remain separately recorded
under V6/X2; no release acceptance is inferred from a source-import gate.

| ID  | Risk           | Method                                                       | Independence | Evidence                                                                                                                                                        | Coverage                                                                                                                 | Status |
| --- | -------------- | ------------------------------------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| V15 | R5             | Run all four requested gates after repairs                   | tool         | `pnpm lint`, `pnpm typecheck`, automation all-target Clippy with `-D warnings`, and `pnpm lint:static-export` exited 0; logs under `.cache/lume-sandbox/gates/` | Root plus sidecar typecheck chain; automation library and test targets; all 11,684 tracked TS files in static gate scope | passed |
| V16 | R1, R2, R4, R5 | Native and JS regression plus independent wiring/test review | tool         | Jest 22 suites / 372 tests; sandbox 244 passed / 11 ignored; dependency crates 833 tests; sidecar 149 tests; scanner 15 tests passed                            | Offline fixtures, production call paths, local files/processes/sockets; no real guest, provider or desktop UI acceptance | passed |

### Repairs

- Awaited the sidecar background-shell registry cleanup instead of leaving a
  floating Promise. The existing sidecar suite passed **21 tests**.
- Added the already-used summary credential `protocol` to the shared agent
  configuration type. A typed regression checks Anthropic versus OpenAI
  summary budgeting. Wrapped `parseProgressCheckpoint` in the smoke script's
  map callback so the array index is not supplied as immutable anchors. The
  actual sidecar checkpoint suite passed **25 tests**. The final unfiltered
  command also exposed a compaction fixture whose `pending` status widened
  to `string`; an explicit existing `ProgressCheckpoint` type fixes the
  fixture without changing its assertions. That suite passed **103 tests**.
  A concurrent connector
  fixture type error appeared during baseline checks and was resolved by its
  owning task; those edits were preserved.
- Replaced buffered shell-based `git ls-files` with asynchronous, streamed,
  NUL-delimited argv execution. Enumeration failures fail the gate. New
  regressions first failed for an index larger than 1 MiB and for a tracked
  newline filename, then passed after the fix. Existing literal NUL bytes in
  the deduplication key are now equivalent source escapes.
- Moved Node file IO out of the browser engine's bundle into a reader port
  installed by both actual CLI entrypoints. Startup tests clear the port,
  boot the real function and read a temporary binary file. Browser execution
  still refuses unavailable Host file access. The existing artifact fixture
  imports are used exclusively by seven host test files; two inline
  exemptions state that narrow reason. No allowlist or deny set was relaxed.
- Fixed strict Clippy findings in `cognia-net`, Task Workspace, remote
  desktop and automation. Existing modules now group execution context,
  helper deadlines/cancellation/admission, lease proofs, frame-bound input
  and handoff transfer arguments. Type aliases clarify connection/handler
  maps. All callers, including Companion RPC, were updated; serialized RPC
  fields were unchanged. Required tungstenite callback error ownership is
  confined to trait implementations. No lint suppression was added.
- Broader regression exposed a truncated bundle header incorrectly accepted
  because `split` produced a final empty item. Parsing now requires an actual
  blank-line terminator. The local provider admission test now initializes
  the same network policy required by the production client; it still
  verifies revocation before any paid create request, using only loopback.
- CLI regression diagnosed a real failed-start cleanup leak: the browser
  companion reconciliation timer was created before notifier startup could
  throw. It is now allocated after setup succeeds. `Dexie.liveQuery` uses
  the default export, matching existing Node/CJS-compatible runtimes. The
  new failure test first observed the leaked timer; failure and normal
  teardown now pass. Actual CLI startup also asserts this runtime did not
  fail. The final Jest process exited normally without `--forceExit`.

### Final verification

- `pnpm lint`: **exit 0**, zero warnings (`lint-final.log`).
- `pnpm typecheck`: **exit 0**, including the root and chained sidecar checks
  (`typecheck-final.log`).
- Separate typechecks for `@cognia/agent-cli` and
  `@cognia/agent-config-types` passed (`cli-package-typecheck-final.log`).
- `CARGO_INCREMENTAL=0 cargo clippy --locked -p cognia-automation --all-targets --features tauri-host -- -D warnings`:
  **exit 0** (`clippy-final.log`). This is broader than the initially blocked
  library-only command.
- `pnpm lint:static-export`: **11,684 TS files audited, 17 existing allowlist
  matches, zero violations** (`static-final.log`). Its own test command
  passed **15/15** (`static-tests-final.log`).
- Final Jest through `pnpm test`: **22 suites / 372 tests passed**, normal
  exit 0 (`jest-final.log`). The headless cleanup suites separately passed
  with `--detectOpenHandles` (`runtime-cleanup-final.log`).
- `cargo test --locked -p cognia-automation --lib cua_sandbox -- --test-threads=4`:
  **244 passed, 11 ignored**, including all **56 Lume tests**
  (`sandbox-tests-rerun.log`). The initial unrestricted concurrent run had
  four failures: the header defect, uninitialized fixture policy and two
  fixture wait timeouts under process contention. Production and test
  timeout assertions were retained; final bounded-concurrency tests passed.
- Full library suites for `cognia-net`, `cognia-remote-desktop` and
  `cognia-task-workspace`: **207 + 78 + 548 = 833 passed**
  (`rust-dependency-tests.log`).
- Full `cargo check --locked -p cognia-next --lib` passed again after the
  cross-crate call updates (`native-final.log`); this is compilation rather
  than Tauri packaging or UI acceptance.
- i18n build consistency, i18n lint/sort, changed JS/TS Prettier checks and
  `git diff --check` passed. No coverage check was requested or run.
- Read-only native, wiring/static-export and test-gap follow-ups found no
  remaining concrete blocker in this scope. Tests use fake CLI/stdio peers
  or local fixtures; real VM/SSH/GUI/TCC acceptance remains V5/X1. No Lume
  installation, guest download, VM mutation, commit, push or PR occurred.

## Governance and production export follow-up — 2026-10-24

The user explicitly authorized the remaining command-parity, manifest,
Rust-architecture and full production static-export work. Real VM acceptance
remains deferred. This section supersedes the earlier governance/build
failures; native release packaging is separately recorded under X5.

### Corrections and regression evidence

- Command parity's seven hits were local functions named `invoke`, not calls
  to unregistered Tauri commands. Renamed those helpers to `callControl` and
  `callHost`; no new native entrypoint was exposed. Tests verify all six
  local viewer operations and the source-host identity query still use
  `managed_desktop_local_call` with the expected resource and fence fields.
- The manifest checker now reuses the generator/grammar gate's existing
  `isEphemeralPreviewCommand` rule. The two internal preview capability
  issuers forbid durable replay receipts containing bootstrap plaintext.
  New tests first failed on those valid descriptors, then passed while
  still rejecting other names, targets, transports and structural mutations.
  The manifest, command permissions and idempotency contract were not changed.
- Added the explicit same-domain CCSwitch-to-Skills edge: it reuses the
  native skill bundle reader and resource type, without a reverse dependency
  or default Tauri reach. SIWC's exact desktop modules are registered as
  AppHandle/account/process adapters around existing subscription-domain
  logic. Independent ADR-0196 review confirmed both placements.
- Magpie's bounded JSON/path discovery and all three tests moved from the
  app shell to the existing provider-relay interop crate, `cognia-ccswitch`.
  A separate library module is needed because it reads Magpie JSON rather
  than CCSwitch SQLite. The existing `provider_diagnostics.rs` shell now
  delegates through `spawn_blocking`; `magpie_gateway_port` and its permission
  name are unchanged. `rust-architecture-baseline.json` is byte-identical to
  the initial snapshot; the two previously baselined findings remain visible.
- The initial production prebuild failed on four apparently missing MCP
  exports. Import-graph inspection found two actual causes: the mixed
  Computer Use module imported renderer transport state, and the otherwise
  pure Skills serializer imported `isTauri` through that barrel. A separate
  `computer-use-proxy.ts` is necessary to give the Node build its real TCP
  transport without renderer dependencies. The shared adapter retains the
  desktop path; the MCP build resolver selects the Node module. Existing
  socket tests moved beside that module, and the canonical platform detector
  replaces the serializer's barrel import. No extra host mutation exports or
  dispatch permissions were added. The complete produced MCP sidecar still
  passes its graph guard, syntax check and actual stdio handshake/tool listing.
- Read-only test review caught an outdated Skills IO platform mock. It now
  mocks the canonical detector and verifies both successful Tauri file reads
  and an actual controlled filesystem rejection. Browser refusal also asserts
  that no filesystem read occurs. Two obsolete file-level Node exemptions
  were removed; their exact moved imports carry inline reasons. The tracked
  static-export scan and a direct scan of the new untracked proxy both pass.

### Final commands and artifacts

- `pnpm audit:command-parity`: **10,073 TS files, 313 distinct literal
  commands, all registered**; exit 0 (`parity-followup-final.log`).
- `pnpm audit:companion-command-manifest`: **1,736 descriptors, 1,339 Tauri
  registrations, 948 remote commands**, contract v3; exit 0
  (`manifest-followup-final.log`).
- `pnpm audit:rust-architecture`: **70 crates layered**, exit 0; the two
  existing baseline entries were preserved (`architecture-followup-final.log`).
- Gate regressions: **20 command-parity/parser tests + 54 manifest, grammar
  and architecture tests passed**. Related Jest: **5 suites / 82 tests passed**.
  Produced MCP bundle/protocol and graph tests: **5 passed**.
- `cargo test --locked -p cognia-ccswitch --lib`: **51 passed, 1 ignored**,
  including the migrated Magpie tests. Full `cargo check --locked -p cognia-next --lib`
  passed (`ccswitch-followup-tests.log`, `native-followup-final.log`).
- Full `pnpm lint` and raw `pnpm typecheck` (root plus all five chained
  sidecar targets) exited 0. The new optional viewer-status test initially
  needed an explicit presence assertion for the shared session interface;
  the final run retains that runtime check. Changed-file formatting,
  static-export import checking and `git diff --check` also passed.
- Actual `pnpm build`, including all prebuild steps, webpack production
  optimization, prerendering, export and postbuild, exited **0**. Compilation
  took **5.9 minutes**; **129/129** static routes generated with **zero dynamic
  routes**. Output contains **127 HTML files**. Existing Node localStorage
  experimental warnings and Serwist registration guidance did not fail the
  build; no warning/error check was disabled for this task.
- Local static preview returned HTTP 200 for `/`, `/settings.html` and
  `/workspace.html`. All **797** referenced Next script/style/preload assets
  matched their exported file content hashes. In the actual browser,
  `Settings — Cognia` rendered the isolated origin's `Create local account`
  gate, with no captured console errors. No account was created and no VM
  action ran. Temporary preview tabs and servers were closed after checking.
- Artifact identity and hashes are saved in
  `.cache/lume-sandbox/gates/export-followup-verification.json`; build output
  is `.cache/lume-sandbox/gates/build-followup-final.log`. Native, wiring and
  test-gap reviewers rechecked the affected boundaries. No coverage run,
  commit, push, PR, guest installation or real VM acceptance was performed.

## Adversarial review — 2026-10-25

The user requested an adversarial review and explicitly skipped the optional
cross-model pass. Three independent read-only reviewers examined lifecycle,
SSH/Driver/guest transport and the actual shared UI/runtime integration. The
main session reconciled their findings against current source and repeated
the Start/Stop and TS witnesses. No product source was changed. This section
reopens M1 through V18/X6; the earlier successful gates remain historical
evidence for their stated scope, not proof of the invariants refuted below.

The following are seven remediation groups. Group 2 contains two separate
native binding defects; group 6 contains three shared-UI receipt defects.

1. **P1 — Start can spawn after Stop has confirmed the VM stopped.**
   `service.rs:1001–1006` awaits durable state and then calls `run_vm` without
   another cancellation/epoch admission. A concurrent Stop can rotate the
   epoch, inspect the still-stopped guest and return before that spawn.
   Start's interrupted-loop cleanup at `service.rs:1020` uses its old epoch
   and is rejected. The fake CLI witness observes a running guest and live
   foreground child after Stop returned. Admission and spawn registration
   need a barrier that Stop cannot finish ahead of, with explicit settlement
   of a child that races revocation. Add a deterministic pre-spawn Stop test.

2. **P1 — Native bindings lack session membership enforcement and expiry.**
   `service.rs:1564–1595` accepts the caller's existing `group_id` and stores
   an arbitrary `session_id`. That session field has no subsequent reads;
   `bound()` checks the account generation and binding token but not a trusted
   caller session or approved group membership. A caller in the same unlocked
   account can claim an existing group ID to obtain a fresh binding for a
   different session. In addition, `journal.rs:65–72` has no binding expiry
   and the local protocol has no renewal. Only operation leases have a timer;
   completion removes it at `service.rs:505–506` while background work may
   remain. Loss of the renderer without a successful unbind therefore has no
   independent native expiry/Stop path. Add trusted session/group admission
   and a native binding watchdog. Test unauthorized membership, mismatched
   caller sessions, and heartbeat loss after a normally completed command
   leaves background work. These gaps are source-confirmed; no live renderer
   crash or cross-session VM scenario was run.

3. **P1 — Stop in the shared Manage sheet cannot preempt Start.**
   `use-sandbox-connections.ts:165–170` routes Stop through `runLifecycle`,
   whose per-connection FIFO at line 268 waits for Start to finish. The sheet
   also disables every action while busy at `sandbox-connection-sheet.tsx:219`.
   Lume rows are visible in that shared registry, so this is a reachable entry
   point. The dedicated Lume panel has its own working urgent route, but it
   does not repair this entry point. The TS witness confirms no native Stop
   is sent while Start remains pending. Route urgent Stop outside this queue
   and retain a usable Stop control. Add a shared-sheet pending-Start test.

4. **P1 — Guest typed-file CAS can overwrite a concurrent edit.**
   `cognia-desktop-guest/src/lume.rs:543` compares the expected hash, then
   `AnchoredFile::replace` publishes with unconditional `renameat` at line 769.
   The guest's advisory file lock does not constrain Exec or its retained
   background writers. A competing write between comparison and publication
   is silently replaced and the typed operation returns success. The isolated
   witness reports `CAS_RETURNED_SUCCESS=true` and
   `COMPETING_UPDATE_PRESERVED=false`. The implementation must either provide
   the promised concurrency guarantee or refuse typed edits while writers
   cannot be excluded; a sequential stale-hash test is insufficient. Add a
   retained-writer compare/publication race test.

5. **P2 — A post-publication file error loses its effect receipt and containment.**
   Guest `lume.rs:757–780` can publish with `linkat`/`renameat` and then fail
   directory `sync_all`, returning `file_sync` although the target changed.
   Host `service.rs:2181` and `:2283` exclude every `lume_guest_*` error from
   containment, including this one. A safe pre-publication conflict and a
   committed-but-not-durable effect need different handling. Preserve the
   applied/uncertain receipt or quarantine and confirm Stop. Desktop control
   quiescence may block subsequent admission; it does not restore the missing
   receipt or perform the required Stop. This is source-confirmed, without
   filesystem fault injection. Add a post-publication fsync-failure test for
   typed edits and human upload.

6. **P2 — Shared lifecycle settlement still assumes Docker receipts.**
   `use-sandbox-connections.ts:129–132` throws a Docker mapped-port error after
   a successful native Lume Start. Its Stop path at `:170–180` discards
   `result.lume`, preserving the old boot epoch and true readiness flags;
   the next Health sends that old reference and fails native identity checks.
   Its Health path at `:194` checks only `result.health`, while Lume returns
   `healthReport.reachable`; a healthy guest is marked unreachable. Three
   separate production behaviors, including the next-call identity, were
   reproduced through the real TS adapter/dispatcher/hook path. Project Lume
   terminal resources into the shared row and consume the structured health
   report. Add Start, Stop/next-call and healthy-receipt integration tests.

7. **P2 — GUI qualification does not pin the Driver executable identity.**
   Guest `cognia-lume-guest.rs:196–213` verifies signature integrity of
   `/Applications/CuaDriver.app` and separately executes
   `/usr/local/bin/cua-driver`. It does not prove the CLI belongs to that app,
   pin the approved signer/artifact, or identify the running daemon.
   `driver.rs:319–353` subsequently relies on self-reported version and schema.
   An executable/app replacement preserving those values can retain the
   existing qualification. Bind the approved app/CLI/daemon identity into the
   qualification and recheck before dispatch. This is a source-confirmed
   provenance gap; no replaced-app/TCC experiment was performed, and no Host
   code-execution exploit is claimed. Add identity-replacement regressions
   with unchanged protocol output.

### Reproduction evidence and limits

- Existing focused Jest run: **98 passed, 1 failed, 6 suites**. The failing
  existing assertion expects Docker image `0.3.46-1`, while the current default
  is `0.3.46-2`; this separate fixture drift is not a Lume regression.
  Log: `.cache/lume-review/existing-focused-tests.log`.
- The cache-only integration witness has **5 failed expected-behavior
  assertions**, proving groups 3 and 6. It uses the real hook, registry,
  dispatcher and adapter; native `LumeClient.run` and DB boundaries are mocked.
  Source: `.cache/lume-review/use-sandbox-connections.regression.test.ts`.
  Log: `.cache/lume-review/generic-entry-regressions.log`. Reproduce with:

  ```sh
  pnpm test --runInBand --runTestsByPath .cache/lume-review/use-sandbox-connections.regression.test.ts --testPathIgnorePatterns=node_modules --testNamePattern='Lume native terminal' --coverage=false
  ```

- Start/Stop extracted harness: the **bug-existence test passes**, showing
  Stop followed by a later spawn and a surviving fake process. This PASS is
  defect evidence, not acceptance. The copy begins after capacity admission,
  inserts one scheduling barrier and stubs unrelated keyring/workspace types.
  Production state transitions, Stop, spawn, inspection and cancellation are
  retained. Details, original source hashes and output:
  `.cache/lume-adversarial-lifecycle-2026-10-25/{README.md,source.sha256,run.log}`.
- CAS extracted harness: one **bug-existence test passes**, with two barriers
  immediately before the copied `file.replace`. Production comparison and
  publication algorithms remain unchanged. Details:
  `.cache/lume-adversarial-transport-2026-10-25/cas-race/{provenance.json,result.log}`.
- The current test host reports Node `24.19.0`, below the repository's declared
  `>=26.0.0`. The above Jest assertions ran; this review did not rerun lint,
  typecheck, Clippy, governance gates or the production export under that
  environment. Earlier successful commands are not represented as fresh runs.
- Source review did not confirm a new Host fallback or SSH interpolation
  bypass. Empty readable arrays alone do not establish a deny-all policy under
  the current policy bridge, so that suspicion was excluded. Same-generation
  emergency Stop epoch rebasing was treated as an intentional recovery path,
  not counted as a stale-normal-operation finding.
- The proposed Retina mapping defect was excluded: the current upstream
  [desktop-state contract](https://cua.ai/docs/cua-driver/reference/mcp-tools/apps-windows-and-screen#get_desktop_state)
  and [pointer contract](https://cua.ai/docs/cua-driver/reference/mcp-tools/pointer-cursor-and-browser#move_cursor)
  describe session-based screenshot-coordinate mapping, and the adapter uses
  one stable session label. This does not replace real A10–A13 qualification
  of the selected Driver artifact.
- No coverage, guest installation, real VM/SSH/GUI/TCC acceptance, commit or
  push was performed. Product implementation and its tests remain unchanged;
  this ledger and ignored review artifacts record the outstanding work.

## Remediation — 2026-10-26

The user authorized fixing the seven groups above, then requested continuing
with typecheck skipped. Real VM acceptance remains deferred. The historical
V18 witnesses remain defect evidence; the following fixes and regressions
exercise the current production paths.

1. **Spawn and Stop ordering.** A native spawn gate covers admission, child
   creation and registration. Stop preempts before waiting for that gate and
   settles registered children before confirming stopped state. Strict stale
   cleanup validates its complete resource reference before cancelling any
   active task, under the same journal lock as preemption; explicit emergency
   Stop retains its same-generation recovery scope. Deterministic tests cover
   revoked/late spawn, Stop waiting on spawn, and old-boot cleanup leaving a
   new-boot cancellation flag unchanged.
2. **Native session authority and cleanup.** One-shot native approval admits
   one session per resource lifetime, with Host-generated execution group IDs.
   Full binding references include the session ID and frozen account/VM
   identity. Native leases expire after 15 seconds; active sessions renew at
   5-second intervals, and the watchdog retires expired bindings and Stops the
   VM. Closing a session stops renewal before waiting for rebind consent.
   Feature disable revokes admission but preserves the watchdog's cleanup
   owner; successful and failed Stop paths are covered, including persisted
   quarantine. Legacy journal bindings are discarded before typed decoding.
3. **Reachable urgent Stop.** The shared Manage sheet retains an independent
   Stop control while Start is pending. Its hook bypasses the lifecycle FIFO,
   invalidates late operations and checks its generation inside serialized DB
   projection writes. Tests cover delayed initial reads/writes and verify no
   stale Start is sent after Stop.
4. **Retained writer boundary.** Before Shell execution or GUI input, native
   state permanently records writer exposure. Typed mutations and uploads then
   refuse before guest dispatch. A confirmed Stop preserves this field because
   startup jobs can resume after reboot; only a fresh clean resource supports
   that typed-write profile again. Reads and same-group Shell/GUI remain
   available. This is an explicit admission restriction, not a claim that
   advisory locks provide filesystem CAS against arbitrary writers. Settings
   and upload errors show matching English/Chinese clean-clone guidance.
5. **Publication uncertainty.** Only exact known pre-publication guest refusals
   avoid containment. Unknown errors, publication failures and directory fsync
   failures require Stop. A guest fault-injection test observes published bytes
   plus a sync error; native tests verify containment for both typed files and
   uploads.
6. **Lume lifecycle receipts.** Shared Start, Stop and Health project the native
   Lume resource, including the new boot epoch and readiness, and consume the
   structured health report. They no longer assume a Docker mapped port. The
   five previously failing TS behavioral assertions are covered by colocated
   integration regressions.
7. **Approved Driver and dispatched identity.** Qualification pins the approved
   signed app/CLI artifact and running daemon identity. The guest validates the
   CLI target, code signature, executable hash, team/requirement/CDHash, socket
   peer PID/UID and actual loaded code identity through Security.framework.
   The bounded SSH MCP relay strips the private initialization pin and checks
   the identity immediately before every forwarded request. Tests cover a
   replaced executable at the same path, altered artifact identity with stable
   protocol metadata, and refusal before forwarding queued input.

### Reproduction and verification

Logs and before-edit snapshots are retained under
`.cache/lume-remediation-2026-10-25/`; the date names the start of this repair.

- Red evidence: `upload-guidance-red.log` confirms the generic upload message;
  `disable-red.log` confirms lost cleanup after disable; `stale-cleanup-red.log`
  confirms an old-boot cleanup flipped a new-boot flag. Earlier UI/spawn red
  regressions are also retained. Each was corrected without weakening its
  assertion.
- `pnpm test -- <10 scoped suites> --runInBand --cacheDirectory=.cache/lume-jest`:
  **244 passed**, log `jest-complete-final.log`. Existing negative audit-persistence
  fixtures emit their expected warnings. No coverage command ran.
- `CARGO_INCREMENTAL=0 cargo test --locked -p cognia-automation --lib cua_sandbox
--config 'profile.dev.package.objc2-app-kit.debug=0'
--config 'profile.dev.package.cognia-automation.debug=0' -- --test-threads=2`:
  **260 passed, 11 ignored**, log `native-verified.log`. The command-only
  overrides reduce debug data after an initial ENOSPC archive failure; they do
  not disable tests, assertions or checks.
- `cargo test --locked -p cognia-desktop-guest`: **22 library + 1 existing
  binary + 3 Lume binary tests passed**, log `rust-tests-complete.log`. The
  local signed-process identity swap test uses its own temporary copied
  executable; it does not launch a VM or exercise TCC.
- Strict Clippy for both changed Rust packages, all targets and
  `cognia-automation/tauri-host`, with `-- -D warnings`: **passed**, log
  `native-verified.log`.
- `pnpm lint`: **passed**, log `lint-verified.log`.
- `pnpm i18n:build`, `i18n:build:check`, `lint:i18n`, `i18n:sort:check`:
  **passed**, log `i18n-complete.log`. Read-only i18n review found no new raw
  user-facing strings or missing EN/ZH references.
- Command parity, Companion manifest, Rust architecture and static-export
  compatibility: **passed**, log `governance-complete.log`. The architecture
  gate still reports its two existing baselined findings.
- The production prebuild exposed an unrelated runtime-import scanner defect:
  its regex crossed a declaration into a type-only import. A failing regression
  precedes the TypeScript AST fix; the linked-package scanner's **8 tests
  passed**, with no empty runtime exports or package-manifest workaround.
- The normal production build compiled successfully in 7.5 minutes, then
  failed during static page generation with ENOSPC. The failed attempts had
  produced 15 ignored production-cache files. Their birth times were later
  than this repair's first build, and inode/size/mtime, Git-ignore status and
  open handles were checked immediately before removing only those files.
  `build-cache-cleanup.json` retains the itemized list and an observed free
  space delta of 8.079 GiB; concurrent disk activity means that delta is not a
  per-file reclamation measurement. No other task's files were removed.
  The complete prebuild/build/postbuild then **passed** with the existing
  command-only `COGNIA_DISABLE_WEBPACK_CACHE=1` switch: compilation took
  **3.1 minutes**, **129/129** static routes generated, **zero dynamic routes**,
  **127 HTML files**. A temporary loopback server returned matching bytes for
  `/`, `/settings.html`, `/workspace.html` and all **802** referenced Next
  script/style/preload assets; it was shut down afterward. Logs:
  `build-no-cache.log`, `export-verification.log`; build identity and every
  checked asset hash: `export-verification.json`. This continuation deliberately
  skips typecheck per the user. Earlier typecheck output is historical and is
  not claimed as a fresh check of the final source.

A final test-gap review requested two persistent behavioral tests beyond the
earlier transient witnesses. The hook now blocks an actual mocked DB update
while asserting immediate native Stop dispatch, then releases the write and
asserts stopped state/new epoch wins. The native Shell-entry test reads the
persisted journal at the helper-send boundary, then verifies typed writes and
uploads refuse without another send. Its initial incomplete success receipt
was rejected by the production schema; the fixture now supplies the full
receipt rather than relaxing the schema or assertions.

Read-only lifecycle, transport and UI follow-up reviews checked these
boundaries. Real Lume CLI/VM, SSH, logged-in Driver, GUI/TCC, signed Tauri
release packaging and cross-platform acceptance remain unverified. No guest
installation, image download, coverage, commit or push ran in this repair.
