# Evidence ledger: Lime support audit

- Status: verifying
- Lane: standard
- Created: 2026-10-23
- Updated: 2026-10-23
- Related: https://github.com/limecloud/lime/releases/tag/v1.167.0

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 研究一下现在Lime支持情况

Follow-up request on 2026-10-23:

> 看看有没有什么学习的

Adversarial review request on 2026-10-23:

> 做一次对抗性审查

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                                                                                                 | State        | Basis                                                                                                                                                                                                                                                                             | Depends on |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | No named Lime/ProxyCast integration was found in Cognia's application, packages, runtime, native crates or ADR sources.                                                                                   | Observed     | Case-insensitive searches of app, lib, components, hooks, stores, packages, src-tauri, crates, sidecar and types on 2026-10-23; color names excluded. Cognia HEAD was 00ee6420d865b0c5f5a2b0539aee2b303c05d878 with unrelated concurrent edits.                                   | -          |
| O2  | The fresh upstream release API returns v1.167.0, published 2026-10-22T13:35:17Z, target dfd780294df6c460da374df1ea911577273e8038.                                                                         | Verified     | GitHub connector GET /repos/limecloud/lime/releases/latest on 2026-10-23; the cached browser latest URL incorrectly resolved to v1.135.0.                                                                                                                                         | -          |
| G1  | Research current Lime support and distinguish existing Cognia support from upstream capabilities and unverified compatibility.                                                                            | Agreed       | User request on 2026-10-23.                                                                                                                                                                                                                                                       | -          |
| A1  | Lime refers to limecloud/lime, formerly ProxyCast.                                                                                                                                                        | Hypothesized | Repository/product context and upstream discovery; assumption stated in commentary on 2026-10-23.                                                                                                                                                                                 | -          |
| C1  | This task is research; product behavior, user credentials and external state must not be changed.                                                                                                         | Observed     | User asked for research on 2026-10-23.                                                                                                                                                                                                                                            | G1         |
| O3  | Lime's released provider docs retire the OAuth/local CLI credential pool; active provider credentials are API Key/configured providers.                                                                   | Verified     | v1.167.0 internal/aiprompts/providers.md and credential-pool.md; server handlers reject missing API Key credentials instead of falling back to the retired pool. Retrieved 2026-10-23.                                                                                            | O2         |
| O4  | Generic chat resolution preserves customHeaders and supports OpenAI Chat/Responses and Anthropic selection.                                                                                               | Verified     | lib/ai/provider-consumption.ts:114,342,349,703 and 120 focused tests on 2026-10-23; source/contract evidence only.                                                                                                                                                                | -          |
| O5  | OpenAI-compatible discovery and the custom dialog connection-test hook omit configured custom headers.                                                                                                    | Verified     | Executed actual TypeScript function bodies with synthetic credentials and mocked I/O in .cache/lime-support-audit/probe.cjs; header omitted in both cases on 2026-10-23. UI calls inspected at custom-provider-dialog.tsx:237,247.                                                | -          |
| O6  | Lime cloud API documentation requires X-Lime-Tenant-ID and exposes tenant-specific /v1/models plus compatible Chat, Responses, Messages and Embeddings endpoints.                                         | Observed     | https://limeai.run/en/developers/llm/ retrieved 2026-10-23. No authenticated tenant request was made; linked limecore protocol documents returned 404.                                                                                                                            | -          |
| O7  | Lime exposes App Server JSON-RPC over stdio, Unix socket and WebSocket, and a CLI exec --json interface. Cognia already exposes a stdio codex-app-server adapter with configurable process launch.        | Verified     | Lime v1.167.0 cli/src/main.rs, exec/cli.rs, app-server-transport/src/transport/mod.rs; Cognia packages/agent-codex/src/app-server-client.ts:702. This establishes a candidate, not wire interoperability.                                                                         | O2         |
| O8  | Lime retains local HTTP server routes, while its shared-gateway settings page and desktop control commands are classified as dead-candidate and have no allowed paths.                                    | Observed     | v1.167.0 crates/server/src/lib.rs:1045 and src/lib/governance/legacySurfaceCatalog.json entries settings-api-server-page-entry and shared-gateway-control-commands. Current app-server, agent, runtime-core and CLI manifests do not depend on lime-server. Retrieved 2026-10-23. | O2         |
| O9  | No lime executable on PATH or /Applications/Lime.app was found.                                                                                                                                           | Observed     | command -v lime and standard macOS application-path metadata check on 2026-10-23; other install locations were not exhaustively searched.                                                                                                                                         | -          |
| H1  | Current Lime can be treated as the former local OAuth-to-API proxy.                                                                                                                                       | Invalidated  | O3 contradicts the OAuth pool premise; O8 prevents treating retained HTTP handlers as a verified current Desktop control flow.                                                                                                                                                    | -          |
| H2  | Cognia's generic provider configuration can consume Lime's cloud gateway without a dedicated integration.                                                                                                 | Contested    | O4 supports the chat configuration route; O5 and O6 expose onboarding/discovery gaps. Authenticated inference remains unmeasured.                                                                                                                                                 | O4 O5 O6   |
| G2  | Identify concrete techniques in Lime worth adapting to Cognia.                                                                                                                                            | Agreed       | User follow-up: 看看有没有什么学习的, 2026-10-23.                                                                                                                                                                                                                                 | -          |
| O10 | Lime browsing approvals bind owner/window/thread/session/turn, tab/view/webContents, page revision and exact tool arguments; browsing grants and dangerous actions are separate stages.                   | Verified     | v1.167.0 electron/browserPermissions.ts:7-28,88-109 and browserPermissions.integration.test.ts:62-105, read 2026-10-23. Source and test assertions inspected; upstream tests were not executed here.                                                                              | O2         |
| O11 | Lime gates hosted-tool flags by a conservative provider/protocol/host allowlist; this is policy, not capability discovery.                                                                                | Verified     | v1.167.0 model-provider/src/provider_capabilities.rs:39-80 and tests:116-205; runtime_provider.rs route-adapter availability tests. Source inspected 2026-10-23.                                                                                                                  | O2         |
| O12 | Lime encodes retired paths, commands and text boundaries in a catalog, with scanner violations causing exit 1.                                                                                            | Verified     | v1.167.0 legacySurfaceCatalog.json; scripts/lib/legacy-surface-report-core.mjs and its fixture tests; scripts/report-legacy-surfaces.mjs:63-68, read 2026-10-23.                                                                                                                  | O2         |
| O13 | Lime resolves clicked files by canonical session/workspace identity and invalidates pending results when request, thread, root or component lifetime changes.                                             | Verified     | v1.167.0 useWorkspaceFileOpen.ts and fileClick.component.test.tsx:137-255; FilePreviewTabContent.tsx:26-45. Source/tests inspected 2026-10-23.                                                                                                                                    | O2         |
| O14 | Cognia already has capability states/provenance, scoped browser site permissions, confined file-open requests with stale-read tests, architecture retirement gates and installed tarball consumer checks. | Verified     | Source reads and 4 local Jest suites / 34 tests passed on 2026-10-23; exact sources and limits below. No upstream runtime or packaged consumer command executed in this follow-up.                                                                                                | -          |
| G3  | Adversarially review the four learning recommendations and correct unsupported conclusions.                                                                                                               | Agreed       | User request on 2026-10-23.                                                                                                                                                                                                                                                       | -          |
| O15 | Both workbench and FileSpace file-open modules publish an older same-session open after a newer one when completion order reverses.                                                                       | Verified     | Fresh reviewer probe .cache/review-files-gates-stale-open/repro.cjs; independently rerun by root on 2026-10-23, publication order b.ts then a.ts in both modules. No UI acceptance.                                                                                               | -          |
| O16 | Provider operations already consume ResolvedProvider and inventory affinity includes headers; only particular projections lose them.                                                                      | Verified     | lib/ai/operations/handlers/discovery.ts:140,310,329 and existing providerRequest callers; root source checks on 2026-10-23.                                                                                                                                                       | -          |
| O17 | Approved updatedInput and explicit background-tab targeting are intentional behaviors, distinct from unauthorized mutation or stale authority.                                                            | Verified     | responses.ts:100-105; ai-sdk.ts:258-261; LocalEngineOptions.pageId:156-163; primary source checks on 2026-10-23.                                                                                                                                                                  | -          |
| H3  | A new unified provider resolver is required to address the reproduced header omissions.                                                                                                                   | Invalidated  | O16 shows the resolver and operation boundary already exist; narrower projections are the defect.                                                                                                                                                                                 | -          |
| H4  | Every argument or visible-tab change after browser approval should invalidate the operation.                                                                                                              | Invalidated  | O17 provides legitimate counterexamples; site consent and action settlement have different owners.                                                                                                                                                                                | -          |

## Problem frame

Follow-up frame: identify transferable implementation techniques in released Lime, compare each with Cognia's current owning source, and recommend only concrete improvements. No product changes or architectural migration are authorized by this research follow-up.

Determine what Cognia currently supports for Lime (A1), what upstream Lime actually exposes in the latest release (O2), and which integration route is supported by evidence. Success is a source-backed support matrix and a bounded next action (G1). Installation, credential import, model calls, implementation and deployment are outside this research task (C1).

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                                                   |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------- |
| scale        | medium | Cognia provider UI, resolution, native/runtime registration and upstream release/interfaces must be compared. |
| technical    | medium | API compatibility and App Server JSON-RPC are distinct integration surfaces.                                  |
| coupling     | medium | Browser/Tauri/Capacitor transport, custom headers and external agent lifecycle differ.                        |
| requirement  | medium | Product identity is stated as an assumption; provide both Cognia and upstream support views.                  |
| verification | high   | Source/contracts can be inspected locally; no Lime installation or authenticated tenant has been established. |
| risk         | low    | Read-only research plus this ledger; incorrect advice is controlled by scoped conclusions.                    |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                                                                                        | Severity | Source                                                                                | Claim                                                                                                                           | Refuted by                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Cached releases or historical ProxyCast descriptions misrepresent current support.                                                   | medium   | GitHub fresh API versus cached web latest; upstream provider retirement documentation | Pin upstream evidence to a release and classify retired surfaces.                                                               | Current release code exposes the allegedly retired production path.                                                                      |
| R2  | Generic API support is mistaken for proven Lime interoperability.                                                                    | medium   | Cognia provider transport/header code; upstream gateway tenant requirement            | Separate source-level compatibility, focused tests and authenticated acceptance.                                                | An advertised route omits required tenant headers, authentication or protocol behavior.                                                  |
| R3  | Lime CLI or JSON-RPC availability is mistaken for a registered Cognia agent runtime.                                                 | medium   | Cognia external-agent registry and upstream CLI/App Server contracts                  | Trace both runtime registration and lifecycle/protocol integration.                                                             | A reachable registered Lime adapter is found.                                                                                            |
| R4  | A feature list or upstream tests are mistaken for a proven Cognia gap or a verified upstream release behavior.                       | medium   | Cognia ADRs/current source versus Lime released source and tests                      | Each recommendation names its upstream mechanism, Cognia equivalent, remaining delta and limits.                                | Cognia already implements the claimed missing mechanism, or upstream ownership/evidence contradicts the recommendation.                  |
| R5  | The learning recommendations turn existing mechanisms or incomparable approval semantics into an unjustified implementation backlog. | medium   | Requested adversarial review; existing capability, browser, file and gate owners      | Fresh-context reviewers receive recommendations and factual constraints only; each finding is reconciled against owning source. | Existing equivalent coverage, mismatched semantics, unproven priorities or a smaller sufficient correction contradict the proposed work. |
| R6  | An earlier asynchronous file-open lookup overwrites the newer user navigation intent.                                                | medium   | Fresh reviewer and deterministic actual-source probe                                  | Same-owner navigation must preserve newer user intent when older lookup/stat finishes late.                                     | A then B with B completing first still publishes or focuses A last.                                                                      |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk | Method                                                                                                                                      | Independence   | Evidence                                                                                                                                                                                                                                                    | Coverage                                                                                                                                                              | Status |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| V1  | R1   | Compare fresh release metadata, pinned upstream docs and owning source paths.                                                               | tool           | Fresh GitHub connector release API: v1.167.0, 2026-10-22T13:35:17Z; pinned tree: 12,219 entries, truncated=false. Release source corroborates credential-pool retirement and retained-but-unproven HTTP surface.                                            | Released upstream version. Main was separately observed at a6bb253d178132a3a30a5e39ce87b6a21dea8abc; mutable main search was only supplementary.                      | passed |
| V2  | R2   | Trace Cognia custom provider save/resolve/discovery/test paths and required headers; run relevant existing focused tests.                   | tool           | pnpm test command below: 3 suites / 120 tests passed. node .cache/lime-support-audit/probe.cjs reproduced both omissions and verified the tenant header is permitted by policy.                                                                             | Generic source/contracts; the complete Lime onboarding route has a confirmed gap. No real model call, shell, CORS or multimodal acceptance.                           | passed |
| V3  | R3   | Inspect native provider and external agent registration plus Lime CLI/App Server protocols.                                                 | tool           | No named Lime preset/provider found. Existing Codex adapter only accepts stdio and performs initialize/initialized; Lime CLI dispatches AppServer and exec JSONL; pinned transport parser supports stdio/Unix/WebSocket.                                    | Structural candidate identified; no initialize/turn/approval/resume interoperability test.                                                                            | passed |
| V4  | R2   | Establish whether a real Lime instance and tenant credentials are available without reading secrets.                                        | real-env       | No lime executable on PATH or /Applications/Lime.app. No tenant credentials were provided or used; no credential stores were opened.                                                                                                                        | Standard installation locations only. Real acceptance unavailable in this research run.                                                                               | passed |
| V5  | R4   | Inspect released Lime mechanism and tests; compare owning Cognia modules, then separate new opportunities from existing equivalents.        | tool           | O10-O14 establish paired source comparisons; 4 local Jest suites / 34 tests passed. Findings and learning priorities below name existing equivalents and bounded deltas.                                                                                    | Browser approvals, capability route identity, file targets, retirement guards and packaged-runtime checks. No real upstream runtime acceptance or complete gap audit. | passed |
| V6  | R5   | Two fresh-context, read-only reviews of provider/browser and file/gate claims; independently check findings and revise the recommendations. | fresh-reviewer | Two first-cycle fresh-context reviewers returned source-backed findings; root reconciled them and independently reran probes. A third fresh-context reviewer inspected the revised artifact and reran the file probe: no material remaining error, cycle 2. | Source-backed recommendation audit, no live provider or native-shell acceptance.                                                                                      | passed |
| V7  | R6   | Reproduce reverse completion of two same-session opens in the actual file-opening modules, with deferred boundary I/O.                      | tool           | Reviewer and root independently executed .cache/review-files-gates-stale-open/repro.cjs: both publish b.ts then a.ts, final a.ts, exit 0.                                                                                                                   | Existing defect reproduced at module publication boundary; no product fix or full UI flow acceptance.                                                                 | passed |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                                                                                                                                                                                                                                       | Action   | Based on                     | Reversal trigger                                                                                      |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| D1  | 2026-10-23 | Research both named integration and generic compatibility, with released upstream evidence; no implementation.                                                                                                                                                                                                                                 | diagnose | G1 C1 O1 O2                  | User identifies another Lime product or requests implementation.                                      |
| D2  | 2026-10-23 | Deliver partial generic compatibility and no named native integration. For cloud access, fix generic header forwarding before claiming complete onboarding. For agent delegation, run a bounded stdio App Server contract spike before creating a new adapter. Do not recommend historical credential-pool or HTTP proxy startup instructions. | diagnose | G1 C1 O1 O3 O4 O5 O6 O7 O8   | Live protocol evidence, reachable local HTTP startup evidence, or upstream changes alter the route.   |
| D3  | 2026-10-23 | Re-enter comparative discovery for the user's follow-up; continue this ledger and inspect concrete mechanisms before recommending work.                                                                                                                                                                                                        | diagnose | G1 C1 O2                     | Source comparison shows the candidate is already equivalent or adds unjustified complexity.           |
| D4  | 2026-10-23 | Original shortlist; superseded by the adversarial review below. The broad resolver and blanket browser-priority interpretations must not become an implementation backlog.                                                                                                                                                                     | diagnose | G2 O4 O5 O10 O11 O12 O13 O14 | Implementation-level comparison or behavioral probes invalidate a proposed delta.                     |
| D5  | 2026-10-23 | Challenge the recommendation scope before treating it as implementation work; use the doubt-driven fresh-reviewer process and preserve the shared tree.                                                                                                                                                                                        | diagnose | G3 C1                        | Evidence supports a different scope or user explicitly requests implementation.                       |
| D6  | 2026-10-23 | Replace the broad learning shortlist with narrow header propagation and the reproduced pre-publication file-open race; browser work is a scoped design audit and retirement guards are conditional practice.                                                                                                                                   | diagnose | G3 O5 O15 O16 O17            | New behavioral evidence refutes a finding or establishes a different navigation or approval contract. |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                                             | From     | Why still open                                                                                                                                                                      | Next action                                                                                                                                                                                    | Status |
| --- | -------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| X1  | Authenticated Lime cloud inference, streaming/tool use and browser/Tauri/Capacitor transport have not been accepted. | H2 V2 V4 | No tenant or local Lime installation was used; contract tests cannot establish service compatibility.                                                                               | If implementation is requested, supply a test tenant and verify models, Chat/Responses/Messages, stream cancellation and tool-result continuation per selected protocol and shell.             | open   |
| X2  | Lime App Server may fit the existing Codex adapter, but its full wire/lifecycle contract is untested.                | O7 V3    | Similar method families and transports do not establish compatible parameter/event/approval semantics.                                                                              | Isolated spike: initialize, thread start/resume, turn start/interrupt, deltas, approval request/reply, error/exit cleanup and persistence; use synthetic fixtures before a real provider call. | open   |
| X3  | Local HTTP server code exists, but current product startup/readiness was not demonstrated.                           | O8 V1    | Deleted UI/control entries and no dependency from sampled current launch crates; stale server docs use nonexistent old paths and advertise routes absent from the inspected router. | Reopen only if local-proxy support is required; establish current composition root and released-binary listener before proposing an endpoint.                                                  | open   |
| X4  | Cloud protocol coverage is documented, not independently proven.                                                     | O6       | The public site's linked limecore protocol/architecture documents returned 404 to this session.                                                                                     | Use tenant-specific /v1/models and real endpoint responses as acceptance evidence; request accessible protocol contracts when needed.                                                          | open   |
| X5  | Learning recommendations need source comparison before being treated as an implementation backlog.                   | V5       | Paired source comparisons are recorded below. Only the header omissions are reproduced defects; the other recommendations remain design/test opportunities.                         | Comparison complete for this research scope; implementation requires its own behavioral acceptance criteria.                                                                                   | closed |
| X6  | Adversarial findings require source reconciliation before the learning shortlist stands.                             | V6       | Every finding was source-reconciled and the revised artifact passed a fresh-context second-cycle check with no material remaining issue.                                            | Review complete; product fixes remain tracked separately as X7 and X8.                                                                                                                         | closed |
| X7  | The reproduced same-session file-open ordering defect remains unfixed.                                               | R6 V7    | The user requested review, not product changes; the probe verifies publication ordering only.                                                                                       | If implementation is requested, define intent scope across callers and add failing behavioral regressions before fixing the existing owners, then verify the real UI journey.                  | open   |
| X8  | The reproduced OpenAI-compatible discovery and dialog diagnostic header omissions remain unfixed.                    | O5 V2 V6 | This was a research/review task; no product repair was requested or performed.                                                                                                      | If implementation is requested, add failing request-header regressions and repair the existing projections, then verify a real tenant separately.                                              | open   |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                                                            | How / when measured                                                                                    | Result                                                                                                                                                                     | Status |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | The user receives a current support matrix with source evidence and a next integration decision.                  | Research artifact and final response on 2026-10-23.                                                    | Matrix and next actions are recorded below; runtime readiness is explicitly carried in X1-X4.                                                                              | met    |
| M2  | The user can choose a small set of transferable improvements without duplicating existing Cognia capabilities.    | Comparative research delivery on 2026-10-23.                                                           | Four ranked opportunities and three existing equivalents are recorded below; no implementation was performed.                                                              | met    |
| M3  | Adversarial review distinguishes actionable defects from unsupported scope and preserves valid existing behavior. | Two independent-context reviews, source reconciliation and a corrected-artifact recheck on 2026-10-23. | Two review cycles completed. Narrow header and file-ordering findings retained; unsupported scope removed; final fresh-context reviewer found no material remaining issue. | met    |

## Findings and support matrix

Lime means [limecloud/lime](https://github.com/limecloud/lime), formerly ProxyCast, for this audit. Cognia has **no dedicated Lime integration**. Its generic provider path supplies some necessary primitives, with two confirmed header-forwarding gaps; its Codex App Server adapter is a plausible agent-integration candidate requiring a protocol spike.

| Surface                          | Upstream current evidence                                                                                                                                                                                                                                                                          | Cognia current support                                                                                                                                                                                                    | Conclusion                                                                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop and CLI/TUI              | Released Electron Desktop for macOS/Windows; CLI payloads for macOS arm64/x64, Windows x64 and Linux x64 GNU. Linux Desktop is paused.                                                                                                                                                             | No Lime preset, installation/detection service or lifecycle adapter was found.                                                                                                                                            | Standalone upstream product; no named native integration.                                                                                                                                                      |
| Cloud model API                  | Official site documents https://llm.limeai.run, API key plus X-Lime-Tenant-ID, tenant-specific models and OpenAI/Anthropic-compatible APIs.                                                                                                                                                        | Custom provider can save protocol, baseURL, key, model, apiFlavor and customHeaders. Chat resolution forwards the headers.                                                                                                | Source-level candidate: OpenAI baseURL https://llm.limeai.run/v1 or Anthropic baseURL https://llm.limeai.run/v1. Select model from the tenant catalog; do not copy historical model names. No live acceptance. |
| Cloud onboarding/model discovery | Tenant header is present in official Models and inference examples.                                                                                                                                                                                                                                | Discovery has no customHeaders input; both custom dialog and generic OpenAI lister omit it. Dialog connection test passes through a four-argument hook while the underlying probe accepts a fifth customHeaders argument. | Confirmed generic gap. Manual model entry may bypass discovery, but does not prove successful inference or fix the connection-test badge.                                                                      |
| Local HTTP proxy                 | The release retains Chat/Messages/Models/image routes. Old shared-gateway page/control commands are retired candidates; current startup was not established. The inspected router contains no /v1/responses or /v1/embeddings registration, despite an old server document advertising embeddings. | Any actually running compatible server could be configured as a custom provider.                                                                                                                                          | Do not advertise current local Lime proxy support from retained code alone. Do not assume the cloud and local endpoint sets are identical.                                                                     |
| OAuth/local CLI credential reuse | Provider docs and handlers retire the former pool and fallback.                                                                                                                                                                                                                                    | No Lime credential import or subscription bridge found.                                                                                                                                                                   | Historical Kiro/Qwen/Antigravity/Codex/Claude/Gemini pool advice does not describe current Lime.                                                                                                               |
| Delegate work to Lime Agent      | CLI exposes exec --json and App Server JSON-RPC with Thread/Turn/Item.                                                                                                                                                                                                                             | Existing configurable codex-app-server stdio adapter may be reusable. No Lime preset/acceptance found; generic HTTP/WebSocket protocol labels alone do not provide a working agent adapter.                               | Prefer a bounded contract spike over a new parallel runtime. CLI JSONL is not automatically ACP or the bidirectional App Server protocol.                                                                      |

### Concrete generic-provider gap

- `components/settings/provider/custom-provider-dialog.tsx:237`: connection test passes baseURL, key, protocol and model, omitting the dialog's customHeaders.
- `hooks/settings/use-connection-test.ts:44`: the hook also forwards only four arguments, although `packages/provider-core/src/providers/api-test.ts:100` supports customHeaders as argument five.
- `packages/provider-core/src/providers/model-discovery.ts:406`: input accepts only baseURL, apiKey and signal; constructed headers include only Content-Type and optional Authorization.
- `lib/ai/operations/handlers/discovery.ts:140`: generic discovery does not pass resolved provider.headers either.
- `lib/ai/provider-consumption.ts:349,703`: the chat path retains and forwards customHeaders, so a failed discovery/test badge is not evidence that saved chat configuration cannot carry the required header.

These are research findings. No product code or tests were changed to repair them.

## Verification record

Executed from the repository root on macOS on 2026-10-23:

```bash
pnpm test --runInBand --runTestsByPath \
  lib/ai/provider-consumption.test.ts \
  packages/provider-core/src/providers/model-discovery.test.ts \
  hooks/settings/use-connection-test.test.ts
```

Result: **3 suites passed, 120 tests passed**, no coverage run. pnpm reported Node v24.19.0 against the repository's >=26.0.0 engine requirement; the focused command exited 0. This is not full-repository verification.

```bash
node .cache/lime-support-audit/probe.cjs
```

Result: both missing-header behaviors reproduced by running the actual function bodies with mocked network/React boundaries; header-policy acceptance verified. No external request or real secret was used. The script lives in ignored local cache and is not a committed regression test.

CodeGraph was attempted but reported no index; investigation continued through rg and source reads. No indexing was performed. No product changes were made, so application lint/build/typecheck and UI acceptance were not required for this documentation-only research artifact. Real Lime acceptance remains unverified as X1-X4.

## Primary sources

- [Latest released version and assets](https://github.com/limecloud/lime/releases/tag/v1.167.0); freshness checked through the GitHub connector's releases/latest API rather than cached web redirects.
- [Released README: product surfaces, install and platforms](https://github.com/limecloud/lime/blob/v1.167.0/README.md).
- [Released Provider boundaries](https://github.com/limecloud/lime/blob/v1.167.0/internal/aiprompts/providers.md) and [credential-pool retirement](https://github.com/limecloud/lime/blob/v1.167.0/internal/aiprompts/credential-pool.md).
- [Released local HTTP router](https://github.com/limecloud/lime/blob/v1.167.0/lime-rs/crates/server/src/lib.rs#L1045) and [retired-surface catalog](https://github.com/limecloud/lime/blob/v1.167.0/src/lib/governance/legacySurfaceCatalog.json).
- [Released CLI dispatcher](https://github.com/limecloud/lime/blob/v1.167.0/lime-rs/crates/cli/src/dispatch.rs), [exec flags](https://github.com/limecloud/lime/blob/v1.167.0/lime-rs/crates/cli/src/exec/cli.rs), and [App Server transport](https://github.com/limecloud/lime/blob/v1.167.0/lime-rs/crates/app-server-transport/src/transport/mod.rs).
- [Official Lime cloud API contract](https://limeai.run/en/developers/llm/); public documentation only, not a live service result.

## Follow-up: transferable techniques

Comparison baseline: Lime release v1.167.0 at dfd780294df6c460da374df1ea911577273e8038 and the current Cognia checkout on 2026-10-23. The following shortlist was revised after adversarial review. Two concrete issues remain actionable: narrow header propagation and file-open publication ordering. Browser policy work requires a defined action/backend contract; retirement guards remain conditional practice. None is a claim that Lime is generally more mature.

### 1. Confirmed narrow defect: propagate configured headers at existing projection boundaries

Lime's [provider capability implementation](https://github.com/limecloud/lime/blob/v1.167.0/lime-rs/crates/model-provider/src/provider_capabilities.rs) applies a conservative provider/protocol/host allowlist. It is not capability discovery: it disables hosted-tool flags for a third-party gateway regardless of that gateway's actual implementation. Its [runtime route model](https://github.com/limecloud/lime/blob/v1.167.0/lime-rs/crates/model-provider/src/runtime_provider.rs) declares which adapters are implemented. These are useful boundary policies, not evidence of authenticated model, tenant or service readiness.

Cognia already models support, availability, provenance and unknown vendor-dependent operations in `packages/provider-core/src/operations/capability-matrix.ts`. `listProviderModels` already takes `ResolvedProvider` and includes headers in inventory affinity (`lib/ai/operations/handlers/discovery.ts:310,329`). The actual defect is narrower: `openAiCompatibleLister` drops headers when projecting into `discoverOpenAICompatibleModels`, while the custom-provider dialog and `useConnectionTest` omit the already-supported optional headers argument. Anthropic, Google and subscription OpenAI listers use the shared `providerRequest` path; they must not be included in a blanket missing-header claim.

Candidate acceptance: prove configured headers reach the existing OpenAI-compatible listing and dialog diagnostic requests without overriding managed authentication, and preserve URL/protocol/key behavior. Reuse the existing operation/resolution owners; no new resolver or capability engine is justified by these omissions. A specific authenticated Lime tenant failure, capability error or stale-cache result was not reproduced and must remain unverified.

### 2. Scoped design opportunity: distinguish site consent from action approval

Lime has two different owners: [browserPermissions.ts](https://github.com/limecloud/lime/blob/v1.167.0/electron/browserPermissions.ts) consumes browse-stage grants, while [browserTabHost.ts:1474-1582](https://github.com/limecloud/lime/blob/v1.167.0/electron/browserTabHost.ts#L1474-L1582) settles dangerous-action approval and checks exact approved arguments and native page identity. Its [integration tests](https://github.com/limecloud/lime/blob/v1.167.0/electron/browserPermissions.integration.test.ts) explicitly require an additional action token after browsing permission. A source-level invariant in one owner does not establish enforcement in every browser action/backend.

Cognia already has per-origin once/always/never site consent, conversation-owned tabs/takeover, snapshot invalidation and CDP grants. Action approval has separate settlement/execution owners in `sidecar/src/host/commands/responses.ts`, `sidecar/src/host/index.ts` and `sidecar/src/tools/adapters/ai-sdk.ts`; the action-review registry is only a projection. Generic `browser_click` does not itself declare per-call approval, while evaluate and credential fill do. A security review must first identify the exact action and engine and follow the approval result through actual dispatch.

The corrected matrix distinguishes unauthorized mutation from user-approved `updatedInput` (`responses.ts:100-105`), and display-tab changes from changes to the explicit approved target (`LocalEngineOptions.pageId`, `local-chromium-engine.ts:156`). Explicit background-tab operations may remain valid when the user changes the visible tab. Tests should reject authority/target changes that violate the selected contract, not every visual tab or argument change. No dangerous-action bypass was reproduced. This does not justify a new approval subsystem or a blanket P1 implementation task.

### 3. Conditional practice: guard a concrete retirement when it occurs

Lime's [retirement catalog](https://github.com/limecloud/lime/blob/v1.167.0/src/lib/governance/legacySurfaceCatalog.json), [scanner](https://github.com/limecloud/lime/blob/v1.167.0/scripts/lib/legacy-surface-report-core.mjs) and [negative fixtures](https://github.com/limecloud/lime/blob/v1.167.0/scripts/lib/legacy-surface-report-core.test.ts) reject reintroduced imports, old command names and forbidden production text. It protects a migration after its original author has left the context.

Cognia already enforces layer direction, forbidden dependencies, vendor isolation and a shrinking baseline. Those gates do not automatically prove the absence of every frontend IPC/fallback. When retiring a concrete entry point, add a negative fixture and a legal replacement fixture to the owning gate. No specific missing retirement rule was established, so this is not a current P2 backlog item. Lime's scanner extracts import/invoke patterns by regex from raw source (`legacy-surface-report-core.mjs:132-164`); copying it would lose precision relative to Cognia's existing AST extraction and can match comments or miss computed references. Named static-reference guards do not prove complete runtime unreachability.

### 4. Confirmed P2 defect: reject superseded file-open results before publication

Lime's [file-open owner](https://github.com/limecloud/lime/blob/v1.167.0/src/components/agent/chat/workspace/useWorkspaceFileOpen.ts) resolves session files through their own storage identity rather than matching a basename or reusing displayed cached content. A generation counter suppresses stale success and error results after a newer click, thread/root change or unmount. Its [click tests](https://github.com/limecloud/lime/blob/v1.167.0/src/components/agent/chat/workspace/fileClick.component.test.tsx) include empty files, same-name files in different directories and missing session identity.

Cognia already covers empty supplied text, stale viewer reads and existing editor buffer preservation. The original comparison also omitted the FileSpace owner: `lib/filespace/open.ts` is used by the conversation Files panel, session links and desktop deep links, and checks active session after asynchronous work. Those existing checks must be preserved.

Adversarial review found and reproduced a different race: `lib/files/edit-review-bridge.ts:122` awaits session lookup before publishing a reveal; `lib/filespace/open.ts:116` awaits stat and only checks the active session. With two same-session opens A then B, completing B then A publishes B then A and leaves A as the final target. The dock assigns its reveal id only on publication (`artifact-dock-layout-store.ts:549`), so downstream viewer request ids cannot recover original user-intent order.

Prospective correction: order navigation intents in their actual owning pane/session/lifetime before the asynchronous lookup, and reject a superseded result before publication. Scope the ordering across the relevant entry points; a new unrelated background operation must not globally cancel another pane's user intent. Deliberate cross-session reveals are valid (`dock-workspace.tsx:95`), so blanket session rejection is not a complete solution. Add a regression for A/B completion reversal, plus the relevant session/lifetime transitions. No product fix or full UI acceptance was performed.

The deterministic probe is `.cache/review-files-gates-stale-open/repro.cjs`. It runs the actual transpiled source modules with deferred lookup/stat and publication observers; both modules returned publication order `[b.ts, a.ts]`. The root reviewer independently reran it successfully. It is a finding probe, not a committed regression test.

Upstream test attribution is narrower than the original reading: its scope-switch case settles success, its unmount case rejects, and the cited file-click test has no dirty-editor-preservation assertion. Test names are not proof of the full success/error Cartesian product.

### Existing Cognia capabilities to preserve

- **CLI and GUI sharing a protocol:** Cognia ADR-0171 and generated CLI command indexes already establish this direction. Lime's common App Server reinforces it rather than creating a new requirement.
- **Artifact persistence/versioning:** Cognia ADR-0158, Dexie bridges and version history already provide the underlying feature. Improvements should address concrete provenance/lifecycle defects rather than duplicate storage.
- **Installed-package verification:** `scripts/build/pack-test-agent-package.mjs` installs real tarballs into an external consumer and checks ESM/CJS/types/runtime seams. `scripts/smoke/agent-sdk-bundled-host.mjs` packs and installs the SDK/native host and checks readiness. Lime's `scripts/app-server/cli-npm-gate-b.mjs` also stages a launcher/payload and drives CLI/TUI, but this does not establish an absent Cognia packaging discipline. A useful next extension would be an installed-host end-to-end turn if existing release acceptance does not already cover it.

### Evidence limits

Upstream test source is evidence of intended invariants, not execution evidence from this session. In particular, the committed [v1.167.0 final-gate-b-r6 record](https://github.com/limecloud/lime/blob/v1.167.0/internal/exec-plans/artifacts/release-v1.167.0/final-gate-b-r6.json) records exitCode 1 for one browser annotation run. This is not proof that the whole release is broken, nor can these source reads establish that every scenario passed. The lesson is to retain the exact platform, artifact, scenario and result with a readiness claim.

Local baseline verification on 2026-10-23:

```bash
pnpm test --runInBand --runTestsByPath \
  lib/file-viewer/open.test.ts \
  packages/provider-core/src/operations/capability-matrix.test.ts \
  lib/browser/domain-authorization.test.ts \
  lib/policy/action-review/registry.test.ts
```

Result: **4 suites / 34 tests passed**. These verify selected existing Cognia contracts. They do not exercise the browser-extension approval executor, full file-click journey, packaged consumer installation or Lime itself. No product source, runtime configuration or user data was modified.

## Adversarial review and reconciliation

The review contract was to disprove the proposed learning shortlist, preserve intentional behavior, and distinguish a reproduced defect from an architectural preference or untested upstream invariant. The first cycle used two fresh-context read-only reviewers: one for provider/browser claims and one for file/gate claims. They received the artifact, constraints and owning source pointers, without the ledger Decisions or design narrative. Root checked the findings against the actual source and independently reran both finding probes. A third fresh-context reviewer checked the corrected shortlist in cycle 2, reran the file race probe, and reported no material remaining issue. The stop condition was met after cycle 2.

| Finding                                                                                                  | Classification     | Reconciliation                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Broad provider-unification recommendation restates an existing operation boundary.                       | valid + actionable | Narrow to header projection at the OpenAI-compatible lister/helper and custom-provider dialog/hook. Existing ResolvedProvider and inventory affinity remain the owners.                          |
| Lime's official-host allowlist was being treated as capability knowledge.                                | valid + actionable | Describe it as conservative policy. A compatible third-party gateway can implement hosted tools even when the Lime flags are false; tenant readiness requires separate evidence.                 |
| Browser site-consent tests do not establish dangerous-action settlement correctness.                     | valid + actionable | Name the action, engine and actual settlement-to-dispatch chain before designing assertions. No Cognia bypass or blanket P1 fix was established.                                                 |
| Unconditional rejection of changed arguments or visible tabs would break legitimate approved operations. | valid + actionable | Preserve user-approved updatedInput and explicitly addressed background tabs; test unauthorized mutation, stale authority and unintended implicit-target changes under the chosen contract.      |
| Existing viewer request-id checks do not prevent reverse publication of earlier file opens.              | valid + actionable | Actual-source probe confirms the same-session race in workbench and FileSpace. Future fix belongs before publication in the navigation intent owner, with scope/lifetime defined across callers. |
| Empty-file, stale-read and dirty-buffer cases were being generalized into missing coverage.              | valid + actionable | Preserve existing tests and implementations; focus on the reproduced earlier publication race and cross-entry-point transitions. Include lib/filespace/open.ts and its callers.                  |
| Upstream file-click test names were broader than their actual success/error assertions.                  | valid + actionable | Correct the attribution: source-inspected examples are not proof that every combination or dirty-editor case is tested.                                                                          |
| Retirement gates advice lacks a specific missing rule and raw-text scanners have precision limits.       | valid + actionable | Keep it conditional on an actual retirement; require a negative fixture plus a legal replacement fixture in the appropriate existing gate. No new backlog or catalog justified.                  |

No reviewer identified a material counterexample to the existence of Cognia's shared CLI contract, artifact version storage or installed-consumer checks. That conclusion remains limited to existence and inspected behavior; no complete runtime parity or current packaged acceptance is asserted.

### Review verification

```bash
node .cache/lime-support-audit/probe.cjs
node .cache/review-files-gates-stale-open/repro.cjs
```

Root executed both probes on 2026-10-23. The first reproduced missing header propagation; the second reproduced `[b.ts, a.ts]` publication for A-then-B user requests in both actual file-open modules. The mocked boundaries replace network/lookup/stat and observe publication; no user data, real model call or native browser was involved.

Additional focused checks in this review:

```bash
pnpm test --runInBand --runTestsByPath \
  components/settings/provider/custom-provider-dialog.test.tsx \
  hooks/settings/use-connection-test.test.ts \
  packages/provider-core/src/providers/model-discovery.test.ts \
  lib/ai/operations/handlers/discovery.test.ts

pnpm test --runInBand --runTestsByPath \
  browser-extension/src/lib/agent/site-permissions.test.ts \
  browser-extension/src/lib/agent/executor.test.ts \
  components/file-viewer/file-preview-surface.test.tsx \
  lib/filespace/open.test.ts
```

Results: **4 suites / 95 tests passed**, then **4 suites / 57 tests passed**. The second command emitted an existing React `act(...)` warning from the viewer test; exit status was 0. Both commands reported Node v24.19.0 versus the repository's >=26.0.0 engine requirement. These passing tests coexist with the deterministic finding probes; they do not disprove the uncovered gaps or establish native UI acceptance.

The optional cross-model offer required by `doubt-driven` was presented to the user. The user explicitly selected “仅完成当前审查” on 2026-10-23. No external CLI or other model invocation was performed. The completed review remains a same-model, independent-context source/probe review.

### Corrected disposition

- **Retain as concrete work:** narrow generic header propagation; superseded file-open publication ordering. Neither product defect was fixed in this research task.
- **Retain as a scoped investigation:** browser action/engine approval semantics, with explicit expectations for edited input and tab targeting.
- **Keep conditional:** retirement regression guards when a named surface is actually retired.
- **Preserve existing mechanisms:** capability provenance/unknown states, FileSpace/viewer/editor ownership, shared CLI contracts, artifact history and packed-consumer checks.
