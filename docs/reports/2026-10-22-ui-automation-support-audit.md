# UI automation support audit — 2026-10-22

The audit identified browser recording/replay, native app scoping/click semantics,
and test-harness defects. The authorized repair follow-up below records the
implementation and current validation; the later support inventory and findings
retain the original pre-repair evidence. Remaining platform and OS-gesture acceptance stays open.

Repairs are uncommitted in the shared working tree. The evidence ledger is
[here](../evidence/2026-10-22-ui-automation-support-audit.md).

## Repair follow-up — 2026-10-22

The user authorized implementation after the independent review. Changes are
uncommitted in the shared checkout. The original inventory and findings below
are the **pre-repair baseline**, not a statement that those defects still exist.
macOS settings/consent and app-state acceptance passed. Remaining platform/gesture acceptance and repository-wide quality gates stay open.

| Findings       | Implemented behavior                                                                                                                                                                                                                                                                                                                                                                                 | Verification boundary                                                                                                                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1 / F10 / F12 | Replay resolves targets through the selected engine and rejects failed required navigation. Fixed, privileged recording controls replace generic evaluate. Chromium records in a private execution world with a host-owned journal, without trusting site globals or sessionStorage. Permanent capture failures invalidate the take and surface a localized error.                                   | Focused regressions plus authenticated HTTP → actual Chromium local/cloud flows. Public-origin and post-human-input evaluate refusals remain in place.                                                                                                             |
| F2             | Injected tests use a test-local facade while the actual production helper remains frozen.                                                                                                                                                                                                                                                                                                            | Complete debug command: 73 Node + 34 injected Jest tests passed.                                                                                                                                                                                                   |
| F3 / F5 / F13  | Native specs use the bundled E2E client, current enabled/perSurface settings, semantic button names, real gated calls and exact outcomes. Settings and emergency state restore in finally. Tests cover allow once, reject, close, scoped timed grant, timeout and late approval after kill.                                                                                                          | Actual macOS agent-debug API v3: 7 settings/consent cases passed, with exact policy/kill-state restoration. Semantic actions retain stability and hit-test checks; late approval returns KILL_SWITCH_ACTIVE. Windows WebView2 was not run.                         |
| F4             | Windows enumerates running window owners, resolves app locators, selects one exact-PID non-minimized window, reads that HWND's nested bounded UIA tree, and captures that window. Invalid hints fail instead of selecting another surface. Backend defaults never widen an app capture/tree to the desktop.                                                                                          | Platform-independent ownership/selection tests pass. Windows cfg code received source/API review but was not compiled or operated on Windows.                                                                                                                      |
| F6             | Capabilities expose operation-specific support, including explicit Linux app-session and macOS window-op refusals. The local /cu readiness summary respects app-session support.                                                                                                                                                                                                                     | Tools remain target-neutral: activation-time host filtering was rejected because it breaks a supported remote target behind a Linux host. A target-aware capability catalog and Linux AT-SPI implementation remain future parity work.                             |
| F7 / F11       | Windows click button/count and macOS element click semantics are preserved. Coordinate fallback requires the actual foreground window; AX checks window identity, PID and geometry, UIA checks HWND/visibility/bounds. Drag uses button/steps/duration and always attempts release after a move failure. Element scroll resolves geometry or explicitly refuses. Unsupported click modifiers refuse. | Native shared contract regressions pass; controlled OS context-menu/double-click/drag and multi-monitor acceptance remain open. macOS window_op remains explicitly unsupported.                                                                                    |
| F7 OCR         | Model-facing OCR requires an app revision, reads its host-held zoom frame, maps both axes to the shown frame, and uses canonical pixel actions with the single-use token. Policy coordinates derive from host-owned geometry with native negative-origin rounding. Missing/old/stale geometry refuses; generic direct OCR API keeps its documented legacy compatibility path.                        | OCR/plugin regressions pass, including wrong revision, missing geometry, negative monitor origins and canonical action refusal. No actual native/cloud OCR provider was exercised. Token expiry is retained: slow OCR requires a fresh state and another OCR pass. |
| F8             | Six expired exceptions were re-reviewed against existing implemented executors. Their unchanged assertions are honestly labeled editor/persistence contracts. Stale exception entries were removed. Wallpaper checks wait on rendered route state, fonts and finite animations.                                                                                                                      | Governance passes. Existing executor/registration tests: 35 passed. Wallpaper/editor browser acceptance is blocked by the production build prerequisite.                                                                                                           |
| F9             | No unsupported platform acceptance is inferred from mocks or headless Chromium.                                                                                                                                                                                                                                                                                                                      | Fresh macOS build/boot/API v3, 7 consent/settings cases, app tree/capture/zoom and adjacent Workflows passed. Windows/Linux/device/deployed-remote behavior and OS gestures remain unaccepted.                                                                     |

Independent repair reviews found and prompted fixes for forged recording helpers,
shared-storage injection, printable shadow-DOM key events, weak secret-field
descriptors, late consent after kill, native coordinate fallback ownership,
missing named-page tests and OCR policy-coordinate loss. No external cross-model
CLI was invoked, in accordance with the user's choice.

The fixed browser RPCs retain execution/write, agent.run, high-risk, interactive
approval and idempotency classifications. The plugin facade excludes these
human-recorder methods. Existing paired-client transport restrictions are
unchanged. No generic evaluate guard was relaxed.

Repair checks actually run (logs under `.cache/ui-automation-audit/`):

| Check                                                                               | Actual result                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Final combined focused Jest (17 suites)                                             | 674 passed; includes browser, bridge, manifests, OCR/plugin and malformed recording regressions                                                                                                                                 |
| Native follow-up Jest (hook, initializer, overlay)                                  | 3 suites / 30 tests passed, including receipt-clock countdown regression                                                                                                                                                        |
| Native automation domain Rust                                                       | 606 passed, 3 pre-existing ignores, 208 filtered; includes renderer elementRef and deep locator-stack regressions                                                                                                               |
| Local-browser bridge Rust                                                           | 14 passed, 89 filtered                                                                                                                                                                                                          |
| Complete debug helper command                                                       | 73 Node + 34 Jest passed                                                                                                                                                                                                        |
| Workspace runtime browser + HTTP dispatcher, with installed Chrome                  | 57 passed, 0 skipped; includes real local/cloud subtests                                                                                                                                                                        |
| Existing workflow executor/registration checks                                      | 35 passed                                                                                                                                                                                                                       |
| E2E governance, i18n build/check/lint/sort, companion/CLI generated-contract checks | Passed                                                                                                                                                                                                                          |
| Scoped ESLint / formatting / final evidence validation                              | Scoped ESLint, owned-source Prettier, native automation rustfmt and explicit-path diff checks pass; ledger final check has 0 errors / 0 warnings                                                                                |
| Root typecheck                                                                      | Earlier repair-phase run exited 2 on unrelated CLI/Claude/connectors/smoke errors. Native follow-up skips typecheck at the user's explicit request                                                                              |
| Root lint                                                                           | Failed on pre-existing generated public/.p0-native-fixture/bundle.js; task-scoped lint is checked separately                                                                                                                    |
| Root build                                                                          | Failed before Next build: four missing exports in scripts/build/mcp-bridge-runtime.ts used by prompts adapters                                                                                                                  |
| Static-export gate                                                                  | Blocked by spawnSync ENOBUFS while enumerating git ls-files; did not reach source analysis                                                                                                                                      |
| Real Tauri                                                                          | macOS build/boot/API v3; 7 settings/consent cases passed; exact-PID app tree/capture/zoom and Workflows heading passed. Original full settings/kill state restored with automation disabled. No forced clicks or guard changes. |

Actual Chromium procedure: use temporary profiles, fulfill a synthetic public
origin locally, call the authenticated runtime control endpoint, start recording,
resolve an engine-owned ref and click it, dispatch human keyboard input, drain
ordinary text and redacted secret fields, and verify arbitrary evaluate remains
refused. Repeat with page-intrinsic spoofing, forged sessionStorage, secret field
descriptors and open/closed-shadow printable-key events. These are real browser
and HTTP checks on this machine, not a deployed host or full product UI run.

Final scoped validation: ESLint exits 0, the owned JavaScript/TypeScript and
changeset paths pass Prettier, native automation and gateway/output-registry paths
pass rustfmt with the workspace's edition 2021, and explicit-path `git diff
--check` exits 0. The broader shared bridge/RPC diff includes concurrent changes; only the
automation recovery path is included in this task's functional review. The evidence ledger remains **verifying**:
remaining platform/device/OS-gesture acceptance and repository-wide gates stay open. No coverage
command was requested or run.

## Native follow-up — 2026-10-22

The user freed disk space, requested actual Tauri verification, confirmed that
master automation must remain disabled, and explicitly requested skipping
typecheck. Actual native IPC and window images exposed four additional defects,
now repaired:

- `ClickTarget` and `ScrollTarget` did not accept the renderer's `elementRef`;
  the first actual call failed before consent with `missing field element_ref`.
  Both now serialize camelCase and accept the legacy snake_case alias. The wire
  regression failed before the fix; automation Rust then passed 605 tests, with
  3 pre-existing ignores and 208 filtered.
- Main chat boot did not request desktop-tools, so consent was not mounted for
  a direct gated call. The existing overlay now mounts under the existing
  Tauri/main-window guards, independently of desktop-tools readiness. The mount
  regression failed before the fix and now passes.
- The first consent countdown after idle used an old display clock. An actual
  30-second prompt first displayed 136 seconds. The hook now anchors the display
  clock and deadline to the same receipt time. The new regression reproduced
  95 seconds for a 5-second prompt before the fix. Hook/initializer/overlay Jest
  now passes 3 suites / 30 tests; the Rust timeout is unchanged.

A later capture during the countdown check aborted the app with an
`automation-worker` stack overflow. The macOS crash stack points to recursive
`assign_locators_inner` calls during ancestry encoding. A 256-level tree on a
256 KiB thread reproduced SIGABRT. Locator assignment now uses a heap work list,
preserving preorder, ancestry paths and sibling ordinals; all 606 automation
Rust tests pass, with 3 existing ignores and 208 filtered. Exact persisted policy
was restored after the abort and the disabled master verified. The rebuilt app
then completed the same countdown/app-capture path: the first frame showed 30
seconds, 173 AX nodes and a 1280 x 739 app frame were captured, approval returned
STALE_ELEMENT, and exact settings restoration with disabled automation passed.
The final app binary is task-owned under final-bin/, independent of shared
target-cache cleanup.

After initial ENOSPC, cold-route and stalled-RAF failures, the final retry rebuilt
and launched macOS Tauri with a task-private endpoint and E2E-enabled frontend.
The user explicitly authorized stopping the competing app/frontend; their PIDs
were checked before stopping. A concurrent cache cleanup had removed the reusable
binary, so a fresh native build was necessary. It succeeded. Native setup
reported completion in 739 ms; the first Next route compiled separately. A
controlled native navigation after HTTP 200 recovered initial renderer readiness.
The fresh renderer's native requestAnimationFrame probe responded normally.
The earlier RAF stall was not reproduced; its root cause is not claimed fixed.

Actual macOS agent-debug smoke: **7 passed, 0 failed**, covering settings and
explicit emergency resume, Allow once and re-prompt, Reject, Close, timed grant
session isolation, unanswered timeout, and late approval after emergency stop.
Approval reaches `STALE_ELEMENT` for the deliberately invalid reference; late
approval returns `KILL_SWITCH_ACTIVE`. These probes cannot generate OS input.
Semantic locator stability/hit-test checks remain enabled; no force click,
DOM-click substitute, new permission or generic evaluate relaxation was used.
Settings and emergency state were restored exactly, with automation disabled.
This is actual WKWebView acceptance, separate from Windows WebView2 collection.

App-scoped native acceptance also passed. The final rebuilt binary returned
111 AX nodes and a 1280 x 739 frame on Workflows; zoom preserved its host surface
and revision. Workflows navigation and heading passed, and its app-window frame
was visually inspected. A separate final prompt capture contained 173 AX nodes
and visibly showed the corrected 30-second countdown. Earlier runs also
returned 158 nodes / 1280 x 736 with matching zoom geometry. Earlier debug screenshots that captured occluding windows are
not used as visual acceptance evidence. No controlled OS click/drag/scroll,
multi-monitor action, real OCR provider or Windows/Linux/device/deployed-host
acceptance is inferred from these checks.

Final native artifacts are under
`.cache/ui-automation-audit/tauri-private-2026-10-22T13-15-08-085Z/`:
`native.log`, `native-final.log`, `frontend.log`, `probe.json`, `consent/results.json`,
`consent/console.json`, `consent/network.json`, `consent/native-log.json`,
`consent-final/results.json`, `consent-final/console.json`,
`consent-final/network.json`, `consent-final/native-log.json`,
`app-scope/app-scope-result.json`, `app-scope/workflows-snapshot.json`,
`native-visual.json`, `native-consent-app-frame.png`, `native-countdown.json`,
`native-countdown-red.json`, `native-consent-countdown.png`, and
`capture-crash-frames.json`, `app-scope-final/app-scope-result.json`,
`app-scope-final/app-scoped-workflows.png`, `final-restoration.json`, and
`shutdown.json`. The final first-prompt image was visually inspected and shows
the corrected 30-second countdown. Earlier red/green logs
and exact restoration snapshots remain under `.cache/ui-automation-audit/`.
The earlier consent run recorded no console errors. The final run recorded two
`scheduler_arm_task` errors tagged `Native scheduler smoke next-arm-error`, plus
plugin/reload/scheduler warnings from the shared app. No zero-error or isolated
boot is claimed. Both final scripts restored settings exactly; an independent
read verified disabled automation before shutdown. The tracked native and
frontend PIDs stopped, and persisted settings still equal the original snapshot.
The rebuilt binary repeated all seven lifecycle cases successfully after the
countdown and locator-stack fixes.

Fresh scoped i18n, wiring and test-gap reviews found no new static blocker. They
identified an unverified cold-boot boundary: `data-app-shell` does not prove the
dynamic overlay has completed asynchronous event subscription. First-prompt
delivery under deliberately delayed loading still needs a dedicated regression;
this is not a reproduced explanation for the earlier post-prompt RAF stall.
The ledger remains verifying for these and the remaining platform/global gates.

## Cold-subscription follow-up — 2026-10-22

The remaining first-prompt delivery race is repaired. Tauri now tracks actual
asynchronous listener registration, and the routing transport forwards that
readiness wait. The shared consent hook subscribes first, waits, then reads the
broker's pending snapshot. The native command and narrow ACL entry expose the
same existing broker snapshot already used by the companion route. Reading it
cannot approve a request or create a session grant.

Snapshot deadlines are anchored before the RPC, so transit and duplicate frames
cannot extend consent. Answered ids cannot reappear from an in-flight snapshot.
Switching transport or host hides the old queue and fences its callbacks and
approval closures. Failed snapshot reads leave live events working. The E2E
bridge can rebind only a local desktop transport for native race verification;
it remains behind NEXT_PUBLIC_E2E and refuses an active remote.

Current evidence, refreshed on 2026-10-23:

- The initial cold-subscription regressions failed 5 cases with 23 passing.
  Two later helper-ownership regressions failed before the cancellation fix;
  the new IPC-identity test also failed before the replay fix.
- Final focused Jest: 9 suites /174 tests passed. Rust automation: 612 passed,
  3 existing ignored, 208 filtered. This includes five invocation-history tests.
- The agent-debug native binary compiled successfully. Windows discovery
  collects 9 consent cases; this is collection, not WebView2 execution.
- Scoped ESLint, Prettier, automation Rustfmt, diff checks and E2E governance
  passed. The earlier root lint failure remains in unrelated generated
  public/.p0-native-fixture/bundle.js (15 errors /1391 warnings).
- Typecheck remains explicitly skipped. Coverage was not requested or run.

The real macOS run passed delayed listener recovery, all seven settings/consent
lifecycle cases, cold-document recovery, independent identical calls, and the
adjacent Workflows page. The delayed case established pending=1/dialogs=0 before
release, then displayed the real 30-second overlay; Allow once reached the native
backend's STALE_ELEMENT refusal and cleared pending. The cold case retained the
same single broker UUID across navigation, then produced exactly one matching
STALE_ELEMENT audit row and pending=0. Identical independent calls produced two
UUIDs and required two separate decisions. The SDK invoke descriptor remained
non-writable. The recovered prompt was visually inspected. Workflows semantic checks passed;
the final route screenshot caught a preparation overlay. A stronger Filter-open
visual retry met a document replacement and then a locked Mac. The subsequent
unlocked verification below closes this paint/interaction gap. The earlier
Workflows image remains historical evidence.

A separate actual record_start IPC admission check used an invalid recording
UUID: first and independent invocations reached the original UUID validation,
while the repeated invocation identity was rejected before recorder startup.
This proves header admission, not real OS recording or input capture. The final
native idle-recorder check also established that stop with a malformed identity
reached its original no-recording error, and interrupt succeeded. The 25
recorder-session tests passed after the cleanup correction.

## IPC replay follow-up — 2026-10-23

The first real cold-document attempt exposed a second P1: one pending click
became two native broker requests during navigation. After one approval, the
strict pending=0 assertion failed. The original failure is retained in
pre-replay-fix-cold-consent-reload-final.json and its log. Inspection of the
locked Tauri 2.12.0 SDK found a fetch-response failure path that resends the
same message over postMessage; a local VM probe demonstrated that mechanism.
The lost old-document trace prevents claiming a fully correlated native
callback trace, but the actual duplication and its red/green acceptance are
observed.

TauriTransport now stamps a fresh UUID header on each local automation or
recorder call. SDK channel fallback preserves it. Native driving commands and
recorder start/pause/resume/undo reserve that identity before consent or other
side effects. Independent API calls receive different identities. The existing
permission, policy, kill-switch and approval pipeline still handles every
original invocation. Stop/interrupt, unsubscribe and picker cancellation retain
their original cleanup paths so a full history cannot block cleanup.

The new invocation.rs module owns IPC lifetime admission rather than consent
or session grants. Keeping it below the desktop shell avoids coupling native
automation to the companion SQLite/security ledger. Active identities never
expire; completed identities remain for 24 hours. The 65,536-entry limit refuses
new guarded invocations instead of evicting active work. Older callers without
the header retain their existing behavior and are outside this replay guarantee.
No SDK code, readonly globals or permission grants were changed.

The local .app wrapper initially selected a different WebKit profile and hit
an account-binding mismatch. Its test metadata was corrected to reuse the
original unbundled verification profile; account records, credentials and
binding validation were not changed. Earlier lock-screen, SDK-mutation and
standalone-fixture attempts remain failed harness evidence. The transient
public fixture was removed. Owned old binary copies were deduplicated or kept
in verified, recoverable gzip archives to provide build headroom.

The final run independently compared all settings and emergency state with the
pre-test snapshot, checked persisted settings, pending=0, automation disabled
and original always-on-top state before stopping the owned run. That run's
Workflows diagnostic sample has zero console errors, one plugin compatibility
warning and six failed device-auth challenge fetches; its network buffer dropped
300 older entries. This is not a zero-error or full-network boot claim.

Tracked artifacts:
.cache/ui-automation-audit/tauri-cold-consent-2026-10-22T15-07-28.177641+00-00/.
Key files are continuous-final.json, cold-consent-reload-final.json,
independent-identical-final.json, recorder-replay-admission-final.json,
final-off-restoration.json and shutdown-final.json. The private endpoint is
stored separately; no token appears here. V14/X9 record macOS cold-subscription
acceptance. Windows/Linux, controlled OS gestures and provider/device acceptance
remain separate obligations. The wrapper's fresh AX probe was refused by the
existing macOS Accessibility policy; that permission was not broadened, and the
earlier unbundled AX/capture evidence is not relabeled as this revision's pass.

## Workflows interaction and visual follow-up — 2026-10-23

After the user unlocked the Mac, a fresh task-owned macOS Tauri process
(PID 4102, frontend PID 3873) completed the remaining adjacent-surface check
through agent-debug API v3. The script waited for a ready, visible renderer,
navigated to Workflows, and clicked the accessible Filter button with the
normal stability and hit-target checks. The menu appeared with its radio and
checkbox entries; Escape dismissed it. No filter selection or workflow data
was changed. Input uses the bridge's synthetic DOM events, not trusted OS input.

Both native window screenshots were visually inspected after two animation
frames: the first shows the open Filter menu over the fully painted library,
and the second shows the menu closed. Workflows, its toolbar and existing card
are visible without the earlier preparation overlay or an observed layout
defect. This closes the final painted Workflows gap; it does not establish
workflow execution, native OS gestures, or other-platform acceptance.

The script compared the complete settings and emergency state with the original
snapshot, checked the persisted settings file, and confirmed automation disabled,
pending=0 and always-on-top=false. A separate shutdown check repeated those
assertions and stopped the owned native process and all six owned frontend
processes. PID liveness checks confirmed both recorded roots had exited. No
permission, evaluate restriction or readonly SDK global was changed. Typecheck
and coverage were not run.

The current document's console sample contains zero errors, one plugin
compatibility warning and no console-buffer drops. The retained network sample
contains six device-auth challenge fetch failures and reports 638 dropped older
entries, so it is not complete boot-network evidence. The native log reader
also includes historical shared logs; the dedicated painted-native launch log
is retained separately and is the current-process startup evidence.

Artifacts under the same private directory are workflows-painted-final.json,
workflows-filter-open-painted.png, workflows-filter-closed-painted.png,
workflows-painted-console.json, workflows-painted-network.json and
workflows-painted-native.json. final-off-restoration.json and shutdown-final.json
record this run's verified disabled state and shutdown. Their earlier versions
are preserved with the pre-painted- prefix. Ledger V16 records this acceptance.

## Workflow retry and execution follow-up — 2026-10-23

Actual workflow execution exposed a remaining retry defect: a deliberately
missing revision produced STALE_ELEMENT, but the workflow engine issued the
same query three times under its default retry policy. The performAction
executor also inherited automatic retries. A new API invocation has its own
transport identity, so the transport replay guard does not replace workflow
retry policy. No duplicate OS input is claimed from the read-only reproduction.

The existing executor retryable metadata now disables automatic retries for
queryElements, expandElement and performAction. The first two depend on an
existing revision/continuation; the last can have delivered an action before
its reply was lost. A new observation or deliberate run can issue another
request. Permission, consent, paired-client and evaluate rules are unchanged.

The new co-located desktop.integration.test.ts uses the real runStep, registry,
event log and cache. It needs jsdom/IndexedDB, unlike the existing node-only
desktop.test.ts client-contract suite, so it is a separate integration file.
All three cases configure both global and per-node retries, reject the first
native call and allow a hypothetical second call. Before the fix they resolve
after retrying; afterward they reject after exactly one call, never cache the
failure and emit no step_retrying. Together with the E2E-helper regressions,
the red run had 5 failures/20 passes. Final focused Jest: 4 suites/87 passed.

A new Tauri workflow-execution.spec.ts covers Run-to-native-to-history rather
than duplicating the browser editor-persistence spec. It drives a manual
trigger and canonical queryElements node, verifies exactly one persisted failed
run and step attempt, and checks the error and absence of retry events. Its
three contracts are master disabled, an inherited Off policy, and a missing
revision. PerCall reads intentionally do not prompt; surface Off intentionally
inherits defaultTier, so the Off case sets both values to Off. No production
policy was changed to fit an incorrect test assumption.

Native fixtures share the unlocked account database. The existing build-time
E2E bridge now exposes deleteWorkflow for scoped fixture teardown, using the
production deletion/cascade path. Tests verify the E2E gate, wiring, unmount
cleanup and deletion of the requested workflow/history while preserving a
second workflow and its run history. No whole-account reset is used.

The final macOS agent-debug API v3 run (native PID24226, frontend PID11969)
completed all three cases. Each has exactly one query_elements native audit,
one n_query step_started, a step_failed and the expected PERMISSION_DENIED or
STALE_ELEMENT result, with no step_retrying. The native editor screenshot was
visually inspected: the manual trigger succeeded, the query node failed, and
the STALE_ELEMENT toast is visible without a preparation overlay. The three
final workflows/history were removed; a read-only check across account and
legacy databases found none of the 11 recorded test workflow IDs remaining.
A separate shutdown check verified
the complete original settings/emergency/persisted state, disabled automation,
pending=0 and always-on-top=false, then stopped the owned native and all seven
owned frontend processes. Typecheck and coverage were skipped.

Earlier attempts are retained as failed harness evidence: seeding before the
unlocked shell wrote one fixture into the legacy database, an incorrect consent
expectation targeted a read-only call, and full-document navigation later
stalled at account registry preparation. The early fixture was removed by its
exact identity; all remaining test records were cleaned through the scoped
helper. Restarting only the owned native process restored readiness; the final
flow used actual library/editor links. The account-preparation root cause is
unresolved and remains ledger X13, separate from this retry repair.

Scoped test-gap, wiring and i18n reviews found no blocker. The final document's
console sample has zero errors and two warnings; retained network has three
device-auth challenge failures and 752 dropped entries, so this is not a
complete clean-boot claim. Three Windows native cases collect; Windows
execution, real driving input and broader platform acceptance remain open.

Evidence is retained in workflow-native-retry-red.log,
workflow-native-retry-final.log and the private native directory's
workflow-execution-final.json, workflow-execution-stale-painted.png,
workflow-execution-all-fixture-check.json and shutdown-final.json. The prior
painted-library shutdown evidence is preserved with the workflows-painted-
prefix. Ledger V17 records the current acceptance.

## Account cold-reload follow-up — 2026-10-23

The existing registry watchdog passed its233-test baseline, but a healthy
macOS cold navigation still stayed on account preparation for44s. Temporary
phase diagnostics pinpointed the wait: layout validation and database open had
finished, then storageLayout marker put did not settle. The visible registry
wording was not the actual awaited operation. No credentials, account data or
bindings were reset; diagnostics were removed.

Two layout-probe experiments were rejected. Metadata-only preliminary passes
were followed by the same marker-write stall on healthy native PID70918.
Both storage-layout.ts and its tests are restored exactly to HEAD. Those
experimental red/green logs are not evidence for the shipped repair.

The final change is document lifetime cleanup in CogniaDB. Its regular Dexie
readonly transactions are tracked until completion, including transactions
owned by handles that have already closed. Capture pagehide cancels abandoned
readers before closing connections with lazy reopen allowed. This releases a
snapshot that cannot finish its asynchronous decryption after its document is
frozen. Visibility changes do not cancel work. Readwrite transactions and the
existing Canvas/Artifacts/lease exit-save handlers retain their commit path.

Independent wiring review identified the blanket-abort write risk, so that
candidate was narrowed. Six actual fake-indexeddb lifecycle cases cover normal
and BFCache exits, live/retired readers, committed data and lazy reopen, plus
pending readwrite and later bubble exit saves. Final account/registry/gate/
database checks passed8 suites/437 tests. Root lint, formatting and the earlier
E2E governance check passed. Typecheck and coverage were not run. The headless
roster explicitly identifies this document-owned browser/mobile lifetime;
there is no headless document listener or new permission/evaluate allowance.

The native account-reload spec performs three full document reloads, checks
Workflows Filter open/Escape close, compares full automation policy and verifies
that the original account/database and persisted session IDs survive. It
collects1 Windows CDP case; Windows execution is unverified.

Final-source macOS acceptance passed on the unlocked desktop: pinned native
PID85413 with frontend PID69353 completed three full document navigations/
reloads. Shell settlement after DOM content loaded was1700/1431/1288ms. Every
round opened Filter and closed it with Escape, preserved the original account
and database and retained the same27 session IDs. The final source hashes
match the tested files; the existing task debug binary served the current
TypeScript frontend, with no Rust change in this repair.

Native screenshots of Filter open and closed were visually inspected: complete
Workflows library, the expected menu and no account-preparation overlay. The
independent final check verified full policy/emergency state equal to the
original, automation disabled, pending0, persisted settings equal and
always-on-top=false. The native process and all7 owned frontend processes
exited. A post-exit settings read still matched the original disabled policy.
V18 passed, X13 closed and M3 met.

Evidence remains bounded: the final-document console sample has0 errors and2
warnings (reload callback and plugin compatibility), while retained network
has5 device-auth challenge failures and323 dropped entries. Shared Next stdout
later reports32 unhandled raw IndexedDB logging-spool transaction rejections;
the native images also show2 development Issues. That separate spool does not
use CogniaDB or its readonly tracker, and stdout does not retain per-process
attribution. Ledger X14 keeps that investigation open; this is not an entirely
error-free shared-runtime claim. Windows execution, trusted OS input, universal
write drain and direct-native/upgrade transaction guarantees remain unclaimed.

Evidence under .cache/ui-automation-audit/: account-reload-pagehide-red.log,
account-reload-readonly-lifetime.log, account-reload-final-tests.log,
account-reload-root-lint.log and account-reload-e2e-collect.log. The private
native directory retains separate failure/trial artifacts,
account-reload-final-source.json, account-cold-reload-readonly-final-current.json,
account-reload-filter-open-final.png, account-reload-filter-closed-final.png,
account-reload-verification-final.json and account-reload-shutdown-final.json.

## Original audit baseline — before repairs

The sections below preserve the original findings and reproduction results.
Present-tense defect descriptions in this baseline are superseded by the repair
matrix above. Failed historical commands are retained as evidence of the defects,
not as the latest verification result.

### Scope and evidence limits

- Product: native Computer Use, browser tools, workflow nodes, external MCP, remote desktop targets and recording.
- Verification infrastructure: Playwright, the cross-platform Tauri agent-debug bridge, focused unit tests and E2E governance.
- Host: macOS Apple Silicon; current `node`, `pnpm node` and `pnpm exec node` resolve to Node 26.12.1; pnpm is 11.25.0. The earlier Node 24.19.0 warning came from the pnpm launcher runtime and was insufficient evidence of the test subprocess runtime. Adversarial review reproduced the debug failure and reran all 16 focused Jest suites directly under Node 26.12.1.
- Source claims below describe implementation, not live OS acceptance. No user desktop input, permission changes, real model turn, remote deployment or phone operation was performed.
- CodeGraph has no index in this checkout; inspection used current source and `rg`.

## Product support matrix

| Surface                     | Implemented support                                                                                                                                                             | Current boundary                                                                                                                                                                                                                                                                                                                 | Owning source                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Computer Use tools          | `list_apps`, `get_app_state`, `query_elements`, `expand_element`, `perform_action`, `zoom`, `wait`, `find_text`, `click_text`; plugin MCP bridge and GUI subagents              | Plugin activation registers the whole tool family; availability reporting uses coarse tree/input/screenshot flags                                                                                                                                                                                                                | `plugins/computer-use/src/index.ts`, `lib/plugin/api/automation-api.ts`                                                                |
| macOS native                | Running-app discovery, bundle/path/name resolution, app-specific AX tree and ScreenCaptureKit capture, element actions, events, input and coordinate hit-test                   | `window_op` is unsupported; drag options are ignored; element-target scrolling does not resolve the element                                                                                                                                                                                                                      | `crates/cognia-automation/src/automation/platform/ax/mod.rs`                                                                           |
| Windows native              | UIA tree/patterns/events, screenshot, keyboard/mouse and window actions                                                                                                         | App-session methods inherit foreground-only defaults; app list is only the focused app; capture is a monitor; default application tree reaches the global UIA root                                                                                                                                                               | `platform/uia/mod.rs`, `automation/backend.rs` in `cognia-automation`                                                                  |
| Linux native                | Screenshot and coordinate input, key chords, focused-window metadata through `xdotool`                                                                                          | No AT-SPI tree, semantic patterns, events or window operations; pure Wayland without X tools advertises no input/capture; canonical state collection fails at `read_tree`                                                                                                                                                        | `crates/cognia-automation/src/automation/platform/atspi/mod.rs`, `automation/worker.rs`                                                |
| Remote desktop Computer Use | Remote desktop represented as one app, capture/state/zoom, revision-bound pixel actions, optional tree                                                                          | Semantic strategy and element targets are explicitly refused; click/drag/scroll/key/text are the supported input subset                                                                                                                                                                                                          | `crates/cognia-automation/src/cua_sandbox/desktop_session.rs`                                                                          |
| Browser automation          | Embedded preview, managed local Chromium, explicit user-Chrome attachment, cloud Chromium and paired browser-extension engine; snapshots, refs, actions and tab/session routing | Features vary by engine; local install, explicit attachment, pairing or reachable server is required                                                                                                                                                                                                                             | `lib/browser/agent-engine.ts`, `backend-availability.ts`, `extension-engine.ts`, `plugins/browser-tools/src/index.ts`                  |
| Embedded browser ceiling    | DOM snapshots/actions, navigation, waits and viewport capture                                                                                                                   | No new tabs, native dialogs, drag, file upload, scoped screenshots, PDF, emulation, cookie listing, response details or extension runtime                                                                                                                                                                                        | `EMBEDDED_UNSUPPORTED_FEATURES` in `lib/browser/agent-engine.ts`                                                                       |
| Workflows and external MCP  | Five canonical desktop action nodes plus desktop-event trigger; external `computer_use` adapter forwards the same session contract                                              | Execution inherits target backend limits; current workflow E2E proves editor persistence only                                                                                                                                                                                                                                    | `lib/workflow/nodes/automation/desktop.ts`, `lib/external-bridge/handlers/computer-use.ts`                                             |
| Web and Capacitor           | Remote browser execution and host-run supervision/approval/halt; mobile Computer Use opt-in constrains mobile-originated turns                                                  | Paired clients cannot directly call canonical native `desktop_get_app_state` or `desktop_perform_action`: both are client/internal-only and CompanionTransport returns `command_transport_forbidden`. Pairing and the mobile switch do not widen that intentional ceiling. Remote CUA targets are a distinct host execution path | `protocol/companion-commands.json:7723`, `:7893`, `lib/tauri/transport-companion.ts:982`, `crates/cognia-companion-rpc/src/rpc.rs:758` |
| Recording                   | Browser recording/replay implementations; native skill recorder with admission, review and disabled generated skills                                                            | Local/cloud recording controls use restricted generic evaluate: public starts fail and drain/stop fail after human key input (F10). Replay has engine mismatch and navigation false-success defects (F1/F12). Native recording supports macOS/Windows, not Linux; generation is not replay acceptance                            | `lib/browser/recording/`, `lib/skills/recording/`, `automation/record/commands.rs`                                                     |

The native `desktop_*` execution paths use permission, consent, policy, audit and kill-switch machinery through `automation/dispatcher.rs`. Chat also has character, IM and mobile gates. A separate manual-capture API, `ctx.automation.captureDisplay` (`lib/plugin/api/automation-api.ts:186`), uses `getDisplayMedia` (`lib/ui/screenshot.ts:21`) under manifest permission and an explicit browser picker. It does not enter the Rust dispatcher; `plugins/screenshot/src/index.ts:135` treats the picker as the user consent gesture. This is a distinct enforcement boundary, not evidence of an unauthorized native policy bypass. Neither structural claim proves every real consent or cancellation path works.

## Automation used to test the UI

| Harness                             | Available capability                                                                                                                                        | Limit or evidence gap                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Playwright browser/static export    | Chromium UI flows, mobile viewport projects, opt-in iOS/cross-browser projects                                                                              | Viewport emulation does not prove Capacitor native permissions, device behavior or OS input                                   |
| Tauri Playwright                    | Windows WebView2 CDP and real IPC/sidecar boundary                                                                                                          | Windows only; CI job runs on schedule/manual dispatch with Rust impact, not every PR                                          |
| Tauri agent-debug API v3/revision 4 | Cross-platform system-webview automation, semantic locators, auto-wait, multiple windows, renderer recovery, console/network/native logs, native screenshot | Synthetic DOM input (`trustedEvents: false`), fetch-only mocking, no CDP/video, open shadow roots and same-origin frames only |
| Current local Tauri session         | Read-only status command available                                                                                                                          | `ok: false`, `status: tracked_process_exited`; no live Tauri UI was inspected in this audit                                   |

The bridge is implemented in `src-tauri/src/agent_debug.rs`, `src-tauri/src/agent_debug/injected.js` and `scripts/tauri/agent-debug-client.mjs`. It must not be confused with the product's native computer-use backend or the Windows CDP harness. Its test command and E2E governance are default blocking registry entries (`scripts/gates/check-all.mjs:238,303,434,497-509`), invoked by the Quality workflow at `.github/workflows/quality.yml:318`.

## Prioritized findings

| ID / priority | Kind                                                     | Evidence and impact                                                                                                                                                                                                                                                                                                                                                                                                       | Smallest next action / acceptance contract                                                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 / P1       | Confirmed product wiring defect                          | `lib/browser/recording/replayer.ts:53` resolves target-bearing steps through `browserClient.embedRefFor`, although EngineRecorder supplies local/cloud engines. Production-source probes observe one embedded resolver call, zero selected-engine snapshot/action calls, and failed replay. Existing tests mock the embedded resolver                                                                                     | Resolve targets through the selected engine. Acceptance must also include recording-control restrictions (F10), typed input, navigation failure (F12), and a no-embedded-transport case; click/fill replay alone is insufficient                            |
| F2 / P1       | Reproduced blocking regression failure                   | `pnpm tauri:debug:agent:test`: 73 Node tests pass, injected Jest fails with read-only `isStable`; the cancellation case also fails directly under Node 26.12.1. `automation-core.injected.js:241` freezes methods spied on at `scripts/tauri/agent-debug.injected.test.ts:624` and elsewhere. It is a default blocking registry item                                                                                      | Repair the test seam without unfreezing production helpers or weakening cancellation/deadline assertions. Require the full command to exit 0. This does not prove production cancellation is broken                                                         |
| F3 / P1       | Stale native E2E schema                                  | `tests/e2e/tauri/automation/settings-toggle.spec.ts:20` models `globalEnabled`/`surfaces`; TS/Rust use `enabled`/`perSurface`. If execution reaches the assertion, it reads a missing field. F13 identifies a possible earlier renderer import failure, so this audit does not claim the actual first native failure                                                                                                      | Use the canonical type and a bundled E2E bridge, restore in finally, verify explicit enable/disable/kill-switch behavior and execute on Windows. Static mismatch confirmed; no live Tauri reproduction                                                      |
| F4 / P1       | Windows app-session scope gap                            | UIA has no app-session overrides. `backend.rs:35` checks that the app is focused, then calls `read_tree(None)`; `uia/mod.rs:103` resolves that to `get_root_element()`, the desktop tree. Discovery and screenshots also use foreground/monitor fallbacks. `worker.rs` passes the roots to the session without app-PID filtering.                                                                                         | Implement app enumeration, process/window-scoped roots and per-window capture. Add a two-app fixture proving that app A's state contains no nodes from app B, plus mixed-DPI coordinate checks. Static call-path evidence; no Windows runtime reproduction. |
| F5 / P1       | Broken Allow-once selector and missing action acceptance | The Allow-once spec uses the first button (`consent-overlay.spec.ts:51`), but the first DOM button is Close and sends `allow:false` (`components/automation/consent-overlay.tsx:90-98`); Allow once is at line 148. Both consent specs only dismiss a synthetic request without a pending broker. The five workflow E2E tests only prove editor persistence                                                               | Select by accessible name and assert the allow value plus real broker/action result. Add controlled state/action/readback and allow/deny/timeout/grant-expiry/kill-switch tests; keep pure cases in Rust/Jest                                               |
| F6 / P2       | Capability and platform completeness                     | Linux canonical app-state capture always reaches unsupported `read_tree`; macOS/Windows flags cannot express app discovery, background capture, window ops or per-action semantic support. `/cu` can report Windows as ready despite the app-session restrictions. All Computer Use tools are registered regardless of these flags.                                                                                       | Advertise operation-level capability/refusal reasons; gate unavailable operations before offering them. Decide whether Linux gets a pixel-only session path or a real AT-SPI implementation.                                                                |
| F7 / P2       | Native action parity limits                              | macOS `window_op` refuses. macOS/Linux `drag` ignores `DragOpts`, and `scroll` only handles point targets, leaving element targets to scroll at the current cursor. OCR tools capture the primary monitor and click through the legacy point path without app-session revision binding.                                                                                                                                   | Reject unsupported option/target combinations explicitly or implement them. Add controlled multi-window/multi-monitor checks and an app-bound OCR target contract. OCR remains gated, but it does not inherit the canonical session's freshness guarantee.  |
| F8 / P2       | E2E governance failure                                   | The gate reports 10 violations: six workflow stub exceptions overdue since 2026-09-30 and four arbitrary waits in wallpaper tests/helpers.                                                                                                                                                                                                                                                                                | Replace or re-review the six stub contracts and use observable waits for wallpaper flows. Do not refresh exception dates or widen retries merely to obtain green output.                                                                                    |
| F9 / P2       | Real-environment evidence gap                            | No live macOS Tauri session, Windows/Linux target, real phone, attached personal Chrome, paired extension execution or deployed remote desktop was exercised. The real Chromium check only covers the workspace-runtime service in local/cloud modes on this machine.                                                                                                                                                     | Run a narrow acceptance matrix per supported shell/backend. Keep service-local success separate from deployed remote-host and product-UI acceptance.                                                                                                        |
| F10 / P1      | Confirmed recording-control policy conflict              | `engine-recording-driver.ts:6,18-22` sends start/resume/stop/drain through generic evaluate. `browser-service.mjs:1521-1530` rejects public origins and sessions after human key input; `dispatchInput:2191` sets that session flag. `recorder.ts:94-98,154-160` swallows permanent drain/stop failures and can return an incomplete flow. Actual-method probe reproduces public start refusal and post-key drain refusal | Add a narrow recording-control protocol that preserves evaluate restrictions, plus visible permanent errors. Test public start and localhost start → human typing → drain/stop with complete captured steps. Do not relax credential/evaluate guards        |
| F11 / P2      | Native click options silently ignored                    | Windows `platform/uia/mod.rs:142-187` never reads `opts.button` and its point helper is left-click only. macOS element click at `platform/ax/mod.rs:333-342` does one AXPress regardless of button/count. Canonical worker forwards those options (`worker.rs:1056`)                                                                                                                                                      | Implement or explicitly refuse right/middle/multi-click combinations. Verify context-menu and double-click outcomes in controlled Windows/macOS fixtures. Static evidence only                                                                              |
| F12 / P2      | Confirmed navigation false success                       | `replayer.ts:89-92` ignores waitForLoad returning `{ok:false,timedOut:true}`; replay marks the step successful at lines 183-186. Actual-source navigate-only probe returns `ok:true` despite a timed-out wait                                                                                                                                                                                                             | Fail required navigation when arrival/readiness fails, and distinguish it from optional settle waits after non-navigation actions. Add a missing-destination contract; fixing F1 alone does not address this                                                |
| F13 / P1      | Native E2E renderer loading gap                          | Settings and consent evaluate callbacks import bare specifiers (`@/lib/automation/client` and `@tauri-apps/api/event`) at spec lines 26/36 and 33. Playwright actual babelTransform preserves them; Tauri fixtures provide CDP attachment, not module resolution for those names                                                                                                                                          | Expose a narrowly bundled test bridge and use it from serialized callbacks. Then execute the native specs. Transform preservation is reproduced; the first live renderer error remains a static inference, not a Tauri reproduction                         |

## Adversarial reconciliation

Three fresh-context read-only reviewers examined browser/recording, native/transport and test-evidence boundaries. Every substantive finding was checked against current owning source; the browser probe uses production methods with external side effects replaced by test doubles. No product repair is claimed.

| Review item                                   | Classification                              | Report action                                                                              |
| --------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Recording controls blocked before replay      | Valid + actionable omission                 | Added F10; narrowed recording support and expanded F1 acceptance                           |
| Navigation timeout reported as replay success | Valid + actionable omission                 | Added F12                                                                                  |
| Native click options ignored                  | Valid + actionable omission                 | Added F11; static evidence explicitly scoped                                               |
| Paired-client native transport ceiling        | Contract misread in original support matrix | Corrected Web/Capacitor row; preserve the intentional restriction                          |
| Manual captureDisplay outside dispatcher      | Valid boundary clarification                | Scoped dispatcher wording; not classified as a proven security bypass                      |
| Renderer bare dynamic imports                 | Valid + actionable harness omission         | Added F13; removed certainty about the first failing assertion in F3                       |
| Allow-once selector actually rejects          | Valid + actionable harness omission         | Strengthened F5 with exact button/allow mismatch                                           |
| pnpm warning treated as test runtime          | Invalid environment inference               | Corrected runtime note; Node 26 reproduction and 390-test rerun added                      |
| Reproduction depended on ignored cache script | Valid reproducibility limitation            | Preserved combined source-probe code in the appendix and exact focused-suite command below |

Cross-model review was offered per doubt-driven; no external CLI was invoked without explicit selection and invocation confirmation. No external cross-model invocation was authorized or run. A second bounded review found no remaining substantive browser/QA issues; its native review corrected the mobile-origin wording against build-options.ts:3650. That mechanical correction was applied without broadening the audit.

## Checks actually run

| Check                                                                                                                                                                                                                  | Exit / result                                                                                            | What it proves                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused `pnpm test -- --runInBand --runTestsByPath` over 13 automation/plugin/browser suites                                                                                                                           | 0; 13 suites, 302 tests passed                                                                           | Existing schema, routing, plugin, IM-gate, OCR, MCP and browser contracts under mocks                                                                          |
| Focused replay/workflow/skill-controller Jest suites                                                                                                                                                                   | 0; 3 suites, 88 tests passed                                                                             | Replay's current contract, workflow executor forwarding and recording controller behavior under mocks                                                          |
| `pnpm --filter @cognia/workspace-runtime test`                                                                                                                                                                         | 0; 180 passed, 1 skipped, 181 total                                                                      | Service contracts; real overlay test initially skipped because expected Playwright Chromium was absent                                                         |
| `COGNIA_TEST_CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test --test-name-pattern='real overlay snapshots' services/workspace-runtime/src/browser-service.test.mjs` | 0; local/cloud subtests plus parent: 3 passed, 0 skipped                                                 | Real headless browser snapshot, native element actions, frame/shadow targets and stale-ref behavior in temporary profiles; no personal Chrome profile attached |
| `pnpm tauri:debug:agent:test`                                                                                                                                                                                          | 1; Node: 73 passed; injected Jest suite failed                                                           | Client/CLI contracts pass; injected helper regression command remains broken (F2)                                                                              |
| Injected Jest suite filtered to its first snapshot test                                                                                                                                                                | 0; 1 passed, 32 filtered out                                                                             | Basic helper test works; this is not a full-suite pass                                                                                                         |
| Injected Jest suite filtered to cancellation during stability check                                                                                                                                                    | 1; same read-only `isStable` failure                                                                     | F2 is independently reproducible in isolation                                                                                                                  |
| `node .cache/ui-automation-audit/replay-engine-probe.cjs`                                                                                                                                                              | 0; `reproduced: true`, embedded resolver 1, selected-engine snapshot/action 0                            | F1 failure in the actual transpiled replayer with an injected remote engine; deterministic probe, not a real remote session                                    |
| `pnpm exec playwright test --list --project=chromium tests/e2e/workflows/nodes/action-desktop/canonical.spec.ts`                                                                                                       | 0; 5 tests / 1 file                                                                                      | Discovery only                                                                                                                                                 |
| `PLAYWRIGHT_TAURI=1 pnpm exec playwright test --list --project=tauri tests/e2e/tauri/automation`                                                                                                                       | 0; 3 tests / 2 files                                                                                     | Discovery only; no native execution                                                                                                                            |
| `pnpm audit:e2e-governance`                                                                                                                                                                                            | 1; 10 violations                                                                                         | Existing governance debt is currently failing (F8)                                                                                                             |
| `pnpm tauri:debug:agent:status`                                                                                                                                                                                        | Process exit 0, payload `ok: false`, `tracked_process_exited`                                            | No usable tracked local shell at inspection time                                                                                                               |
| Direct Node26 focused Jest rerun (exact command in appendix)                                                                                                                                                           | 0; 16 suites, 390 tests passed                                                                           | Re-establishes selected contract results under Node26.12.1; does not include the failing injected suite                                                        |
| Direct Node26 isolated cancellation Jest test; independent full debug rerun                                                                                                                                            | 1; same read-only isStable error; full debug Node73 passed, injected Jest1 failed suite/0 tests reported | Failure is reproducible on the supported Node runtime                                                                                                          |
| Playwright actual babelTransform probe on evaluate callbacks                                                                                                                                                           | 0; both bare dynamic import specifiers retained                                                          | Serialized source preserves the unresolved specifiers; no live Tauri module-resolution run                                                                     |
| node .cache/ui-automation-audit/adversarial-probes.cjs (code in appendix)                                                                                                                                              | 0; three defect probes reproduced on Node26.12.1                                                         | Recording-control refusal, selected-engine mismatch and navigation false success; controlled doubles at external boundaries                                    |

Full lint/typecheck/build, coverage, Rust tests and product E2E execution were not run for this documentation-only audit; those results are not claimed. Prioritize recording controls/replay (F10/F1/F12) and native app scope/click semantics (F4/F11), while repairing the blocking debug/governance checks (F2/F8). Make the native consent/settings harness executable (F13/F3/F5) before using it as acceptance evidence. Intentional client transport and evaluate restrictions should remain in place.

## Reproduction appendix

The combined deterministic source probe below uses actual transpiled replay/recording driver code and actual RemoteChromiumService methods. It substitutes the embedded transport and page/CDP boundary; it launches no app/browser, performs no OS input and reads no user profile. Save it to `.cache/ui-automation-audit/adversarial-probes.cjs` and run `node .cache/ui-automation-audit/adversarial-probes.cjs` from the repository root. Exit 0 means the three reported defects were reproduced, not repaired.

```js
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { pathToFileURL } = require("node:url")
const ts = require("typescript")

function load(file, dependencies = {}) {
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(
    code,
    {
      module,
      exports: module.exports,
      URL,
      require: (id) => {
        assert(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`)
        return dependencies[id]
      },
    },
    { filename: file }
  )
  return module.exports
}

async function main() {
  let embeddedCalls = 0
  let engineCalls = 0
  const protocol = load("lib/browser/recording/protocol.ts")
  const { replayFlow } = load("lib/browser/recording/replayer.ts", {
    "@/lib/browser/recording/protocol": protocol,
    "@/lib/browser/client": {
      browserClient: {
        embedRefFor: async () => {
          embeddedCalls++
          throw new Error("Embedded transport unavailable")
        },
      },
    },
  })
  const base = {
    id: "audit",
    name: "audit",
    baseUrl: "https://example.com",
    createdAt: 0,
    updatedAt: 0,
  }
  const engine = {
    snapshot: async () => {
      engineCalls++
      return { nodes: [] }
    },
    act: async () => {
      engineCalls++
      return { ok: true }
    },
    navigate: async () => {},
    waitForLoad: async () => ({ ok: false, timedOut: true }),
  }
  const replay = await replayFlow(
    { ...base, steps: [{ act: "click", at: 1, target: { selector: "#save" } }] },
    engine
  )
  assert.equal(replay.ok, false)
  assert.equal(embeddedCalls, 1)
  assert.equal(engineCalls, 0)
  const navigation = await replayFlow(
    { ...base, steps: [{ act: "navigate", at: 1, url: "/never-arrived" }] },
    engine
  )
  assert.equal(navigation.ok, true)
  assert.equal(navigation.steps[0].ok, true)

  const { RemoteChromiumService } = await import(
    pathToFileURL(path.resolve("services/workspace-runtime/src/browser-service.mjs"))
  )
  const { createEngineRecordingDriver } = load("lib/browser/recording/engine-recording-driver.ts")
  const session = { humanKeyboardInputOccurred: false }
  let pageUrl = "https://example.com"
  let pageEvalCalls = 0
  let keyDispatches = 0
  const service = {
    requireSession: () => session,
    activeRecord: () => ({
      record: { generation: 1 },
      page: {
        url: () => pageUrl,
        evaluate: async () => {
          pageEvalCalls++
          return true
        },
      },
    }),
    runActionWithDialog: async (_session, _generation, run) => run(),
    assertNoPendingDialog: () => {},
    emulationSession: async () => ({
      send: async () => {
        keyDispatches++
      },
    }),
  }
  const driver = createEngineRecordingDriver({
    evaluate: (expression) =>
      RemoteChromiumService.prototype.evaluate.call(service, "audit", expression),
  })
  await assert.rejects(driver.start(), /browser_evaluate is disabled on public origins/)
  assert.equal(pageEvalCalls, 0)
  pageUrl = "http://localhost:3000"
  await driver.start()
  assert.equal(pageEvalCalls, 1)
  await RemoteChromiumService.prototype.dispatchInput.call(service, "audit", {
    kind: "key",
    payload: { type: "keyDown", key: "a" },
  })
  await assert.rejects(driver.drain(), { code: "browser_human_input_required" })
  assert.equal(pageEvalCalls, 1)
  process.stdout.write(
    JSON.stringify(
      {
        node: process.version,
        reproduced: {
          selectedEngineReplay: true,
          navigationFalseSuccess: true,
          recordingControlPolicyConflict: true,
        },
        embeddedCalls,
        engineCalls,
        pageEvalCalls,
        keyDispatches,
      },
      null,
      2
    ) + "\n"
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
```

The focused suite rerun used the repository Jest entry point directly under the resolved Node 26 executable:

```bash
node scripts/test/jest.mjs -- --runInBand --runTestsByPath \
  lib/automation/client.test.ts lib/automation/action-schemas.test.ts \
  lib/automation/ocr-click.test.ts lib/plugin/api/automation-api.test.ts \
  plugins/computer-use/src/index.test.ts lib/claude/computer-use-tools.g6.test.ts \
  lib/external-bridge/handlers/computer-use.test.ts lib/browser/agent-engine.test.ts \
  lib/browser/backend-availability.test.ts lib/browser/extension-engine.test.ts \
  lib/browser/local-chromium-engine.test.ts lib/browser/remote-chromium-engine.test.ts \
  plugins/browser-tools/src/index.test.ts lib/browser/recording/replayer.test.ts \
  lib/workflow/nodes/automation/desktop.test.ts lib/skills/recording/controller.test.ts

```
