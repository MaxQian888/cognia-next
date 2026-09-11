# Unified IM conversations

Status: implemented in the working tree on 2026-09-10. Approved in conversation.
Scoped verification passed; repository-wide and live-platform acceptance limits
are recorded below. No commit or deployment was requested.

IM is a first-class conversation in the existing ChatSession system. Platform
binding, conversation membership and execution targets remain independent.
There is no new IM session table or mutually exclusive SessionKind.

## Accepted behavior

- A platform icon identifies the origin in the shared conversation list and
  header. Its accessible name and destination text identify the platform;
  account, group and thread details remain available.
- The IM primary composer sends to the platform regardless of automation mode.
  AI assistance generates an editable draft and never publishes implicitly.
- Attachments, quoted replies, template provenance, and delivery failures must
  survive the shared send contract. Existing delivery governance, PII gates,
  idempotency, retries and companion forwarding remain authoritative.
- Old Inbox conversation links resolve the actual session and open the common
  conversation. Exact session links must remain bound to that conversation;
  key-only links use the runtime's active-session resolver.
- Every interactive ChatPane owns its blocking approval and elicitation UI and
  plan continuation. Navigation tabs and mounted pane lifetimes stay distinct.
- One React runtime owner processes direct chat events. Per-run capture may
  observe events independently but owns only its explicitly registered control
  responses, preventing competing approvals.

## Work and verification

1. Runtime owner and control routing: reproduce repeated ownership with multiple
   consumers; verify one handler, cleanup, capture ownership and failed setup.
2. Shared pane gates: verify named-session isolation, duplicate approval delivery,
   multiple pane lifetime, plan continuation and embedded template metadata.
3. IM sending: verify modes do not change send meaning, attachments and reply
   targets arrive intact, failures preserve the draft, AI generation stays local
   until the user explicitly sends.
4. Conversation navigation and identity: verify active-session selection,
   exact-session and message links, platform labels, canonical list state and
   preserved history/settings/thread controls.
5. Integration: run affected tests with coverage, typecheck, lint, locale build
   and parity checks; inspect the browser flow and audit runtime wiring.

## Research corrections

The source audit at `docs/research/2026-09-10-chat-surface-capability-contract.md`
correctly identifies missing surface wires, but approval journal records already
deduplicate by requestId. The in-memory pending approval list did not. Current
split view also excludes the same session in both columns. Pane registration
must not redefine or destroy the existing open-session navigation state.

An IM conversation may bind multiple sessions through `/new` and `/switch`.
Inbox previously used `.first()` instead of the runtime active-session resolver.
Conversation lifecycle (pending, snoozed, resolved) remains connector policy;
session pin/archive/read state is shared by conversation lists.

## Compatibility and acceptance boundary

The existing static `/inbox/c` URL stays supported. No schema version or stored
kind migration is needed. Standalone clients must show unavailable write state;
paired clients use the existing host route. No transport adapters are removed.
Local fixtures and browser tests do not establish real-platform delivery;
live-account acceptance is reported separately.

## Implemented behavior and cleanup

- The old Inbox detail page is now a compatibility resolver. The shared pane
  carries platform controls, history, notices and active-session bookkeeping.
- Desktop and compact lists share session pin/archive/read state. Legacy Inbox
  preferences migrate once at renderer startup; compatibility writes consume
  legacy fields without resurrecting cleared preferences. IM is an independent
  filter, so a team conversation may also originate from a platform.
- Platform sending preserves original attachment bytes, thread/reply targets,
  template provenance and durable relay behavior. Local AI regenerate/edit-resend
  actions are absent on platform transcripts. IM text prefixes stay literal,
  and AI stream capacity does not block manual platform delivery.
- Separate AI drafting uses the existing PII gate and utility/headless clients,
  allows cancel/edit/apply, and never implicitly publishes.
- One direct runtime controller serves all panes. Capture responders retain
  turn-scoped control ownership and global tool checks. Blocking approval and
  elicitation UI moved out of desktop/mobile shells into the shared pane.
- Pane registration is independent of navigation tabs. Hidden resident runs
  settle; revealed panes restore subagent projection and drain waiting work;
  loop kickoff is bound to the registered conversation.
- Failed explicit elicitation responses retain the question and inputs.
  Failed plan continuation retains its exact prompt/mode for retry, including
  across pane remounts, without repeating approval or plan startup.
- Existing connector transports, headless runtimes, delivery governance,
  idempotency, retries and companion command authority remain in place.

## Verification record (2026-09-10)

- Final shared surface integration: **14 suites / 462 tests passed**.
- Final runtime and plan recovery batch: **4 suites / 232 tests passed**.
- IM composer and relay batches: **13 suites / 309 tests passed**.
- Strict elicitation/decision batch: **3 suites / 54 tests passed**.
- Facade metadata propagation: **17 tests passed**, including both local and
  paired-host paths. Legacy list migration/action final tests also passed.
  These batches overlap; their counts must not be summed as unique tests.
- New pane runtime, gates, platform context and AI draft service: **100%**
  focused coverage on statements, branches, functions and lines. New draft
  assistance UI: **100% lines/functions, 93.02% branches**. Extended manual-send:
  **100% lines/functions, 97.95% branches**. Runtime provider: **100%**; capture
  approval registry: **100% lines/functions, 98.21% branches**.
- TypeScript: **No errors found**. Scoped ESLint and whitespace checks passed.
  Locale generation, freshness, key parity, referenced-key and sort gates passed.
- Six applicable audits completed: wiring findings and facade-test gaps were
  corrected; i18n, PII, static export and generated Rust/protocol review found no
  outstanding issue in the scoped change.
- Native companion generator check passed: **692 remote commands / 101
  classified routes**. Optional room template metadata and all seven generated
  artifacts agree. No new command or ACL grant was introduced.
- Browser verification used three synthetic conversations in an isolated
  profile. Key-only Inbox links selected the active session; explicit historical
  session/message links selected the exact session. Platform badges, destination,
  IM filter, shared controls and drafting actions rendered on desktop and at
  390px mobile width, with no horizontal document overflow. Standalone platform
  sending stayed disabled and retained the typed draft. No real message sent.

### Acceptance limits

The full `pnpm test:coverage` run encountered existing failures (including the
refuse-turn source-list assertion, connector notification callback fixture and
other unrelated suites) and then exhausted the Node heap in shard 1/8. It does
not establish repository-wide 90% coverage. A pre-existing local ChatHeader
chrome-budget test also expects three controls while the current non-IM branch
has five; the new platform tests pass.

The default full lint run exhausted the Node heap. A 16 GB retry traversed old
`.cache/headless-feishu-2026-09-07` generated capture bundles and was stopped;
scoped source lint passed. The filtered Cargo test was stopped during compilation
when free disk space approached 6 GB; no Rust execution or production build is
claimed. Real IM credentials/provider delivery, paired physical devices and
production deployment remain outside this local verification evidence.

## Follow-up boundary review (2026-09-11)

The follow-up traced shared-pane reading, composer preparation, durable delivery,
native uploads and companion schema validation. It found and corrected these
additional omissions:

- Manual delivery now commits the outbound job and transcript message in one
  IndexedDB transaction. A failed transcript write leaves no runnable job.
  Concurrent host replays of the same idempotency key reuse the original message
  and provenance. A post-commit housekeeping or sync notification failure does
  not invite a second send after both durable records have been verified.
- Reply targets are captured before asynchronous attachment preparation. A
  changed target or newly typed draft is preserved while the submitted snapshot
  completes. Required template validation no longer leaves the send lock armed;
  failed folded-paste submissions remain recoverable through composer history.
  A delivery fallback idempotency key is never used as a platform reply ID.
- Inline attachment bytes reach the existing Telegram, Slack, Lark, Discord,
  Matrix, WeCom and OneBot 11 upload paths; OneBot 12 and WeChat Personal already
  support inline input. Native decoders enforce encoded and decoded size limits
  before upload. DingTalk, WeChat OA and QQ Official connections reject these
  attachments before enqueue, show a localized explanation and retain the draft.
  This preserves their existing text/public-URL capabilities without silently
  dropping a local attachment.
- The native and headless `connector_enqueue_outbound` schemas now accept and
  validate optional reply/template transcript provenance. Legacy requests remain
  valid, while malformed and unknown metadata fields remain rejected.
- Visible IM panes own read-state updates. Hidden panes do not consume unread
  state. Refocus and duplicate-pane ownership changes preserve the visit's
  original unread marker; a new visit captures a new boundary. Loading older
  platform messages targets the exact opened session, including historical
  sessions sharing a platform conversation.
- Missing legacy Inbox links render a localized unavailable state and navigation
  action. They no longer throw a raw client-side Next.js 404 through the global
  error boundary or select stale session state when the key is absent.
- AI drafting reads the latest 30 messages through the existing indexed helper.
  Cancellation is checked before dispatch and after completion, including when
  a provider returns a late result despite cancellation.

### Follow-up verification

- Shared UI regression: **13 suites / 206 tests passed**.
- Durable delivery integration: **7 suites / 292 tests passed**, including the
  real IndexedDB gateway, desktop write handler, local and paired relay paths.
  Failure injection verifies rollback, zero runner wakes and one-job safe retry.
- Adapter regression: **6 suites / 237 tests passed**. Native upload modules:
  **33 Rust tests passed**, including wiremock assertions on uploaded bytes.
- Protocol generator: **45 tests passed**. Generated contract freshness passed
  for **692 commands / 101 routes**, on both protocol planes.
- AI draft service: **100%** focused coverage across all metrics. Draft UI:
  **100% lines/functions, 93.02% branches**. Visible-pane context and visit store:
  **100%** across all metrics. Exact history hook: **99.35% lines, 92.68%
  branches, 100% functions**. Coverage batches overlap with regression runs.
- Final queue/remote coverage regression: **2 suites / 75 tests passed**, with
  explicit per-file 90% thresholds on all metrics. Outbound jobs: **98.99%
  lines/statements, 90.47% branches, 96.96% functions**. Remote writes: **100%
  lines/statements/functions, 95.23% branches**. Tests cover atomic rollback,
  live completion/timeout, ambiguous acknowledgements and legacy FIFO ordering.
- After type integration corrections: **2 shell suites / 80 tests**, **5
  transcript/composer suites / 111 tests**, and **3 gate/runtime/draft suites /
  23 tests** passed. Team sends normalize absent template metadata; direct sends
  retain their existing null semantics. Unsupported transcript actions remain
  absent rather than receiving placeholder callbacks.
- Browser checks used isolated synthetic data: missing-link recovery and an
  explicit historical-session link both worked. The historical IM pane rendered
  its platform controls at **390px** with **390px** document scroll width.
  No real platform message was sent.

The earlier full-repository coverage/lint limitations remain; focused results
do not establish the repository-wide 90% gate. The successful Rust upload run
supersedes the earlier compilation-only result for those modules. A broader
Rust name filter also selected an unrelated command test that failed with
`ProxyNotInitialized`; that broader run is not reported as passing. Real IM
account delivery, paired physical devices and production builds remain separate
acceptance work.

Typecheck evidence correction: the compact RTK wrapper printed "No errors found"
for a run that actually exited 134 after exhausting its 4 GB heap. That text is
not a passing result. A raw run preserving the package script's 16 GB heap
completed and exposed integration type errors. Nullable template provenance,
optional platform transcript actions, database message metadata typing and stale
approval/story/mock fixtures were corrected. Unrelated CLI/settings/model-test
diagnostics in this concurrently modified tree are reported separately; the
earlier compact output must not be used as repository-wide typecheck acceptance.
The final raw rerun completed with **15 diagnostics in 5 unrelated test files**
(`run-shell`, `clipboard-image`, `SettingsOverlay`,
`use-settings-sidebar-collapse`, and `renderer-llm-client`). It reported no
remaining diagnostic in the unified-IM changes. Full typecheck still exits 2;
the raw log is `/tmp/unified-im-20260911-types-corrected.log`.
