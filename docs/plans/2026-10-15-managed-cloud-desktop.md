# Managed cloud desktop and GUI acceptance — phased implementation plan

**Date:** 2026-10-15  
**Status:** ADR-0233 and Phases 1–4 implementation approved by the user on 2026-10-15. The user subsequently authorized completing trusted provenance and Phase 3; source and handoff implementation are recorded in the Phase 3 verification report. Rust validation is skipped by request. Real-provider smoke awaits user credentials and separate explicit authorization. Production remains dormant until qualification.  
**Decision:** [ADR-0233 (English)](../content/docs/en/adr/0233-a-managed-desktop-accepts-a-delivered-commit.md), [ADR-0233 (Chinese)](../content/docs/zh/adr/0233-a-managed-desktop-accepts-a-delivered-commit.md).  
**Scope:** Linux GUI/browser, user-owned E2B account, same-Host commit/bundle handoff, user-triggered billing, owner-private bounded evidence.  
**Delivery owner:** Host/automation maintainer; each package below has one responsible role. Dates for implementation are not assigned before ADR approval and dependency merges.

## Entry gates and dependency ownership

Phase 1 source implementation and bounded verification are recorded in [the Phase 1 report](./2026-10-15-managed-cloud-desktop-phase1-verification.md). Final native compilation and provider qualification are not claimed.

| Gate                                | Responsible role                     | Required evidence                                                                                                                                                                  | Work permitted before gate                                                       |
| ----------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| D0: ADR agreement                   | Product owner                        | Explicit user approval of the final bilingual ADR; record date and any revisions                                                                                                   | Documentation/research only                                                      |
| D1a: Delivery ledger merge          | Sandbox maintainer, separate session | Satisfied on 2026-10-15 by `ff3c51c617deb351caf07415d25d4b59467e6fe0`; final contract still requires D1b provenance readiness                                                      | Satisfied; Phase 3 also requires D1b                                             |
| D1b: Trusted source provenance      | Task/Host authority maintainer       | Implemented in the isolated Phase 3 checkout; native tests written but not run; no implementation commit yet                                                                       | Dormant handoff implementation and offline checks authorized                     |
| D2: History/deletion integration    | History maintainer, separate session | Satisfied: committed contracts at `eca3bd038b56d378f35a87e03b8b503e4cb3c313`, present in checkout base `6f52d4f356d477f2786ad57c41442878417ffa35`; shared paths clean before edits | Phase 4 authorized in isolated checkout; qualification still pending             |
| D3: Provider smoke authorization    | User plus Host maintainer            | Named user-supplied account/config, credential location on Host, region, shape, short provider-valid TTL and estimated spend explicitly approved                                   | Mock/fixture/contract work; never consume credentials or create a cloud resource |
| D4: Per-configuration qualification | Host maintainer                      | Smoke receipt bound to release/image/recipe/protocol, provider credential/account binding, ingress/egress/region and shape                                                         | Feature remains unqualified and disabled for normal use                          |

D1a is satisfied by merged delivery commit `ff3c51c617deb351caf07415d25d4b59467e6fe0`. The user authorized implementing D1b, followed by Phase 3. Trusted admission/source persistence and handoff now live together in the isolated integration checkout; they must land together, and legacy source-less deliveries still refuse. See [the original readiness report](./2026-10-15-managed-cloud-desktop-phase3-readiness.md) and [implementation evidence](./2026-10-15-managed-cloud-desktop-phase3-verification.md). D2 was verified before the authorized Phase 4 implementation; see the Phase 4 report.

Use a detached worktree for any overlap with foreign edits. Before each package, inspect scoped status and the current owning source. Only stage/commit owned paths. Reallocate ADR/schema identifiers if another branch claims them before integration. No stash, shared-tree reset, branch switch or tree-wide formatting. This documentation worktree starts at committed HEAD and intentionally omits foreign implementation changes.

## Accepted invariants to test, not merely document

1. One selected Host owns lifecycle, credentials, control, acceptance and cleanup. Principal scope comes from authenticated context.
2. Production provider is `e2b:computer-server`; every action retains `SandboxProviderAdapter` capability/state checks and no host-desktop fallback.
3. A human authorizes each billed create/template setup. Agent suggestions, startup, reconnect and project policies cannot create resources.
4. One controller, 15-second lease, five-second renewal; fresh frame/fence after takeover and no agent resume on reconnect.
5. V1 defaults and upper bounds: two desktops per owner/provider/Host, 3,600-second hard TTL, 600-second idle. Configuration may tighten these values, never raise them; Pro's longer provider allowance does not extend the v1 limit. Provider expiry kills, never pauses/resumes.
6. Explicit over-plan lifetime is rejected, never clipped. Host-local concurrency is labelled as such; no account-wide quota claim.
7. Image digest, build recipe and exact E2B build identity must match. Mutable aliases and arbitrary ready builds are not provenance.
8. Handoff checks out an exact commit through read-only Git or verifies an incremental recovery bundle; source task binding is unchanged.
9. Agent result and human approval are distinct. No merge/source-task completion side effect.
10. Evidence: 100 screenshots, 100 MiB total, 8 MiB each; no continuous recording, no default share link, no separate kept/library ownership.
11. Archive retains; committed task/conversation deletion revokes and durably removes evidence. Late events cannot resurrect it.
12. Every dormant capability is documented at the type, labelled in UI and pinned by tests.

## Package sequence and enablement

| Package                               | Depends on   | Owner                       | Exit proof                                                       | Normal-use enablement                                                 |
| ------------------------------------- | ------------ | --------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| P1 — E2B lifecycle and template       | D0           | Host lifecycle maintainer   | Contract tests and D3/D4 smoke                                   | Qualified lifecycle only; GUI/handoff/results remain false            |
| P2 — Host control and existing viewer | P1           | Automation maintainer       | Principal/lease/UI tests, authorized GUI smoke                   | Manual user-created desktop use may be enabled                        |
| P3 — Code delivery handoff            | P2 + D1      | Sandbox/task maintainer     | Immutable source, read-only Git, bundle and child-run tests      | Handoff stays production-disabled until P4 evidence/deletion is ready |
| P4 — Durable evidence and history     | P3 + D1 + D2 | History/evidence maintainer | Complete acceptance-to-history and deletion/restart verification | Enable acceptance per owner/provider after full narrow E2E            |

Each package contains a `cognia-next` changeset, its relevant English/zh-CN split i18n keys, co-located tests and wiring review. Runtime flags are independent but enforced by the Host as well as the UI. Flags never disable cleanup/status of already-created resources.

## P1 — One qualified provider behind the existing lifecycle seam

### P1.1 Contracts and shared provider transport → verify refusal and Docker compatibility

**Own:** `types/sandbox/index.ts`; `lib/sandbox/{lifecycle-contract,adapter-registry,connection-capabilities,connection-migration,connection-lifecycle}.ts` and their co-located tests; native E2B HTTP boundary; protocol source manifests.

- Add the E2B provider config and qualification status, keeping driver `computer-server`. Generalize Docker-shaped factory/outcome/client assumptions only where a second adapter requires it.
- Retain `runSandboxOperation`, typed failures, running-state GUI/workspace guard, provider/config consistency and sticky capability narrowing. Keep old Docker rows working; unknown providers must not coerce to Docker.
- Extract authenticated/bounded HTTP and template API primitives from private `crates/cognia-sandbox-pool/src/remote/e2b/api.rs` into a Tauri-free `crates/cognia-e2b/`. Keep the old code provider as a consumer with unchanged behavior. New crate justification: both desktop and code providers need the existing private client without a dependency on the whole code runtime or duplicated API/auth logic.
- Keep desktop domain modules in `crates/cognia-automation/src/cua_sandbox/`; use native modules for durable journal, configuration and resource operations. `src-tauri` only registers/wires commands. Do not start a new lifecycle API independent of the TS seam.
- Define versioned Host requests/responses/events and capabilities in their source manifests, then regenerate artifacts. Preserve explicit owner/Host routing in web, Tauri and headless contexts.

**Targeted tests:** lifecycle-contract, adapter-registry, connection-capabilities/migration/lifecycle suites; in-file transport fixtures for errors/redaction/presigned uploads; existing E2B API tests plus Docker regression tests. Prove cloud registration cannot route GUI locally.

### P1.2 Image distribution and provenance → verify a specific build, not an alias

**Own:** hardened image release recipe under `crates/cognia-automation/src/cua_sandbox/image/`, release manifest, desktop template modules and their in-file tests; release wiring only when needed for this image.

- Publish an immutable release image by digest through the agreed release distribution. Manifest pins architecture, protocol and recipe revision. Do not introduce an unrelated publish/release system.
- Explicit user action prepares the template in the selected user's account. Verify OCI descriptors/content; construct a deterministic full-digest/recipe/shape key. Build/register with the Host credential; persist intent and provider build IDs before polling.
- Launch exact `template:build-id`, never `default`/`latest`/any-ready build. Record account credential generation, namespace, template/build IDs, full digests and verification receipt.
- Handle cached/missing/mismatching/failed/in-progress/unknown builds, credential rotation, concurrent preparation and crash reconciliation. No background warm template builds. Keep provider secrets out of image layers/build args/logs and presigned upload headers.
- Verify current official account identity/provenance APIs and document unsupported fields; do not implement a fictitious lookup. Account continuity must be verified to reuse across credentials.

**Tests:** alias collision/tag reassignment, wrong digest/recipe/build/architecture/shape, credential generation change, duplicate build request, unknown result, partial upload, and authenticated server compatibility. Existing sandboxd bundle validation does not count as computer-server validation.

### P1.3 Ownership, cost quote and creation consent → verify no background spend

**Own:** managed-desktop Host config/secret resolution, settings model/UI and same-directory tests; new split i18n source under `settings.managedDesktops.*` after checking current namespace ownership.

- Separate `managed-desktops.json` with owner scopes, Host default provider, limits and qualification; write-only secret references. Never repurpose remote-sandboxes config as an undocumented union.
- Resolve the verified account cap if available. Otherwise require a dated operator-confirmed plan binding, label it accordingly, and retain authoritative provider refusal. No plan guessing from a key or automatic paid probes.
- Build a short-lived quote over shape/region/rate version/lifetime/provider. Show hourly estimate and maximum desktop compute estimate, with plan/template/other charges separately disclosed. Unknown/stale estimate requires refresh/reconfirmation.
- Host records a single-use human creation/setup authorization and idempotency key. Agent/service identity cannot self-authorize through `confirmed` or `userInitiated` fields. A delegated acceptance worker can use only its existing bound authorization.
- Enforce the v1 upper bounds and independent account-cap rejection without truncating or retrying a shorter lifetime. Explain that two-concurrent limit is per owner/provider on this Host, not shared across Hosts.

**Tests:** cross-account configuration/read/create, changed quote, replayed authorization, expired quote, operator plan binding vs actual provider refusal, Hobby and Pro 3,601 s rejection under v1 policy, isolated entitlement validation for Hobby 3,601 s and Pro 86,401 s, attempted concurrency/idle-limit increases, unknown entitlement, forged user flag, agent suggestion/reconnect/background build refusal, redacted errors and scoped secret rotation.

### P1.4 Durable lifecycle and secure transport → verify cleanup survives process death

**Own:** managed-resource journal/reconciler and transport modules in the automation crate, Host boot/shutdown wiring and diagnostics. New files are justified by missing durable cloud state, not a general new framework.

- Persist create intent/reservation, owner/Host/generation, resource ID, immutable absolute deadline, template identity and cleanup revision. Atomic writes/fsync before acknowledgment; list reconciliation by trusted ownership.
- Create native kill TTL, disabled auto-resume; verify returned effective settings. Protected HTTPS/WSS with bounded trusted endpoint resolution, sensitive headers and no redirect credential forwarding.
- Guest protocol check includes a valid provider ingress token with missing/incorrect guest token, so provider-edge rejection cannot hide an unauthenticated server.
- Idle timer excludes health/frame polling; hard deadline preempts all work. Reconnect uses remaining lifetime. Delete uncertainty retains quota; retry 15 s up to 600 s; restart resumes cleanup without stale controllers.
- Cleanup remains operational if settings disable the provider or normal operation is rolled back. Credential removal cannot strand a live resource. Publish sanitized states and threshold alerts named in ADR.

**Tests:** timeout before/after provider allocation, create response lost, duplicate request, wrong ownership labels, Host restart, TTL settings mismatch, idle vs active work, clock/deadline handling, delete 404 vs timeout/403, capacity retention/release, endpoint poisoning, two-layer auth, shutdown cancellation and unknown lifecycle operation.

### P1.5 Qualification smoke → verify native kill, with separate user authorization

The smoke command is restricted to an explicit owner/config/build and uses ordinary journaling/cleanup while production remains disabled. The report includes exact versions/digests, region, resource IDs, observed states and cleanup outcome, excluding tokens.

1. Obtain D3; display setup/compute estimate and selected short provider-valid TTL. Never reuse ambient credentials without the user's stated destination/account.
2. Build or verify the exact user-account template; reject a deliberately mismatched requested version before normal create.
3. Create protected desktop, prove unauthenticated ingress and guest calls fail, then obtain valid frame and protocol health.
4. Reconnect and observe unchanged original deadline. Test explicit delete and a controlled delete retry using a bounded test interruption, not a provider-wide outage.
5. Create a short-TTL test resource; stop the Host controller before expiry. After expiry, independently inspect and attempt connection through the authorized test harness. Verify absent/killed state and no pause/snapshot/auto-resume. Record the measured expiry observation; cleanup all remnants.
6. Verify over-plan admission refuses without clipping; save qualification receipt only if all required checks pass. If provider state cannot be established, remain disabled and show cleanup pending.

**Exit:** scoped tests pass, i18n is fresh, D4 exists for enabled configuration, no live orphan, wiring-auditor confirms Host boot/registry/settings/cleanup reachability. Otherwise phase is implemented-but-unqualified with all three dormancy labels.

## P2 — Extend the existing viewer and control authority

Implementation and bounded validation are recorded in [the Phase 2 report](./2026-10-15-managed-cloud-desktop-phase2-verification.md).

Authorized by the user on 2026-10-15. Native builds remain skipped at the user's request after ENOSPC; this limits validation and does not qualify the provider. Phase 2 has a separate GUI qualification receipt; lifecycle qualification alone never enables input. Agent control remains dormant through the Phase 3 diagnostic rollout; production delegation needs Phase 4 and qualification. Reuse a single user-requested admin lease across acquire/renew/release/input and fail closed on its expiry. No automatic admin lease renewal or acceptance creation.

**Own:** `desktop_session.rs`, `remote_client.rs`, `registry.rs`, automation Host routing, `lib/automation/sandbox-client.ts`, `hooks/automation/use-sandbox-desktop.ts`, `components/settings/automation/sandbox-{desktop-viewer,connection-sheet,connections-tab}.tsx`, corresponding tests, source protocol/ACL declarations.

1. Bind lease to authenticated owner/Host/device-or-agent/acceptance/desktop-generation and fence. Reuse mutex, 15 s expiry, 5 s renewal, frame checks and uncertain-cleanup quarantine.
2. Route the existing viewer through the selected Host. Permission to observe is separate from input. Authentication loss/Host change invalidates pending input and late acquire responses; reconnect does not resume control.
3. Human takeover rejects new agent actions, releases held buttons and proves quiescence before granting control. Competing human needs explicit release/expiry; no UI-only lock.
4. Keep sensitive action policy/consent in the Host path. Verify headless requests reach `HostConsentPrompt` via the existing consent event/read pattern. Admin leases do not confer persistent input authority.
5. Use authenticated Host frame delivery with ephemeral frame buffers. No public VNC link or direct provider traffic token. Desktop shell/files must bind to the same connection.
6. Add accessible controller/observer/status/expired/quarantine states and keyboard/focus behavior. Extend existing components; no second cloud viewer. Unsupported mobile interaction is explicitly disabled until tested; authenticated observation can reuse the same surface.

**Verify:** two devices plus agent, overlapping mutation/takeover, expired fence, stale frame/coordinates, capture await race, reconnect, explicit release/resume, tab hidden/unmount, revoked principal, Host restart, input cleanup uncertainty, deadline preemption. Run scoped viewer/hook/native/protocol tests and authorized real GUI smoke. Mock Chromium or local Docker checks must be labelled as such.

**Exit/rollback:** manual cloud desktop use only when P1/P2 qualified. Disable control on failure, revoke leases, retain delete/status/reconciliation. Add a phase changeset and both locale keys under existing automation settings namespaces.

## P3 — Accept a merged delivery through read-only source transfer

**Implementation authorized after D1a:** the user explicitly extended scope to complete D1b first. The isolated checkout contains both changes and the dormant Phase 3 transfer. [The verification report](./2026-10-15-managed-cloud-desktop-phase3-verification.md) records the exact base, source files and evidence limits. Host-minted coding-run identity is authoritative; the original conversation run reference is retained separately and never grants source authority. Production execution and agent delegation still require Phase 4 and qualification.

1. Resolve authorized delivery by immutable record ID, not agent ID. Capture source owner/Host/session/task/run, delivery revision and commit. Reject missing identity, foreign Host/account or conflicting source.
2. Create a versioned handoff manifest and child acceptance run with `parentRunId`, `sessionId`, `sourceId`; record a fresh desktop binding. Original terminal coding run and its placement are not mutated.
3. Add `readOnly` Git proxy authority explicitly. Allow only approved repository upload-pack discovery/POST; reject every receive-pack discovery/POST before upstream call. Preserve code-task branch-limited publishing mode and test both.
4. Published path: fetch authorized objects, checkout exact SHA, verify HEAD, materialize explicitly selected files, and start preview/test with argv and controlled cwd/env. Moving branch cannot change tested commit.
5. Bundle path: resolve Host-local bundle by delivery ID; preflight 512 MiB cap and disk reservation; fetch allowed prerequisite objects, verify bundle/hash/source commit, stream with cumulative limits, import into private staging. Resume/retry by operation identity; remove incomplete staging on cancellation/deadline.
6. Acceptance-file limits: 100 files, 32 MiB aggregate, 8 MiB each. Validate paths/symlinks/special files/overwrites and hash exact bytes. Do not implicitly transfer `.env`, profiles, credentials or recorded password values.
7. Expose human-triggered acceptance proposal/cost/criteria UI. Agent suggestions are informational. Live preview, project-auto policy and cross-Host transfer stay false at contract, UI and tests.

**Verify:** wrong account/Host/delivery/run, stale revision, replaced branch, missing SHA, read-only proxy push/query variants and redirect/URL substitution, missing bundle base, corrupt/oversize/truncated bundle, missing source Host, traversal/symlink/special file, command quoting, duplicate request, deletion race and TTL during transfer. Check source run remains terminal and unchanged.

**Exit/rollback:** developer test entry can execute handoff with bounded temporary diagnostics; production handoff remains disabled until P4 can persist/delete results. Disable handoff without altering source delivery. New Rust tests in owning crate modules, TS tests adjacent to sources, both locale refusal/action keys and a changeset. Wiring review traces user action → Host authority → source verification → child desktop binding.

## P4 — Durable results, private artifacts and deletion as one lifecycle

**Implementation authorized on 2026-10-15 after D1/D2 verification.** Source implementation and bounded checks are recorded in [the Phase 4 report](./2026-10-15-managed-cloud-desktop-phase4-verification.md). Rust validation remains skipped and production acceptance remains hard-disabled. Own acceptance metadata/evidence/GC modules, existing execution artifact/history projections and narrow canonical deletion/retention hooks. Coordinate the merged history contract before modifying it.

### P4.1 Result storage and projection → verify source identity and terminal semantics

- Persist result identity, exact commit/manifest digest, child run/desktop generation, criterion outcomes, counts, agent provenance and separate human-approval revisions.
- Reuse `RunArtifactSnapshot` verification kind/counts/opaque `detailsRef` and `artifact.created` in the child run. Do not append to a terminal parent or force `cancelled` into an unsupported verification enum.
- Host journal/evidence store is authoritative. Use existing run reducer/detail-model presentation; no screenshot bytes, file paths, cloud endpoints or bearer URLs in run events. Add a result lookup surviving ordinary 30-day event pruning while source history remains.
- Atomic staged evidence publication precedes result completion. Missing required capture produces inconclusive, not passed. Cleanup state remains separate. Duplicate completion and newer approval revisions are idempotent and ordering-safe.

### P4.2 Capture/access limits → verify bounded private storage

- Enforce 100 images/100 MiB aggregate/8 MiB image at ingestion, with bounded decoded pixels and supported image types. Reserve capacity transactionally so concurrent captures cannot overshoot. Keep live frames ephemeral and select only checkpoint/failure captures.
- Reuse native opaque-ID/path-containment patterns in `automation/record/assets.rs`, not its recording-bundle namespace. Use owner-scoped artifact access and existing storage encryption policy; no browser-owned authoritative copy.
- Return `no-store` on evidence reads, revoke object URLs/in-memory previews at account switch/deletion, and reject path/owner substitution. Do not inherit `session_media.rs`'s immutable one-year cache header.
- No default share-link generation, public upload, model upload or `library:` ownership. Explicit exports disclose their independent retention; automatic backup/export inclusion remains disabled.

### P4.3 Canonical deletion and restart-safe GC → verify no untracked orphan

- Extend `deleteSessionsRouted` → owning Host `session.delete` → `deleteSessionsWithTeardown` → `bulkDeleteSessions`; include owned descendants and task-only/acceptance-only deletion entry points.
- Current cascade omits execution runs/events/result summaries. Explicitly remove/tombstone the acceptance projections and native evidence references; do not assume foreign-key cleanup exists.
- Check authorization/handoff locks before deletion. Persist a content-free cleanup outbox while native links still exist. Couple DB delete/outbox in the owning transaction; if native/Dexie stores differ, implement acknowledged, replayable deletion-operation state, not fictional atomicity.
- On committed deletion, deny reads/capture/result writes by generation, revoke controller, cancel acceptance and enqueue desktop destroy plus artifact/staging removal. Do not erase files for a rejected or rolled-back delete.
- Worker owns retries/startup reconciliation, missing-file success, partial failure and completion status. Pending cleanup cannot expire with ordinary sync tombstones or depend on an open browser.
- Register retention policy/executor with `lib/storage/retention.ts` and native/headless startup. Archive retains evidence without unarchiving/restarting runs. No kept/library promotion bypasses cascade.

**Verify:** pass/fail/inconclusive/cancelled; wrong commit; duplicate/out-of-order completion; parent terminal; event pruning; concurrent capture budgets; invalid image/dimensions/path; no-store and permission denial; individual/bulk/empty-archive delete; owned descendants; ordinary branch behavior; locked/refused delete; task-only delete; offline Host queued delete; crash between outbox/DB/native stages; filesystem failure; late event resurrection; provider destroy failure independent of byte cleanup; restart without renderer; no share links.

**Exit/rollback:** one narrow end-to-end user create → commit/bundle → GUI checkpoint → verdict → source/run history → delete → restart/absence proof. Preserve existing Docker path. Enable acceptance only when all four phases qualify. Rollback keeps historical records readable and GC/destroy running while preventing new work.

## Verification commands and evidence discipline

Select exact tests after implementation; the commands below show scope, not a claim that future files already exist. Never run a bare full-suite command or coverage. A new failure outside owned paths is reported separately, not repaired opportunistically.

```bash
rtk pnpm test -- --runInBand lib/sandbox/lifecycle-contract.test.ts lib/sandbox/adapter-registry.test.ts lib/sandbox/connection-capabilities.test.ts
rtk pnpm test -- --runInBand hooks/automation/use-sandbox-desktop.test.ts lib/automation/sandbox-client.test.ts
rtk pnpm exec eslint <explicit-changed-source-paths>
rtk pnpm i18n:build
rtk pnpm i18n:build:check
rtk pnpm lint:i18n
rtk df -h
rtk cargo test -p cognia-automation cua_sandbox::desktop_session::tests --lib
rtk cargo test -p cognia-sandbox-pool git_proxy::tests --lib
rtk pnpm audit:rust-architecture
rtk pnpm audit:colocated-tests
rtk pnpm docs:build
```

Add targeted module-filtered Rust tests for new client/journal/provenance/GC modules, targeted TS suites for each new source, and the narrow actual UI E2E scenario. Compile/typecheck only appropriate affected projects or report unrelated baseline failures. UI smoke must exercise actual Host routing; unit tests alone do not prove it. Evidence report identifies mock/local Docker/real E2B distinctly and states exact version/build/SHA and limits.

After each phase, run `wiring-auditor` over registry, capability negotiation, Host boot/RPC/ACL, viewer route, plugin `computer-use`, child binding, history producer/consumer and GC as applicable. Add `i18n-reviewer`, `tauri-rust-reviewer`, `static-export-auditor`, `pii-gate-auditor` and `test-gap-auditor` only where the change triggers them. Outbound model paths must preserve the PII gate; provider SDKs/Node-only code stay out of the static renderer. Do not claim production enablement without D4.

## Acceptance and review checklist

- [x] D0 recorded: user approved ADR-0233 and Phases 1–2 on 2026-10-15; The user subsequently authorized provenance completion and Phase 3. Real-provider smoke remains separately gated.
- [x] D1/D2 exact merged commits recorded before dependent edits.
- [ ] Every phase contains tests, both locales, changeset, wiring evidence and rollback.
- [ ] Runtime/UI/type tests pin every dormant path, especially agent-initiated spend and live preview.
- [ ] Template distribution and account cap are real verified contracts, not alias/plan-name assumptions.
- [ ] Price UI states single-session compute maximum and Host-local concurrency limitation.
- [ ] Real TTL smoke proves kill with Host stopped and no resume; explicit user spend authorization recorded.
- [ ] Child acceptance pins commit and read-only Git; original task remains unchanged.
- [ ] Screenshot quota and canonical deletion survive crash/offline/partial failure without orphaning files.
- [ ] No automatic sharing, merging, task completion, recording or cross-Host source transfer.

The approved design decisions and source references are in ADR-0233. This plan is not an instruction to skip those gates when a phase is difficult or a provider feature is unavailable.
