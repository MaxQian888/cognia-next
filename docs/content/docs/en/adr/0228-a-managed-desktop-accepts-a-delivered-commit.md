---
title: "0228 — A managed desktop accepts a delivered commit"
description: "A Host-owned E2B desktop reuses the computer-server lifecycle and exclusive control lease, accepts an immutable code delivery, and records private, bounded evidence with deletion tied to its task."
---

# ADR 0228 — A managed desktop accepts a delivered commit

Phase 1 implementation note (2026-10-15): the initial operator smoke harness qualifies network `Off` only. `On`/`Allowlist` remain explicitly unqualified in the contract, UI and tests; non-null region selection refuses until placement can enforce it. Real-provider smoke has not been authorized or run. Native compilation was blocked by disk exhaustion and skipped at the user's direction. See `docs/plans/2026-10-15-managed-cloud-desktop-phase1-verification.md` for the evidence and remaining gates.

**Status:** Accepted — user approved ADR-0228, Phases 1–4 and the trusted-source prerequisite on 2026-10-15. Real-provider smoke still requires separate credentials and explicit authorization; production remains dormant until qualification.  
**Date:** 2026-10-15  
**Scope:** Linux browser and Linux GUI acceptance, user-owned E2B account, desktop and headless execution Hosts, authenticated clients. No required region in v1.  
**Related:** [0020](./0020-computer-use-completeness), [0055](./0055-agent-browser-loop), [0072](./0072-browser-action-recording), [0153](./0153-the-host-obtains-the-confirmation), [0182](./0182-a-project-names-the-image-it-runs-in), [0183](./0183-the-agent-is-brought-to-the-image), [0196](./0196-a-library-crate-links-tauri-only-when-asked), [0213](./0213-conversation-history-has-a-manager-and-the-archive-freezes-place), [0221](./0221-a-remote-sandbox-is-a-provider-behind-the-same-seam).

## Decision

Use **E2B with a digest-pinned Cognia computer-server image**, prepared in the user's E2B account by the selected Host. Extend `SandboxProviderAdapter`, the existing desktop lease and viewer. Do not expose a second provider-specific GUI path. Production capability remains disabled until an explicitly authorized real-provider smoke verifies the image, authentication and native kill-on-expiry behavior.

A human authorizes each billable desktop. A child acceptance execution tests an immutable delivered commit, reports an agent verdict and optionally a separate human approval. It never merges code or completes the originating task. Checkpoint/failure screenshots are bounded, owner-private and deleted through the task/conversation's canonical deletion path.

The four delivery phases are lifecycle adapter, authenticated control/viewer, task handoff, and linked results. Phases 3 and 4 require the separate delivery-ledger work to be merged first. Phases 1–4 implementation, including trusted delivery provenance, are authorized; Phase 4 is authorized after the committed history/deletion baseline was verified.

## Context: extend the two paths without conflating their owners

The code-task path in `crates/cognia-sandbox-pool/` uses remote E2B/Kubernetes providers, pinned runtime images and the agent bundle. The GUI path uses `lib/sandbox/lifecycle-contract.ts`; its only production adapter is `docker:computer-server`. `cua-cloud` and `lume` are intentionally absent from `adapter-registry.ts`.

Current desktop code already provides a 15-second renewable human lease, shared agent/human mutation mutex, frame validation and quarantine after uncertain input cleanup (`cua_sandbox/desktop_session.rs`). `use-sandbox-desktop.ts` and `sandbox-desktop-viewer.tsx` already implement takeover UI. They lack cloud owner/device authority and durable provider cleanup. The native client currently constructs `ws://host:port/ws` and expects Cognia's authenticated protocol. Registering a cloud factory alone cannot supply those missing guarantees.

The following evidence was read from the shared tree on 2026-10-15, including foreign uncommitted work. It is not all present in this isolated documentation worktree:

| Reuse boundary | Owning paths | Required extension |
| --- | --- | --- |
| Lifecycle and typed refusal | `lib/sandbox/{lifecycle-contract,adapter-registry,connection-lifecycle,connection-capabilities}.ts` | Remove Docker-only factory/output assumptions narrowly; retain state/capability checks and no local fallback |
| GUI/workspace target consistency | `types/sandbox/index.ts`, `lib/sandbox/{binding,session-runtime}.ts` | One child acceptance binding for GUI and shell/files; leave source task binding intact |
| Native desktop control | `crates/cognia-automation/src/cua_sandbox/` | Provider-neutral resource access, protected cloud transport, principal-bound lease |
| Host consent | `crates/cognia-companion/src/host_consent.rs`, `crates/cognia-companion-security/src/admin_lease.rs` | Reuse authenticated approval and revocation; never trust caller `confirmed` flags |
| Code delivery, pending integration | `crates/cognia-sandbox-pool/src/{delivery.rs,docker/remote_prep.rs}` | Consume the merged record contract, not concurrent files or reusable agent IDs |
| Git and preview | `crates/cognia-sandbox-pool/src/{git_proxy.rs,docker/ports.rs}`, `crates/cognia-companion/src/environment_ports.rs` | Explicit read-only Git mode; live preview remains dormant |
| History teardown | `lib/chat/{session-archive-writes,session-deletion}.ts`, `lib/db/sessions.ts` | Durable evidence deletion intent in the canonical routed cascade |

ADR-0055/0072 browser recording is an optional explicit acceptance input, not a transferable browser session or proof of success. DOM refs expire with their engine generation; cookies and password values are not copied. ADR-0183's agent bundle is not a desktop image and must not become an unrelated prerequisite for GUI startup. ADR-0196 places all new Rust behavior in crates, not app-shell modules.

## Alternatives and current provider evidence

The survey distinguishes published capability from a tested integration. Sources were retrieved on 2026-10-15. No credential, resource creation or provider smoke was used for this design.

| Provider | Lifecycle / control | Isolation and existing server | Pricing / TTL / region | Decision |
| --- | --- | --- | --- | --- |
| E2B Desktop / custom template | Create/connect/inspect/kill; stock desktop SDK offers screenshot/input and VNC | Firecracker VM boundary; custom Linux image is supported, Cognia image compatibility awaits smoke | Public CPU/RAM metering; Hobby 1 h, Pro 24 h; US/EU/APAC advertised, exact account region must be verified | First provider, custom computer-server rather than a new native GUI driver [S1–S7] |
| Cua hosted Fleet | Docs describe claims, renewal, release, gateway and 15 min default claim TTL; no cloud suspend/restart | gVisor container or KubeVirt VM; current image uses cua-spacesd, not Cognia's hardened server | Account-specific hourly rates; hosted regions/availability unconfirmed. Homepage says Cua does not host/rent machines, conflicting with cloud docs | Dormant pending verified availability and protocol [S8–S10] |
| GCP VM + desktop | Instance lifecycle; Linux desktop service or Windows RDP, separate agent input API required | VM can host Linux server/container in principle | Shape/region, disk and network billing; native duration/deadline with DELETE, 30 s–120 days, up to 30 s delay initiating termination | Credible BYO-cloud fallback, more image/network operations [S11–S13] |
| AWS EC2 + VNC/xrdp/DCV | Run/inspect/start/stop/terminate; display protocol distinct from computer-server | Linux VM/server feasible in principle | Region/shape + disk/network; DCV license included on EC2. No simple kill TTL identified in reviewed RunInstances API; external termination mechanism required | Larger operational scope and TTL qualification gap [S14–S17] |

A native E2B screenshot/input driver would require a new control driver and a second proof of lease/frame/quarantine semantics. Keeping Cognia's server reuses the established protocol. Running a raw VNC/RDP endpoint alongside it would allow input outside the lease and is not permitted. Cua's existing type name is not reused for E2B.

## 1. The authenticated owner and selected Host own the desktop

The authoritative identity is `(ownerPrincipalId, executionHostId, providerConfigId, desktopId, generation)`. An acceptance record adds source conversation/task/run and delivery IDs. The Host derives owner and device/service principal from authenticated context; browser arguments cannot select someone else's account. Provider billing identity is separate from Cognia ownership.

Store versioned `managed-desktops.json` beside `remote-sandboxes.json`, with owner-scoped providers, default placement, limits, release/template bindings and enablement evidence. Desktop and headless Hosts use the same domain service. Reuse credential-source and attestation concepts rather than the code sandbox's image/bundle-oriented `RemoteProvisioner`. Existing code provider configuration is not implicitly a desktop configuration.

Desktop domain logic extends `cognia-automation/src/cua_sandbox/`; new managed-resource/journal modules are justified because Docker's in-memory registry supplies neither cloud reconciliation nor evidence storage. Extract reusable E2B HTTP/build primitives from the currently private `cognia-sandbox-pool/src/remote/e2b/api.rs` into a small Tauri-free `cognia-e2b` crate, consumed by both providers. Keep code-runtime preparation and desktop policy separate; do not import the whole sandbox-pool driver into automation. This extraction must preserve the code provider's behavior and its focused contract tests.

Provider keys are write-only Host secrets referenced by `managed-desktop:<owner-scope>:<provider-id>`. Server env/file sources require an administrator-controlled owner mapping. Provider keys, Git credentials, model keys and Cognia device tokens never enter the renderer, guest, handoff manifest or logs. The computer-server endpoint secret is a separate, narrowly scoped credential: generated by the Host, held by the trusted server, stripped from workspace children and never returned to a browser. This distinction is necessary to authenticate the server without delegating the provider account.

Credential rotation and provider deletion disable new work first. Keep cleanup authority for owned live resources until absence is confirmed; deleting a settings row cannot forget billed resources. Account/Host switching clears renderer projections and revokes control. Same-provider credentials on another Host do not convey permission to adopt this Host's desktops.

## 2. Distribute an immutable release into each user's E2B account

Cognia publishes a Linux image addressed by OCI digest plus a release manifest shipped through the existing trusted release channel. It names image digest, architecture, computer-server version/protocol, build recipe revision and expected health identity. Never use `latest` as a runtime identity.

On first explicit user-authorized setup/use, the Host verifies the registry manifest/content digests, then builds the pinned recipe in the selected user's E2B namespace. Cache the resulting template ID and **exact build ID**, indexed by account binding, image digest, recipe revision, architecture and resource shape. E2B supports launching a specific build instead of a mutable tag. Reuse requires that exact registered build and Host-recorded provenance; an unrelated template with a matching label is not sufficient. [S4, S18, S19]

The current code provider's shortened digest alias and any-ready-build lookup are insufficient for this check. Its digest verification is for the agent-bundle download, not a desktop provenance guarantee. The current client also has no verified account/team identity lookup. Bind templates to the Host's owner/provider credential generation and explicitly selected namespace; use a provider-verified stable account ID when the API supports it. Credential changes invalidate this binding unless account continuity is verified. Never treat alias access alone as account identity.

The Host records build intent before calling the provider and reconciles uncertain builds rather than submitting duplicates. Bound concurrent builds per binding; startup never eagerly builds or warms a desktop. Template preparation and its possible provider charges are shown separately from desktop compute; they require explicit user authorization, not an agent recommendation or background settings refresh.

Create uses the exact build reference. Admission checks release/image/recipe/protocol and resource shape; health checks the expected server identity before GUI access. Digest/version mismatch, missing build, unsupported architecture or absent provenance yields an actionable refusal. Never silently reuse an old template. Runtime identity plus a trusted build receipt is an integrity check, not hardware attestation against the provider or the user's provider-account administrator.

An explicitly authorized smoke may provision the pending build through a restricted administrative probe while production create remains disabled. Its authority is bound to that owner/config/build/shape/deadline, uses the same journal and cleanup, and cannot become an agent bypass. Store smoke evidence with that exact configuration; changing image, recipe, protocol, ingress, egress or region invalidates affected evidence and requires requalification. Old templates are not automatically deleted: retain mapping for existing cleanup, and offer explicit template cleanup separately.

## 3. Admission shows cost and rejects impossible lifetimes

V1 policy permits at most **2 concurrent desktops per owner/provider on one Host**, with a **3,600-second hard lifetime** and **600-second idle timeout**. These are the defaults and upper bounds; configuration may tighten them, never raise them. No persistence, pause/resume or automatic restart in v1. The provider's plan allowance is checked independently: Pro's 24-hour allowance does not extend Cognia's 60-minute limit. Reject a request exceeding either limit and identify the applicable constraint; never truncate it.

Hobby permits at most 3,600 seconds; Pro at most 86,400 seconds in the surveyed documentation. Compare the complete requested duration with the account's allowed duration before creation. Reject over-limit requests with requested and allowed values, not a silent truncation. Unknown/stale entitlement cannot authorize a higher limit. The provider's rejection is authoritative, and must never trigger a retry with a shorter duration. [S2, S3]

No account-entitlement or price API is assumed to exist. Phase 1 must verify available read-only APIs. If entitlement discovery is unavailable, an operator-confirmed, dated account-plan binding supplies the preflight limit; actual create rejection remains fail-closed. Unknown bindings block creation. A plan change invalidates the binding when detected. Do not create disposable billed resources to infer plan limits in the background.

Before the user's Create action, display selected CPU/RAM, region, rate/currency/source timestamp, requested lifetime and the estimated maximum desktop compute cost over that lifetime. Host validates a short-lived quote bound to the configuration; material changes require a new confirmation. Calculate `ratePerHour × lifetimeSecs / 3600`, rounded upward for display. Public example: 2 vCPU and 4 GiB cost approximately **$0.1656/hour**, hence approximately **$0.17 for 60 minutes**, from the surveyed rates. Plan subscriptions, taxes, template preparation and other provider charges are separately disclosed, not hidden within an asserted invoice cap. Unknown price prevents a normal create until a dated estimate is configured. [S2]

This is a compute estimate under the provider TTL guarantee, not an absolute financial guarantee during provider billing/TTL failure. All create-to-destroy runtime counts, including readiness time. A confirmed shorter idle lifetime can reduce actual cost. Capacity remains occupied while create/delete outcome is uncertain. Limits are not coordinated across Hosts: multiple Hosts using one E2B account can exceed two total desktops and the displayed single-session estimate is not an account-wide budget. V1 accepts and labels this limitation.

## 4. Creation consent and control leases are separate authorities

An agent may suggest acceptance and prepare a proposed manifest. It cannot prepare a billable template, create a desktop, or mint its own creation authorization. A user action obtains a Host-recorded, single-use authorization bound to owner, source, quote, provider and deadline. Trusted request provenance and principal permissions distinguish human control surfaces from delegated agent/service calls; a boolean `userInitiated` is not proof. Duplicate requests return the same recorded operation, not another desktop. Unknown outcomes are reconciled under that authorization.

Settings and escalated administration reuse ADR-0153's recorded consent/admin leases, including Owner/service-root rules and member non-self-approval. These exemptions do not grant a task agent standing permission to spend. A worker receives only the delegated authority for the already-authorized acceptance execution. The existing automation policy/consent path remains in force for sensitive actions; the headless Host uses the Host consent/event service rather than assuming Tauri's ConsentBroker works remotely.

Extend the existing input lease with owner, Host, device/agent principal, acceptance ID, desktop generation and fencing epoch. Keep the 15-second lease and five-second renewal. One controller at a time; authorized observation does not require ownership of input. Every mutation revalidates the current fence and frame at the Host, including after an awaited operation.

Human takeover fences new agent operations, releases held buttons and waits for confirmed quiescence under the shared mutex. Uncertain cleanup quarantines the desktop, refusing the new controller. A second human cannot silently steal control. Disconnect, account switch, revocation, expiry and Host restart invalidate the lease. Reconnect does not automatically resume the agent. Explicit release/resume obtains a fresh frame. Deadline/destroy preempts all control.

Phase 2 enables only manual human control after a separate GUI qualification receipt, bound to the same configuration and exact template as lifecycle qualification. Agent input and production acceptance delegation stay dormant through Phase 3 until Phase 4 and qualification. A user control request obtains one ADR-0153 admin lease scoped to acquire/renew/release/input; the viewer reuses it without background prompts. Admin expiry stops input and requires an explicit new request. A fresh 15-second control lease does not extend admin authority. Headless sensitive-action consent uses the existing Host consent prompt and persisted automation policy, with corrupt policy refusing control.

Use the existing viewer/hook and authentication-aware Host RPC. Do not simply expose current Client/Internal commands remotely. Browser clients receive a Host-authorized frame/input channel, never provider account keys, E2B traffic tokens or a separately interactive VNC link. Protected cloud transport uses TLS, bounded URLs/redirect policy and server identity validation. Test guest authentication with provider ingress authentication present and the Cognia server token absent; provider 403 alone is not proof that the guest rejects unauthorized calls.

## 5. The lifecycle journal survives an unavailable Host or provider

Reuse `SandboxProviderAdapter` and public lifecycle states. Add a durable Host journal for resource truth, not a parallel UI lifecycle system. Separate resource state, controller lease, acceptance outcome and cleanup state.

| Transition | Durable behavior and recovery |
| --- | --- |
| Admit/create | Validate owner, authorization, quote, template, entitlement, policy and capacity. Persist creation identity and reservation before provider call. Request finite TTL with `onTimeout=kill` and auto-resume disabled; verify effective settings |
| Create outcome unknown | Retain reservation; reconcile ownership metadata and operation/build identity. Do not blindly resubmit. If uniqueness cannot be established, block and expose reconciliation status |
| Connect/running | Verify exact owned resource/generation, remaining hard deadline, protocol and decoded screenshot. Reconnect neither creates nor extends lifetime |
| Idle | No live acceptance work or authorized interactive activity for 600 s triggers destroy. Screenshot/health polling is not activity; a stalled acceptance has bounded progress timeout and cannot renew forever |
| Deadline | Fence input and new work, cancel execution and stop evidence capture, then destroy. Any bounded flush must fit within the remaining time; no grace can extend provider TTL |
| Destroy retry | Keep resource, quota and cleanup authority until confirmed absent. Mark `destroyRetrying`, disallow reuse; use 15-second initial retry with exponential backoff capped at 600 seconds |
| Restart | Reconcile only recorded/labelled resources of this owner and Host deployment. Recover pending destroys and deadlines; never recover old input tokens or rerun acceptance automatically |

The Host uses an absolute deadline and passes the remaining duration on reconnect. Native provider TTL is the Host-death backstop; it must **kill**, not pause, preserve a snapshot or auto-resume on access. Time passing or a failed status request is not confirmation of deletion. Provider absence must be observed before freeing a reservation. Ownership labels and journal generation prevent one Host from sweeping another Host's resources.

State updates are revisioned and atomic before acknowledgment. Keep cancellation and bounded retries on shutdown; no unowned detached tasks. Surface pending cleanup even when the feature is disabled. Rollback disables new work, not cleanup. Monitor oldest pending create/delete, billed-resource count, refusal code and evidence backlog; alert on any resource beyond its deadline plus 60 seconds, and on cleanup older than 10 minutes. Use bounded provider/status dimensions, never filenames/tokens in metrics.

## 6. Placement reuses isolation attestations and refuses weaker execution

Add provider `e2b` with driver `computer-server`; do not change the meaning of `cua-cloud`. Explicit provider selection is authoritative. `auto` means the configured eligible managed-desktop default on this Host, not code-pool spillover, a cheaper account or the user's local desktop.

Re-admit owner, release, region, shape, remaining quota, capabilities, isolation minimum and network policy on the Host. Persist requested/actual placement and enforcement status with acceptance evidence. Reuse ADR-0221's tier vocabulary and egress attestations; a code E2B adapter's attestation does not automatically prove this image/product/transport is qualified.

Restrict public ingress and block private/link-local/metadata egress. Domain policies must state E2B's documented limits: HTTP Host on port 80 and TLS SNI on port 443; other ports need CIDRs and QUIC is not domain-filtered. Refuse unimplementable required policies; never silently widen egress for install scripts, Git or a preview. Host-brokered Git/file transfer is scoped to the authorized source, not a general Host network tunnel. [S5, S6]

## 7. A handoff is a new acceptance execution of immutable source

**Dependency D1:** delivery commit `ff3c51c617deb351caf07415d25d4b59467e6fe0` is merged. The user subsequently authorized completing its missing source authority, then Phase 3. Original authenticated admission now persists owner/Host/device, conversation/task, a Host-minted coding-run ID, normalized repository and a Host-only credential reference; each delivery binds that source ID. The conversation's original run reference is captured once as `originRunRef`, separate from the Host-minted authority, and never authorizes a later browser assertion. Legacy source-less records refuse. Source tombstones survive restart; canonical deletion revokes on the recorded source Host before losing its durable link. The implementation is uncommitted in the isolated Phase 3 checkout; native tests are written but skipped by user instruction. See `docs/plans/2026-10-15-managed-cloud-desktop-phase3-verification.md` for evidence. Phase 4 implements the final history projection and result deletion under the same dormant release boundary.

The Phase 3 diagnostic binds `parentRunId` to the Host coding run and preserves `originRunRef` for later history projection. It creates a separate child/source/delivery/desktop-generation record and hashes the full handoff manifest plus the transfer manifest. Production execution remains disabled. Its only executable entry is the native `handoff-smoke` operator, requiring explicit paid permission and per-quote approval, and always requesting desktop destruction. Metadata preparation never spends. The initial launch is an explicit `npm run <script>` at the pinned repository root, with no implicit install. Image recipe 3 adds Git/nodejs/npm and invalidates older recipe qualification. Full Git history is transferred; the selected-file denylist is not a repository-history sanitization filter.

Create a child acceptance execution; never rebind the source task. Its versioned manifest includes owner/Host, source conversation/task/run/delivery IDs and delivery revision, exact commit, branch label, transfer mode, acceptance-file hashes, launch argv/cwd, test criteria, resource generation and deadline. Phase 3 supports same-Host published-commit reconstruction and recovery-bundle import. Cross-Host transfer and live-preview tunnels remain dormant.

**Published commit:** authorize the delivery, resolve the repository via the Host, fetch through an explicit **read-only Git proxy**, checkout the exact SHA and verify it. Branch names are locators, not acceptance identity. The existing proxy permits pushes to a task branch; phase 3 must implement a distinct read-only mode that rejects receive-pack discovery and POST requests before upstream contact. Do not change existing code-task publishing permissions. Test direct/smart-HTTP push variants, redirects and repository substitution, not just the happy clone.

**Recovery bundle:** resolve the Host file by authorized delivery ID, never by a browser-provided path. The current export is incremental Git data with a 512 MiB bound, not a full filesystem snapshot; fetch approved prerequisite objects through the read-only proxy, verify bundle/hash/commit, import into private staging and checkout the exact SHA. Missing prerequisites, dirty/unrecoverable source or mismatched hash refuses. Implement bounded chunked transfer rather than force the bundle through the existing 8 MiB desktop upload. Reserve disk before transfer, enforce cumulative size/hash and remove partial staging on cancellation.

Acceptance files are an explicit manifest limited in v1 to **100 files and 32 MiB total, 8 MiB per file**, separate from the bundle cap. Reject traversal, symlink escape, special files and overwrite outside the acceptance root. Preserve secret placeholders; do not copy `.env`, local browser profiles, cookies or vault data automatically. Launch uses argv, not concatenated shell text. Private application login is a separate user-controlled action, not authorization to export provider/Git credentials.

The desktop starts its own preview application from the pinned checkout. A source task's `localhost` URL is not portable. A supplied public preview URL may be descriptive context but is not silently used as the tested source. Live-preview forwarding would need overlapping source/desktop leases, exact port authority and a source-unavailable outcome; those remain explicitly unavailable in v1.

## 8. Evidence is bounded, private and owned by the original history

Use a durable acceptance record linked to source owner/Host/conversation/task/run/delivery and exact tested commit, desktop generation and manifest digest. Keep it separate from `TaskDeliveryRecord.publish` and the best-effort automation audit. Project its references into existing task/run history and artifact surfaces rather than persisting screenshot bytes in messages or database list rows.

Reuse `types/execution/run.ts`'s verification artifact, counts and opaque `detailsRef`, with `artifact.created` in the acceptance run. Set `parentRunId` to the coding run and preserve `sessionId`/`sourceId`. `lib/db/execution-runs.ts` rejects events after a terminal run: do not reopen or append to the completed coding run. The authoritative result remains readable when 30-day run-event retention removes old events; evidence follows source task/conversation retention, not the event TTL. A later human approval is a separate revisioned record, not an illegal append to a terminal run. Cancellation uses the run cancellation outcome, not a fabricated verification enum value.

Record criterion results and distinct `passed`, `failed`, `inconclusive`, `cancelled` outcomes. Agent verdict and human approval have separate principal/time provenance; one never overwrites the other. Provisioning failure, expired source, missing required evidence or incomplete criteria cannot pass. A later source commit requires a new acceptance run. Publication outcome and cleanup status are independent: saved evidence plus pending destruction is representable.

Capture only explicit checkpoints and failures. V1 caps each acceptance at **100 screenshots, 100 MiB total and 8 MiB per image**, whichever is reached first. Enforce encoded byte limits, supported formats and decoded pixel bounds at ingestion; failed/partial uploads count against bounded staging. Do not delete early evidence to silently fit more. Report `evidence_limit_reached`; a required screenshot that cannot be retained makes the affected criterion incomplete and the result inconclusive. No continuous recording or screenshots captured while the human enters sensitive values unless explicitly requested.

Evidence files use the Host's owner-scoped artifact storage/access rules, opaque identifiers, content hashes and durable manifests. Apply the owning storage encryption policy and restrictive filesystem permissions; UI may not address arbitrary paths. Stage, hash and atomically publish files before marking result complete. Retry completion idempotently. Screenshot retrieval and export recheck owner/history authorization. No default share link, automatic public upload, cross-account deduplication or model submission. Existing model/tool flows retain their PII gate; text redaction does not claim to sanitize arbitrary screenshot pixels.

Use the containment/opaque-ID patterns in `automation/record/assets.rs` and authenticated session-media access as precedents, not recording bundles or browser Dexie as a second owner. Evidence reads use `Cache-Control: no-store`; revoke in-memory/object-URL previews on deletion and account change. Do not copy the existing session-media one-year immutable cache header. Do not promote screenshots to `library:`/kept ownership, which would defeat the requested deletion cascade. No system can revoke a screenshot a user deliberately exported or independently copied.

The prohibition on automatic model submission applies to stored checkpoint/failure evidence. Live agent perception still uses the existing explicitly authorized computer-use model path and its image/privacy policy; storing an artifact grants no additional model-upload permission.

### Deletion follows ADR-0213, including offline and crash recovery

Archive is retention: it preserves results without reviving an acceptance run. Actual conversation/task deletion revokes viewing/control and removes its evidence. The entry remains `deleteSessionsRouted` → owning Host intent or `deleteSessionsWithTeardown` → the authoritative database cascade, not an independent viewer delete button. Task deletion must invoke the same owned-evidence cleanup contract, including descendants.

Extend that cascade with a durable deletion outbox containing owner, source identity, acceptance IDs and opaque artifact IDs **before metadata references are lost**. Handoff locks and other canonical delete guards run first; a refused delete cannot remove evidence. The database delete and outbox insertion share the owning transaction where possible; a Host-native store uses an acknowledged idempotent journal bridge, never claims a cross-database atomic transaction. Host replay reconciles authoritative deletion state before releasing bytes.

The existing cascade does not include `executionRuns`, `executionRunEvents` or `runResultSummaries`; phase 4 must explicitly resolve/remove the owned acceptance projections and native evidence. Do not rely on the best-effort sync tombstone API as the cleanup queue. Register retention/cleanup with `lib/storage/retention.ts` and the owning Host startup service; the renderer's retention initializer cannot provide headless cleanup. Pending cleanup survives ordinary sync-tombstone expiry.

Once deletion is committed, tombstones immediately deny access and fence late captures/result writes. A background Host worker cancels live acceptance, destroys desktops and deletes files/staging/manifests, retrying after crashes or filesystem failure. Queued remote deletion is not reported as already physically complete. Keep a minimal non-content tombstone/outbox until cleanup is confirmed; expose pending/failed cleanup. A startup sweep reconciles bounded staging and tombstoned files. There must be no untracked orphan files, and an offline Host is shown as pending rather than falsely deleted.

Deleting either the owning source task/conversation or the acceptance run removes that acceptance's screenshot bytes; other surviving history links become an explicit deleted-evidence state. No implicit screenshot duplication into exports/backups in v1. User-requested external exports cannot be remotely erased and must say so when exported. Never recreate a deleted task/result from a late provider event.

## 9. Dormancy and compatibility are release contracts

| Inert feature/state | Type/contract axis | UI axis | Test axis |
| --- | --- | --- | --- |
| E2B pending setup/smoke | `unqualified` reason and false runtime capabilities | Disabled create with actionable setup/smoke reason | No paid create or fallback without authorization/qualification |
| Later implementation phases | Independent lifecycle/control/handoff/results capability gates | Explain unavailable action, do not offer a working-looking control | Registry + actual Host dispatch + UI refusal tests |
| Project automatic acceptance | Explicit unsupported trigger policy; agent suggestion has no spend authority | “Automatic acceptance unavailable”; suggestion requires user action | Agent/background/reconnect cannot build template/create desktop |
| Live preview/cross-Host handoff | Unsupported transfer modes | Disabled and labelled | Host rejects forged mode; no credential/tunnel fallback |
| Persistent/pause/resume and Cua/Lume | Existing/new capability declarations stay false | Localized unavailable labels | Adapter/capability tests pin refusal |

Docker rows and behavior remain compatible. Increment capability revision only for shipped operations; preserve handshake narrowing. Old clients refuse an unknown provider rather than coercing to Docker. Host state is authoritative; client caches are sanitized, target/owner scoped and revisioned. Any required Dexie projection migration uses the established migration protocol and does not reserve a schema version in this ADR.

Phase 1 can qualify lifecycle internally without exposing unfinished GUI; phase 2 can offer manual desktop use under explicit creation authorization. Phase 3 handoffs remain a developer-disabled route until phase 4's durable evidence/deletion completion is enabled. Each phase still has reachable test/diagnostic entry points, not an unreferenced module advertised as complete. Disable flags keep status/delete/reconciliation available.

## Verification and rollout

The detailed plan is `docs/plans/2026-10-15-managed-cloud-desktop.md`. Every phase includes co-located TS tests/in-file Rust tests, both split i18n locales for UI/refusals, a `cognia-next` changeset and `wiring-auditor` review. Run targeted checks only; no full test suite or coverage. Check `df -h` before cargo compilation. New Rust domain logic stays in crates with Tauri-only wiring behind the appropriate feature.

Real-provider smoke requires the user's credentials and explicit go-ahead, including exact account, shape, deadline and estimated spend. It must cover private-template build/provenance and mismatch refusal; authorized/unauthorized transport; screenshot/input; Host restart/reconnect without lifetime extension; delete retry; and **a short provider TTL expiring while the Host controller is stopped**. Reconnect/inspect must prove the resource was killed, not paused and not auto-resumed. Mock tests do not establish this guarantee. An over-limit Hobby request must refuse with its reason without silently becoming a one-hour request.

Enable per owner/provider only after relevant smoke and contract checks pass. Any cross-owner access, lease bypass, credential exposure, wrong-source verdict or TTL failure blocks enablement and disables new work. Preserve cleanup and historical evidence during rollback. Phases 3/4 cannot begin before D1's merge; deletion-cascade changes also wait for the current history work to merge to avoid competing edits.

## Phase 4 implementation boundary (2026-10-15)

The user authorized Phase 4 after the source provenance work. D2 is satisfied by the committed history/deletion contracts at `eca3bd038b56d378f35a87e03b8b503e4cb3c313`, present in the isolated checkout base `6f52d4f356d477f2786ad57c41442878417ffa35`; the corresponding paths in the shared checkout were clean before implementation. No foreign work was copied or edited.

The Host now owns an encrypted acceptance index and bounded encrypted checkpoint/failure images. The binding retains source/conversation/task/Host coding run/original run reference, immutable delivery revision/commit, manifest digest and desktop generation. Agent verdicts, diagnostic system outcomes and revisioned human approvals are separate. Production agent delegation remains hard-disabled pending qualification; the paid diagnostic can retain a checkpoint and an **inconclusive system outcome**, never invent an agent verdict. Reads and deletion remain available while creation is dormant.

Run detail and source-conversation overview query the owning Host and project a child verification artifact into existing execution history, without changing a terminal parent. Images are requested explicitly, delivered with `Cache-Control: no-store`, integrity checked and displayed through revocable in-memory URLs. Screenshot bytes, local paths and bearer URLs never enter run events or browser persistence. The native backup copier explicitly excludes `managed-desktop-evidence`; no share/export path is added.

ADR-0213 deletion uses a v244 account-local, content-free outbox plus an acknowledged native prepared/committed/aborted journal. A prepared operation freezes evidence; a rejected/rolled-back transaction aborts it. An offline Host leaves durable pending cleanup, not a false claim that remote bytes are already gone. Committed deletion permanently fences late writes, removes acceptance projections and retries physical byte/desktop cleanup. Conversation, task and acceptance-only paths converge on this mechanism; archive retains evidence. Task-only restart replay uses the canonical backend with the **original persisted device constraint**, not absence in local HOME as proof. Multi-Host conversation cleanup obtains task IDs from each owning Host after source revocation. Pending work is retained beyond ordinary sync tombstone expiry.

Implementation and targeted evidence are recorded in `docs/plans/2026-10-15-managed-cloud-desktop-phase4-verification.md`. Rust tests are written but not run at the user's request. Browser/Tauri/provider end-to-end qualification is not claimed; all paid smoke still requires user credentials and explicit authorization.

## Integrated review boundary (2026-10-16)

Lifecycle requests revalidate the current account, admin lease, provider configuration and credential generation after queued work and immediately before paid provider requests. Once a resource is created or deletion is accepted, its durable cleanup authority survives caller logout. Lifecycle, handoff and result clients require the registered or paired Host configuration to name the currently unlocked account; unknown legacy ownership is refused. Browser clients invalidate in-flight work on account/lock or Host configuration changes, including changes that later revert. Original delivery Host bindings remain device-local in account sync.

Acceptance writes use Host semantic idempotency: the generic security store binds the request key and payload hash, but stores no result/error body or operation receipt. Every retry passes current authorization and evidence deletion fences again. Screenshot retries return the original bound artifact rather than taking another frame. Results selected from another task and older approval responses cannot replace the current view.

Git import commands run in a process group that is terminated on success, failure, cancellation or future disposal. Non-Unix Hosts reject this import before spawning Git until equivalent process-tree containment is implemented; this is a Host limitation, separate from the Linux guest scope. It does not weaken fixed-commit/read-only Git or recovery-bundle validation.

The integrated review and current `dev` integration conflicts are recorded in `docs/plans/2026-10-16-managed-cloud-desktop-integrated-review.md`. Rust, rendered UI and real-provider qualification remain unverified, and production gates remain dormant.

## Review record

| Date | Scope | State |
| --- | --- | --- |
| 2026-10-15 | Linux, BYO provider account, no region constraint | User confirmed |
| 2026-10-15 | E2B/pinned server; commit + bundle; 2/60 min/10 min; user-triggered; private checkpoint/failure evidence | User confirmed, including template, entitlement, cost, dependency and deletion requirements |
| 2026-10-15 | This ADR's concrete contracts and detailed phase plan | Accepted by the user; Phases 1–4 and trusted-source prerequisite authorized; real-provider smoke not authorized |

Remaining external evidence is an enablement gate, not an invented guarantee: supported E2B account identity/entitlement APIs, actual template provenance fields, secure WebSocket behavior, provider-native expiry and region eligibility. Phase-1 owner resolves these with documented APIs and an authorized smoke before enabling. The product owner accepted this ADR and authorized Phases 1–4 and the trusted-source prerequisite on 2026-10-15; no release deadline is agreed.

## Sources

Retrieved 2026-10-15; recheck account entitlements and prices before spending. The related ADRs and exact owning paths above are repository evidence; delivery/history dependency commits and the remaining qualification gates are recorded in the phase reports.

- **S1:** [E2B computer use](https://docs.e2b.dev/use-cases/computer-use) — Linux screenshot/input and VNC.
- **S2:** [E2B pricing](https://e2b.dev/pricing) — $0.000014/vCPU/s and $0.0000045/GiB/s; Pro base fee $150/month plus usage; runtime plan limits. The 2-vCPU/4-GiB example is arithmetic, not a measured required shape.
- **S3:** [E2B lifecycle](https://docs.e2b.dev/sandbox) and [billing limits](https://docs.e2b.dev/billing) — timeout, kill, pause and continuous runtime limits.
- **S4:** [E2B base images](https://docs.e2b.dev/template/base-image) — supported custom Linux images.
- **S5:** [E2B ingress protection](https://docs.e2b.dev/network/restrict-public-access) — traffic-access token and protected public URLs.
- **S6:** [E2B internet access](https://docs.e2b.dev/network/internet-access) — deny/allow and domain-filter limits.
- **S7:** [E2B deployment regions](https://e2b.dev/) and [Firecracker isolation](https://e2b.dev/resources/introducing-e2b-embed).
- **S8:** [Cua cloud guide](https://cua.ai/docs/cua-sdk/guides/cloud) — claim lifecycle and runtimes.
- **S9:** [Cua Fleet images/rates](https://cua.ai/docs/cua-sdk/reference/fleet/images).
- **S10:** [Cua homepage](https://cua.ai/) — BYO-computer positioning; hosted availability remains unresolved.
- **S11:** [GCP runtime limits](https://docs.cloud.google.com/compute/docs/instances/limit-vm-runtime).
- **S12:** [GCP RDP](https://docs.cloud.google.com/compute/docs/instances/connecting-to-windows), [Linux desktop](https://docs.cloud.google.com/architecture/chrome-desktop-remote-on-compute-engine).
- **S13:** [GCP machine shapes](https://docs.cloud.google.com/compute/docs/general-purpose-machines), [regional pricing](https://cloud.google.com/products/compute/pricing/general-purpose?hl=id).
- **S14:** [EC2 RunInstances](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_RunInstances.html), [TerminateInstances](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_TerminateInstances.html).
- **S15:** [EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/).
- **S16:** [Amazon DCV administrator guide](https://docs.aws.amazon.com/pdfs/dcv/latest/adminguide/dcv-ag.pdf).
- **S17:** [EC2 stop/start storage costs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/how-ec2-instance-stop-start-works.html).
- **S18:** [E2B exact-build references](https://docs.e2b.dev/template/tags) — build ID pinning and mutable tags.
- **S19:** [E2B template build](https://docs.e2b.dev/template/build) — account-key build and returned template/build IDs.
