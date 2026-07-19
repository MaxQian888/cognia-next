# E2E module coverage ledger

Date: 2026-07-19  
Status: active  
Baseline: 257 collectible Chromium/Pixel 7 tests in 158 files after adding mobile notification preference persistence

This ledger continues the suite revival recorded in
`docs/plans/2026-07-16-e2e-suite-revival.md`. It is intentionally contract-based:
spec names and route visits are supporting evidence, not proof by themselves.

Legend: ✅ contract covered · ⚠️ partial · ❌ no owning E2E · 🧱 blocked · 🔍 detailed audit queued

| Priority | Module / route family                                                  | Current evidence                                                                                                                                                                    | State | Next contract or decision                                                                                                                                |
| -------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Chat `/`                                                               | Native streamed reply/multi-turn/interrupt/error specs exist under `tests/e2e/tauri/chat/`; mobile standalone acceptance is `fixme` in `tests/e2e/mobile/standalone-chat.spec.ts`   | 🧱    | Wire the standalone composer to `runStandaloneTurn`, then enable send → streamed mock reply → reload persistence in a default project                    |
| P0       | Backup `/me/backup`                                                    | `tests/e2e/mobile/backup.spec.ts` drives seed → encrypted export → wipe → import → restored row                                                                                     | ✅    | Add corrupt-envelope and wrong-passphrase recovery only if the lower layer cannot fully own them                                                         |
| P1       | Public share `/share/view`                                             | `tests/e2e/share/public-share-view.spec.ts` drives opaque fetch → fragment-key decrypt → render, passphrase retry, and 404 lifecycle state                                          | ✅    | Add one sandbox-security contract for shared HTML when the owning component changes                                                                      |
| P1       | Connectors / inbox                                                     | Browser degradation, native Telegram, all mobile commands, draft approve/reject → RPC + retry, and operator dead-letter inspect/replay → queue/audit persistence are covered        | ⚠️    | Inventory adapters by shared contract and classify which need native protocol coverage beyond the shared queue/recovery contracts                        |
| P1       | Credentials / subscription / keyring                                   | Native suites cover provider-specific add flows, invalid OAuth state, active switching, active-account removal + pointer clearing, and preset CRUD through the keyring-backed vault | ⚠️ 🔍 | Execute the new removal contract on Windows CI, then add one injected keyring-failure journey; keep browser settings to a thin reachability smoke        |
| P1       | Agent teams `/agent-teams`, `/agent-teams/workspace`                   | Product E2E creates a scratch team, adds a teammate + task, proves reload/tab persistence, and returns to the durable hub; workflow wrappers cover create/update                    | ⚠️    | Add a real configured-runtime start → result contract in the native/runtime harness; do not treat the browser page's swallowed start failure as coverage |
| P1       | Memory / twin `/memory`, `/twin`                                       | Mobile twin source/draft surfaces and workflow wrapper specs exist; core desktop routes and ingest/retrieval journey do not                                                         | ⚠️    | Seed source → ingest → retrieve from a user-visible twin/memory flow; resolve the two stub executor contracts                                            |
| P1       | Sites `/sites`                                                         | Route and implementation are currently untracked concurrent work                                                                                                                    | 🧱    | Defer until the module is tracked/stable, then cover create → preview → persist/publish according to ADR-0084                                            |
| P1       | Browser `/browser`                                                     | Browser engine/component work is concurrently modified; no owning product E2E                                                                                                       | 🧱    | After the shared-browser work stabilizes: open session → navigate → observe frame/state → recover from disconnect                                        |
| P1       | Source control `/source-control`                                       | Product code is concurrently modified; no owning product E2E                                                                                                                        | 🧱    | Use a temporary real repository: stage → commit or sync → observe status; do not mock the contract into itself                                           |
| P2       | Workflows `/workflows/**`                                              | Broad editor, engine, node, and run-history suite; six executor suites are explicitly tracked as stubs                                                                              | ⚠️ 🔍 | Re-run by directory, eliminate dead selectors/sleeps, convert each stub from editor-only persistence to executor result when implemented                 |
| P2       | Eval `/eval`                                                           | Current-bundle E2E covers dataset → case/reference → version/gate → Dexie/reload and exposed/fixed dropped split/tags/metadata/inputVars                                            | ⚠️    | Add configured target execution → persisted report/gate verdict; retain authoring fields as a durable regression contract                                |
| P2       | Mobile shell / pairing / offline                                       | Broad Pixel 7 coverage across pairing, queues, notifications, gestures, backup, navigation, connection health, and biometric sign-out                                               | ⚠️ 🔍 | Pay down 9 remaining spec-level arbitrary waits across 6 files; run the weekly WebKit project and classify platform-only failures                        |
| P2       | Plugins `/plugins`                                                     | Workspace/marketplace/node coverage plus mobile sync → local toggle → durable queue → immediate Companion dispatch → reload                                                         | ⚠️ 🔍 | Add install/permission/revoke lifecycle only at the real runtime boundary; retain native permission coverage in Tauri                                    |
| P2       | Goals `/goals`                                                         | Product E2E creates through quick-create, audits pause, restores paused state after reload, resumes, stops, and verifies durable history                                            | ⚠️    | Add a configured model-runtime turn → token/turn progress → judge/terminal result contract without browser-only fake progress                            |
| P2       | Scheduler `/scheduler`                                                 | Product E2E creates a cron-backed app task, observes its next-run schedule, pauses it, reloads the full document, and resumes the durable row                                       | ⚠️    | Add real execution → run history plus native background/system-task delivery; do not infer those boundaries from renderer timing                         |
| P2       | Skills `/skills`                                                       | Product E2E creates a skill, disables it, reloads the document, enables it, edits metadata in the workspace, and proves durable state; workflow invoke is separately covered        | ⚠️    | Add one configured model turn that proves an enabled skill enters the resolved prompt and a disabled skill does not                                      |
| P2       | Search `/search`                                                       | Product E2E sends a real Exa-shaped HTTP request, synthesizes through the shared Anthropic mock, renders cited sources, and opens the external result                               | ✅    | Add cancellation/retry only when those policies change; provider adapters remain lower-layer matrix tests                                                |
| P2       | Observability `/observability`, `/logs`, `/performance`, `/agent-runs` | Agent Runs controls a durable goal; Observability covers trace rollup/waterfall; Logs covers durable search, URL restore, structured detail, stack, and related-entry correlation   | ⚠️    | Add `/performance` only in the Tauri harness against real process metrics; do not add a browser reachability smoke                                       |
| P3       | Pet / fleet / remote sessions                                          | Pet covers hatch → rename → care → durable profile/ledger → reload; Remote Sessions and Fleet cover paired control, triage, commands, and live WS updates                           | ⚠️    | Add transparent overlay/popup window role, click-through, positioning, and cross-webview bridge contracts only in the real Tauri harness                 |
| P3       | Mobile command history `/me/command-history`                           | Pixel 7 pulls desktop rows through Companion, proves Dexie/group/search, replays through `terminal_exec`, then restores the list while sync returns 503                             | ✅    | Keep host capability rejection and actual shell execution in native Companion/Rust coverage; the portable contract owns transport shape and offline UI   |
| P3       | Mobile MCP settings `/me/mcp`                                          | Pixel 7 mirrors sorted stdio/http servers through Companion into Dexie, restores them during a 503 outage, and proves the whole surface is gated in standalone mode                 | ✅    | Keep OAuth and actual MCP runtime execution on desktop/native boundaries; mobile remains a paired-only, read-only projection                             |
| P3       | Mobile characters `/discover?category=characters`                      | Pixel 7 mirrors a desktop character, edits/deletes/creates through Dexie + durable queue, dispatches both RPC kinds immediately, and proves reload state                            | ✅    | Keep pack import/export and built-in/overlay protection at their owning desktop/data layers; add twin binding only through its real mobile UI            |
| P3       | Mobile Network settings `/me/network`                                  | Pixel 7 reads Wi-Fi from the native plugin, observes offline/cellular listener updates, proves proxy controls remain desktop-only, and gates the surface in standalone mode         | ✅    | Keep proxy apply/test and host networking in native desktop coverage; the phone owns only its live connectivity projection                               |
| P3       | Mobile Storage `/me/storage`                                           | Pixel 7 reports a real account-scoped Skill category, confirms targeted deletion, verifies the durable row is gone, and proves the Settings singleton survives                      | ✅    | Add deep-cleanup age-boundary coverage only if the retention policy changes; lower layers own category/table matrix exhaustiveness                       |
| P3       | Mobile Notifications `/me/notifications`                               | Pixel 7 edits channel, quiet-hours, and per-source controls, proves the Settings row and `app_settings_update` queue payload, then verifies the controls after reload               | ✅    | Keep OS permission lifecycle device-local; add native denied → system-settings recovery only in a real device harness                                    |
| P3       | Settings `/settings`, `/me/*`                                          | Workflow, plugin, connections, backup, mobile Me, and native subscription slices exist; most settings routes are unvisited                                                          | ⚠️ 🔍 | Group by destructive/credential/runtime impact; do not create one smoke per settings route                                                               |

## Governance baseline

`pnpm audit:e2e-governance` is a CI quality gate. On this date it accepts exactly
20 reviewed debt occurrences:

- 2 runtime skips/fixmes: native VSIX LSP and dormant standalone chat.
- 12 arbitrary waits: 3 intentional gesture-frame waits in the helper and 9
  legacy spec-level waits awaiting observable seams.
- 6 workflow suites whose titles correctly disclose editor-only stub contracts.

Focused tests, vacuous `expect(true).toBe(true)` assertions, and required user
actions conditionally hidden behind `locator.count()` can never be exempted.
Exception counts must match exactly, and every exception has an ISO review date
so the ledger cannot become permanent background noise.

## Harness risks

| Risk                       | Evidence                                                                                                                                                                                                                        | Governance response                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin/Dexie reset race    | Focused dev-server runs log `DatabaseClosedError`, `SchemaDiff`, and blocked upgrades during plugin initialization—even with a fresh context and no reset                                                                       | Keep traces/logs; use fresh static exports for authoritative portable E2E while fixing dynamic plugin-table version ownership separately |
| Account-registry boot race | Resolved: the harness reproduced missing stores 8/8 at four workers; `ensureCogniaAccount` now waits for the Dexie schema and seeds through that same connection, then passed 8/8 and the original five-module batch passed 9/9 | Keep the atomic harness contract; do not regress to check-then-open polling, per-spec sleeps, or retries                                 |
| Stale local static export  | A pre-existing `out/` collected the new spec but all tests stopped before `__cogniaTestGlobalsReady`; a fresh `pnpm test:e2e:build` made all three pass                                                                         | CI already builds fresh; local documentation now requires build before static verification                                               |
| Native coverage visibility | Tauri is Windows-only and nightly; default Chromium cannot prove IPC/keyring/sidecar behavior                                                                                                                                   | Keep native contracts in the Tauri project and add thin browser coverage only for portable UI behavior                                   |

## Execution record

### 2026-07-18 — governance + public sharing

- `pnpm audit:e2e-governance:test`: 4 passed.
- `pnpm audit:e2e-governance`: passed, 23 tracked debt occurrences.
- `playwright test --list --project=chromium tests/e2e/share/public-share-view.spec.ts`:
  3 tests collected.
- Focused dev-server run: 3 passed.
- First static run against old `out/`: 3 failed in shared bootstrap before any
  share assertion (`__cogniaTestGlobalsReady` timeout).
- `pnpm test:e2e:build`: compiled and generated 98 static routes.
- Fresh static focused run: 3 passed in 27.5s.

### 2026-07-18 — connector approval + retry

- Replaced the conditional approval click with two required contracts: approve
  and reject both persist locally, drain the mobile queue, and reach the mock
  desktop RPC boundary.
- Approval injects one HTTP 503 and proves the transport retries with the same
  `Idempotency-Key`; fresh static Pixel 7 run: 2 passed in 23.5s.
- Fixed the desktop approval handler so a draft with `outboundPreview` enqueues
  a `draft-approved` platform job before changing status. Enqueue failure leaves
  the draft pending; focused Jest: 61 passed across the handler and E2E bridge.
- Added a non-exempt governance rule for `locator.count()` guards around real
  user actions, and removed both occurrences that it exposed.
- A fresh `pnpm test:e2e:build` compiled and generated 98 static routes. The
  connector spec uses a fresh-context mobile bootstrap rather than deleting an
  open Dexie database, keeping the known plugin-upgrade race out of its subject.

### 2026-07-18 — credential lifecycle audit

- Existing native coverage already proves Anthropic PKCE add + state rejection,
  Codex CLI credential adoption, OpenCode key add + empty-key validation,
  active switching, and preset CRUD.
- Added the missing destructive lifecycle contract: removing the active account
  through Settings must delete it from the keyring-backed vault, clear the
  active pointer, and render the empty account state.
- Tauri collection passed with 9 subscription tests across 4 files (3 in the
  focused lifecycle file). Runtime execution remains Windows-only, so this
  macOS audit does not claim native execution.

### 2026-07-19 — connector dead-letter recovery

- Added a browser-owned operator contract for two persisted dead-letter jobs:
  filter and inspect the original failure + idempotency key, confirm “Retry
  all”, then observe both jobs re-armed as fresh pending rows with cleared
  errors and attempts.
- The same action must append one `outbound.replayed` audit row per job while
  preserving each original `lastErrorCode`; the spec polls durable Dexie state,
  not a transient toast or route visit.
- Two dev-server attempts failed before the contract because dynamic plugin
  schema upgrades were blocked (`DatabaseClosedError` / `SchemaDiff`). No
  timeout was widened. A fresh `pnpm test:e2e:build` compiled and generated 98
  routes; the focused static run passed, then the full browser connector
  directory passed 3/3.
- Default discovery now collects 233 Chromium/Pixel 7 tests in 138 files. E2E
  governance remains at 23 reviewed debt occurrences; this spec added none.

### 2026-07-19 — Agent Teams product workspace

- Added the first owning product E2E for `/agent-teams`: create a team from
  scratch, verify its single seeded lead, add a named teammate, create a task,
  reload the full document, and prove the team, selected Tasks tab, roster, and
  task survive before returning to the durable team hub.
- The first run exposed a real duplicate-lead defect: `createTeam` already
  creates the lead atomically, while the scratch dialog added a second lead.
  Removed the duplicate write and added a focused page regression test; Jest
  passed 6/6.
- A fresh `pnpm test:e2e:build` generated 98 routes and the focused Chromium
  static-export journey passed 1/1 in 6.5s. Runtime execution remains an
  explicit native/runtime gap because browser start failures are swallowed at
  the page boundary and must not be counted as a successful run contract.
- Default discovery now collects 234 Chromium/Pixel 7 tests in 139 files. The
  new spec adds no skip, arbitrary wait, conditional-action, or stub debt.

### 2026-07-19 — Goals product lifecycle

- Added the first owning `/goals` product journey: quick-create a goal in a
  fresh chat, observe it as active, pause it, verify the persisted
  `goal_created` + `user_paused` activity, reload into the paused state, then
  resume and stop it into the History table.
- The first run exposed a first-workspace crash before any click:
  `listAllGoals()` called the write-capable scope resolver from a Dexie
  `liveQuery`, producing `ReadOnlyError: Readwrite transaction in liveQuery
context`. The reader now performs a read-only Default-ID fallback while the
  existing project initializer retains ownership of creating/activating the
  workspace.
- Added a direct liveQuery regression test. Focused Goals DB Jest passed 26/26;
  a fresh E2E build generated 98 routes; the Chromium static lifecycle passed
  1/1 in 6.9s.
- Default discovery now collects 235 Chromium/Pixel 7 tests in 140 files. The
  model-driven turn/judge path remains explicit runtime work rather than a
  browser mock dressed up as lifecycle progress.

### 2026-07-19 — Scheduler product lifecycle

- Added the first owning `/scheduler` product journey: create a real cron-backed
  app task through the form, observe the durable row and next-run expression,
  pause it, reload the full document, and resume it from persisted state.
- The initial form open exposed a React 19 crash: the custom-mode Zustand
  selector materialized a fresh array for every store snapshot. Stabilized it
  with `useShallow` and added a component regression that failed with
  `Maximum update depth exceeded` before the fix.
- The same trace exposed a missing `name` argument for the localized session
  title placeholder. The editor now receives the live task name and formats the
  placeholder instead of rendering `{name}` literally.
- Removed an unrelated `__cogniaTestGlobalsReady` wait from the spec. This
  journey never calls the E2E DB bridge, so plugin-table upgrade completion was
  a false readiness condition; the owning Scheduler button is its observable
  seam. The fresh static-export run passed twice in parallel (2/2, 45.0s).
- Focused Scheduler Jest passed 10/10 and the production static export generated
  all 98 routes. Current default discovery is 238 tests in 141 files: this batch
  adds one file/test, while two concurrently edited existing specs added the
  other tests since the prior 235-test baseline.

### 2026-07-19 — Standalone cited search

- Corrected the audit target: `/search` is the standalone BYOK web-search
  product, not a cross-module local-record search. Its owning E2E now submits a
  user query, verifies the real Exa request body/API-key boundary, synthesizes
  through the global Anthropic mock, renders the mock-only answer marker and
  cited source, then opens the external result in a new page.
- The first real run exposed a missing `mobile.standaloneSearch` namespace, so
  the route rendered raw message keys. Added complete English and Chinese split
  sources, regenerated the canonical artifacts, and validated 0 malformed ICU
  messages with locale parity intact.
- The mock model connection initially returned 404 because the AI SDK expects
  an Anthropic-versioned base URL; the test now supplies the mock's `/v1`
  boundary, matching the production provider contract rather than intercepting
  model output in the component.
- Updated the stale page unit that still expected the shared back control to be
  an anchor after `SubPageShell` moved to history-aware button navigation.
  Focused Search Jest passed 29/29; the fresh static export generated 98 routes;
  the product E2E passed 1/1 in 7.5s. Discovery is now 239 tests in 142 files.

### 2026-07-19 — Skills product management

- Added the first owning `/skills` management journey: author a valid skill in
  the product sheet, disable it, reload and observe the disabled control,
  re-enable it, edit its metadata through the shared workspace settings, then
  reload again and prove both the update and enabled state remain durable.
- The spec uses only observable UI/storage behavior and contains no bridge
  seeding, conditional user action, arbitrary wait, or editor-only stub. The
  focused static-export run passed 1/1 in 9.1s and governance remains at 23
  reviewed debt occurrences.
- Discovery is now 240 tests in 143 files. Runtime prompt inclusion remains an
  explicit configured-model contract; management persistence is not counted as
  proof that the skill entered an agent prompt.

### 2026-07-19 — Unified Agent Runs control

- Added an owning `/agent-runs` journey whose source is a goal authored through
  the real Goals UI. The console filters to Goals, deep-links the selected run
  into query state, exposes running/live status, pauses it through the goal
  runtime, restores the paused control after reload, resumes, and aborts it to
  the durable Cancelled state.
- Focused static-export execution passed 1/1 in 6.9s. A six-worker regression
  then exposed two readiness assumptions: AccountGate can remain observably
  loading beyond Playwright's 5s assertion default under worker contention,
  and the goal status liveQuery can update before the separately awaited audit
  append becomes visible. Both now wait on their specific observable seams
  with 20s budgets and no sleeps; the rerun passed 6/6 in 29.8s.
- Discovery is now 241 tests in 144 files, and the E2E governance debt count
  remains unchanged. `/observability`, `/logs`, and native `/performance`
  diagnostics are not inferred from this Agent Runs contract.

### 2026-07-19 — Persisted Observability trace drill-down

- Added an owning `/observability` journey that writes three canonical finished
  spans at the real IndexedDB boundary, verifies the durable rows before route
  navigation, and exercises the production Dexie live-query, trace rollup, and
  waterfall detail path without component or route mocks.
- The journey proves aggregate span count, two-trace rendering, model
  click-to-filter, shareable URL state after a full reload, and parent/tool
  drill-down including recorded events and an error message.
- Focused static-export execution passed 1/1 in 8.4s; discovery is now 242 tests
  in 145 files. `/logs` remains a distinct ingestion/filter/detail contract,
  while `/performance` remains native-only per ADR-0035.

### 2026-07-19 — Durable Logs investigation

- Added an owning `/logs` journey that inserts three canonical structured
  entries into the production `cognia-logs` IndexedDB transport boundary and
  verifies the transport rows before exercising the route.
- The journey proves unique search filtering, header counts, URL-backed query
  restoration after a full reload, error detail metadata, parsed stack frames,
  and navigation to a related entry sharing the same trace ID. Agent Trace is
  deliberately not inferred because the page configures `includeAgentTrace`
  off and `/observability` owns that contract.
- Focused static-export execution passed 1/1 in 6.2s; the two-surface
  Observability/Logs regression passed 2/2 in 15.2s. Discovery is now 243 tests
  in 146 files, and the governance gate remains at 23 reviewed debt occurrences.

### 2026-07-19 — Paired Remote Sessions control

- Added an owning Pixel 7 journey using the real Capacitor shell and Companion
  transport against deterministic desktop HTTP/WebSocket boundaries. It lists
  a host session, attaches with the paired device identity, sends and interrupts
  a follow-up, receives a routed permission request, denies it, and detaches on
  return to the list.
- The first run exposed a cold-deep-link race: `RemoteSessionsList` called
  `session_list` before the boot provider had hydrated Secure Storage into the
  transport cache, then stayed in a false unpaired error. The component now
  awaits the existing `hydrateCompanionConfig` boundary; its co-located
  regression proved red before the fix and now passes 4/4.
- A fresh static export generated all 98 routes, and the focused mobile E2E
  passed 1/1 in 6.6s. Discovery is now 244 tests in 147 files.

### 2026-07-19 — Paired Agent Fleet triage and control

- Added an owning Pixel 7 journey that backfills a real Fleet snapshot through
  Companion RPC, verifies attention-first sorting, denies a parked permission,
  sends a session reply, focuses the owning terminal, and applies a newer
  `fleet://update` WebSocket snapshot.
- The initial run exposed the same cold-deep-link cache race at store level:
  the first snapshot degraded to empty and the event socket never opened. The
  remote store now hydrates persisted pairing before subscribing, preserves
  subscribe-before-backfill ordering, and rejects stale async generations;
  its co-located suite passes 6/6.
- The transport parity audit also found `fleet_get_snapshot` missing from the
  client's Rust-mirrored read-only set. Its parity test proved the erroneous
  Idempotency-Key before the one-line fix and now passes. A fresh static export
  generated 98 routes; Fleet passed 1/1 in 5.6s and the paired Fleet/Remote
  regression passed 2/2 in 12.8s. Discovery is now 245 tests in 148 files, with
  governance unchanged at 23 reviewed debt occurrences.

### 2026-07-19 — Durable Pet nurture lifecycle

- Added the first owning `/pet` browser journey: a fresh account lets the real
  `PetMount` create the singleton egg, the user hatches it through the runtime,
  renames it through the shared inline editor, and feeds it through the event
  bus/controller. The spec then proves profile XP/coins and a `fed` user row in
  the append-only activity ledger before a full-document reload restores the
  same identity and progression.
- The first two attempts never reached Pet assertions because the broad reset
  bridge dynamically imported the plugin runtime after PetMount had opened the
  base Dexie schema. Trace evidence ended with `[db] schema upgrade still
blocked after retries`. Since every Playwright test already owns a fresh
  browser context, the Pet contract now bootstraps only the account gate and is
  independent of unrelated plugin-table readiness; no timeout or sleep was
  added.
- The focused static-export run passed 1/1 in 8.2s (17.2s total). Default
  Chromium/Pixel 7 discovery now collects 246 tests in 149 files, and E2E
  governance remains at 23 reviewed debt occurrences. Transparent overlay and
  popup behavior stays explicitly native: window role, click-through,
  positioning, and cross-webview delivery cannot be proven by `/pet` browser
  coverage.

### 2026-07-19 — Eval dataset authoring

- Added an owning `/eval` journey for the portable authoring boundary: create a
  dataset, add a case with reference fields and authoring metadata, observe the
  dataset version bump, persist a quality gate, verify the real `evalDatasets`
  and `evalCases` rows, then reload the document. Model-backed target execution
  remains a separate configured-runtime contract.
- The first static run reached the durable assertion and exposed a product bug:
  `addCase()` discarded `split` and `tags` (and audit found the same omission
  for `metadata` and `inputVars`). A co-located regression failed for the
  missing fields, then passed after the row constructor preserved all four;
  focused Jest passed 1/1 and changed-file ESLint passed.
- Browser verification against the current source is not yet green. A
  seven-hour orphan `serve-out.mjs` on port 3000 explained why two reruns kept
  exercising the old bundle and was terminated. After that, the production
  build made no progress past optimized compilation and Turbopack dev startup
  hit its existing 300s harness ceiling. An isolated Webpack server became
  ready in 3.7s, but even after changing the account-bootstrap navigation from
  the unrelated Chat `/` route to `/eval` directly, it did not finish compiling
  `/eval` within the unchanged 60s test budget or the subsequent bounded warmup.
  No timeout or sleep was widened, and this row remains blocked until a current
  bundle executes the contract.
- The spec collects 1/1; default Chromium/Pixel 7 discovery is therefore 247
  tests in 150 files. Governance still passes at exactly 23 reviewed debt
  occurrences.
- A later bounded production build completed successfully in 77s and generated
  all 98 static routes. The same authoring contract then passed against that
  current bundle in 12.7s, so the compiler blocker is resolved; configured
  model target execution remains the next separate contract.

### 2026-07-19 — Paired Mobile Command History

- Added the owning `/me/command-history` Pixel 7 journey at the real Companion
  boundary. A desktop mock answers `sync_pull` only; the production handler
  writes three `terminalHistory` rows into Dexie, and the page proves
  alphabetical project grouping, the projectless tail bucket, durable row
  fields, and command search/no-results behavior.
- Replaying a synced shell line goes through the product confirmation dialog
  and the real `terminal_exec` transport. The captured request proves the full
  command, `shell: true`, and the 60-second budget; the captured host result is
  rendered back in the dialog.
- After the initial sync, the desktop boundary switches to HTTP 503. A full
  document reload triggers another real pull attempt while both history rows
  remain visible from Dexie, proving the offline-first contract rather than a
  repeated mock response. The static Pixel 7 run passed 1/1 in 8.4s (20.0s
  total), without sleeps, conditional assertions, or widened timeouts.
- Actual host shell execution and remote-control capability rejection remain
  native Companion/Rust responsibilities. Default Chromium/Pixel 7 discovery
  is now 248 tests in 151 files; governance remains at 23 reviewed debt
  occurrences.

### 2026-07-19 — Mobile MCP settings parity

- Added paired and standalone `/me/mcp` contracts for ADR-0056. In paired mode,
  the production Companion boot orchestrator pulls `mcpServers`; the real sync
  handler writes stdio and HTTP rows to Dexie, and the page renders them in
  name order with their enabled state and the remote-auth-on-desktop guidance.
- After the first mirror, the desktop boundary returns HTTP 503 for MCP pulls.
  A document reload makes another real sync attempt while the read-only list
  remains available from Dexie. A separate fresh standalone context proves
  `PairedOnly` hides both the server section and desktop-management guidance,
  so the webview runtime does not expose dead MCP configuration.
- The focused static Pixel 7 run passed 2/2 (15.0s paired, 9.9s standalone;
  29.0s total). OAuth and actual tool execution intentionally remain desktop /
  native runtime contracts. Discovery is now 250 tests in 152 files, with no
  new governance debt.

### 2026-07-19 — Mobile plugin toggle and queue wake-up

- Added an owning paired `/me/plugins` lifecycle. The desktop plugin arrives
  through `sync_pull("plugins")`; the UI renders its version, toggles the real
  Dexie row, creates a durable `plugin_set_enabled` queue job, dispatches the
  exact `{ id, enabled }` payload to Companion, reaches `sent`, and restores
  the disabled state after reload.
- The first current behavior run failed exactly at the transport boundary:
  local state and the queue row were correct, but the row remained `pending`
  for the full 10-second observation window. The provider only drained on
  mount or a future network transition, so an enqueue while already online had
  no wake-up path despite the runner's documented contract.
- A co-located regression first failed because the provider never subscribed
  to queue changes. `MobileOutboundRunnerProvider` now observes the pending-row
  count through Dexie `liveQuery`, subscribes before its initial kick, and
  tears the subscription down with the runner. The focused suite passes 9/9.
- A fresh `NEXT_PUBLIC_E2E=1` production build compiled in 77s and generated
  98 routes. The current-bundle cross-module regression passed 5/5: Eval,
  Command History, both MCP modes, and Plugin Toggle; the plugin lifecycle
  itself passed in 17.3s. Discovery is now 251 tests in 153 files with no new
  arbitrary waits or governance exceptions.

### 2026-07-19 — Paired mobile character management

- Added the owning Characters lifecycle on the Discover character category.
  A user-authored row arrives through `sync_pull("characters")`; the user edits
  its identity, prompt, model, and avatar through the production mobile sheet,
  then deletes it and creates a replacement. Every state transition is checked
  in the real `characters` table and again after document reload.
- Both update/create operations enqueue `character_upsert`, while deletion
  enqueues `character_delete`. The live queue runner reaches `sent` without a
  manufactured network transition, and the Companion capture proves the exact
  character id and draft/delete payloads.
- The first run reached the updated card, durable row, sent queue job, and RPC,
  then timed out on an immediate reopen because the Radix Sheet had not yet
  finished its observable close lifecycle. The spec now waits for the sheet to
  leave the DOM before the next user action; no timeout, retry, or sleep was
  added. The focused static Pixel 7 rerun passed 1/1 in 12.4s (23.4s total).
- Default Chromium/Pixel 7 discovery is now 252 tests in 154 files. Static
  Hooks/Slash Commands pages remain unit-owned rather than receiving duplicate
  route smokes; pack import/export and overlay guards stay in their narrower
  desktop/data suites.

### 2026-07-19 — Keyboard-avoidance governance debt removal

- Replaced the mobile keyboard spec's 200ms wait and nullable bounding-box
  comparison with the shell's public state contract: native show/hide events
  must toggle `data-keyboard-visible`, the tab bar's hidden attribute, and its
  translated-off class, then restore all three on hide.
- The first governed rerun exposed that the legacy setup reset Dexie without
  restoring `mobileRuntimeMode` and therefore stopped on `/welcome`; after
  adopting the existing fresh Standalone bootstrap, it exposed a second stale
  premise—the current chat landing has no composer until New Chat. The final
  contract targets the owning shell rather than an unrelated textbox and
  passes 1/1 in 4.1s (11.6s total), without sleeps or conditional assertions.
- Removed the exact `keyboard-avoidance.spec.ts` exception. The governance gate
  now passes with 22 tracked debt occurrences: 14 arbitrary waits, 2 runtime
  skips/fixmes, and 6 disclosed executor stubs.

### 2026-07-19 — Connection-state governance debt removal

- Replaced the blocked-sign-out test's one-second blind wait and permissive
  “still paired” fallback with the product's explicit `pair-signout-error`
  contract, followed by a durable credential-preservation assertion.
- The governed rerun exposed three stale fixture assumptions. Android pairing
  credentials live in the injected `SecureStoragePlugin`, not localStorage;
  navigating after an optional bridge save recreated an empty native mock; and
  biometric unavailability intentionally falls through instead of failing.
  The suite now seeds and inspects the native secure store directly and drives
  a real verification error after the paired page is ready.
- The refresh path also exposed mock-server drift: the Rust dispatcher and
  `CompanionTransport` accept the read-only `claude_sidecar_status` command on
  `/_rpc`, while the E2E server rejected it as outbound-only. The mock now
  mirrors that command boundary. The focused static Pixel 7 suite passes 4/4
  in 17.4s, and governance passes with 21 tracked occurrences: 13 arbitrary
  waits, 2 runtime skips/fixmes, and 6 disclosed executor stubs.

### 2026-07-19 — Pull-to-refresh governance debt removal

- Removed the one-second entrance-animation wait from the real Discover
  pull-to-refresh contract. The gesture reads its bounding box immediately
  before dispatch, so elapsed wall time was not a readiness signal.
- Strengthened the outcome at the same time: a `MutationObserver` now proves
  the public `data-refreshing` state rendered `true` and returned to `false`.
  The former final-only `false` assertion could pass even if release never
  committed a refresh; the drag-distance assertion remains as the independent
  threshold check.
- The focused static Pixel 7 run passes 1/1 in 4.4s. Governance now passes with
  20 tracked occurrences: 12 arbitrary waits, 2 runtime skips/fixmes, and 6
  disclosed executor stubs.

### 2026-07-19 — Mobile Network settings boundary

- Added paired and standalone `/me/network` contracts for ADR-0056 D6. In
  paired mode, the page reads the real injected Network plugin as online over
  Wi-Fi, waits on the mock's listener-count readiness signal, then proves live
  offline/no-connection and online/cellular transitions.
- The same journey requires the desktop-management guidance and proxy summary
  while asserting there is no editable proxy form on the phone. A separate
  fresh standalone context proves `PairedOnly` hides both connectivity and
  desktop-management content, so no dead host-network surface leaks into BYOK.
- The focused static Pixel 7 run passes 2/2 in 13.6s. Default discovery is now
  254 tests in 155 files, with governance unchanged at 20 tracked debt
  occurrences.
- A five-module, 9-test batch then exposed a harness-level account-registry
  readiness race before module assertions: 7-worker and CI-equivalent 4-worker
  runs produced `ERR_ADDRESS_INVALID`, missing registry stores, and bridge
  readiness timeouts; a 1-worker rerun still reproduced missing stores after
  its first fresh context. `tests/e2e/helpers/db-reset.ts` is concurrently
  modified, so this slice records the exact fix boundary instead of layering
  spec-local waits over it. The focused module runs above remain the current
  behavior evidence; the combined batch is not claimed green.

### 2026-07-19 — Account bootstrap race removal

- Added a focused harness contract that calls `ensureCogniaAccount` immediately
  after `/welcome` reaches DOM readiness. Before the fix it reproduced the
  missing `accounts` / `state` stores 8/8 at four workers.
- `ensureCogniaAccount` now waits for the account-registry Dexie schema and
  writes the account plus active pointer in the same connection and
  transaction, eliminating the previous check-then-open race. It returns only
  after transaction completion.
- The harness passes 8/8 at four workers. The original five-module Pixel 7
  batch passes 9/9 at four workers with no retries or new waits. Default
  discovery is now 255 tests in 156 files; governance remains at 20 tracked
  debt occurrences.

### 2026-07-19 — Mobile targeted storage cleanup

- Added an owning `/me/storage` contract using an account-scoped Skill row,
  rather than treating card visibility as storage coverage. The page must
  report the Skill category before the user acts.
- The journey opens the category confirmation dialog, clears only Skills,
  polls the durable row until it is absent, and proves the Settings singleton
  still retains `mobileRuntimeMode: standalone`.
- The focused static Pixel 7 run passes 1/1 in 8.1s. Default discovery is now
  256 tests in 157 files, with governance unchanged at 20 tracked debt
  occurrences.

### 2026-07-19 — Mobile notification preference persistence

- Added an owning `/me/notifications` contract for ADR-0056's portable
  preference boundary: enable the OS channel, enable and edit quiet hours, and
  mute the Connector source.
- Each control must persist in the account-scoped Settings singleton. The
  journey also requires an `app_settings_update` durable queue payload carrying
  the source override, then reloads the full document and verifies all edited
  controls restore.
- An initial offline-start attempt exposed a separate runtime-mode redirect to
  `/welcome`; the contract now uses normal connectivity because queue creation,
  not a transient runner status, is its subject. The focused static Pixel 7 run
  passes 1/1 in 7.7s.
- Default discovery is now 257 tests in 158 files, with governance unchanged at
  20 tracked debt occurrences.

Next audit slice: injected keyring failure handling once the concurrent
credential-store edits stabilize; otherwise continue with the next stable
uncovered module and return to keyring without overlapping the shared files.
