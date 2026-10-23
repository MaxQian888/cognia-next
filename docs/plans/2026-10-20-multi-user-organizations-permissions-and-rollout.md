# Make organization permissions, collaboration, and rollout share one deployment contract

| Field             | Value                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status            | **Revision 2, approved for implementation of P0–P4** (2026-10-20). Revision 1 was a Codex audit; revision 2 rechecks it against HEAD `07eb0d44b5`, folds in an adversarial review and primary-source checks, and records the maintainer's product decisions. |
| Author / date     | Revision 1: Codex. Revision 2: Claude (architecture and quality gate) with Codex `gpt-6.1-sol` (adversarial review, web verification, backend implementation) and haiku explorers. 2026-10-20, Asia/Shanghai.                                                |
| Request           | Self-hosted access by different people, organization/workspace roles, per-user permissions, collaboration integration, execution isolation, staged rollout.                                                                                                  |
| Depth             | Heavy: identity, authorization, shared resources, execution, deployment, persistent policy, client/server compatibility.                                                                                                                                     |
| Contracts (SSOT)  | [`protocol/collab-capabilities-v1.json`](../../protocol/collab-capabilities-v1.json) (features, states, reasons, action presets, example response), [`protocol/collab-rollout-buckets-v1.json`](../../protocol/collab-rollout-buckets-v1.json) (bucketing).  |
| Related decisions | ADR-0054, ADR-0059, ADR-0149, ADR-0177, ADR-0182, ADR-0206, ADR-0207. A new ADR records the decisions in §2 when P0 ships.                                                                                                                                   |

## 1. Summary

Cognia already has people, organizations, workspace and session membership, invitation administration, and an execution sandbox policy. This plan extends those owners. It adds no second account system and no generic experimentation service.

Four independent decisions gate every remote action:

- **Identity**: who is calling.
- **Authorization**: what they may do to this resource.
- **Availability**: whether the feature is offered to this organization.
- **Execution admission**: where execution may run.

A client preference or rollout state can never raise permission or lower isolation.

Revision 2 changes four things against revision 1:

1. **Fix what exists before adding machinery.** Session-member removal already runs a full revocation chain: a session-row lock, `policy_revision++`, `pg_revoke_member_work`, and ticket revocation. Offboarding and workspace removal skip it. Reuse that chain plus a read-time standing ceiling. Do not add a per-scope revision service or a cleanup-intent outbox.
2. **New P0 findings.**
   - Default Compose runs the collaboration server as the Postgres superuser, so RLS is not in force.
   - `/internal/shared-chat-metrics` is unauthenticated.
   - In multi-tenant mode the Host serves terminal, raw file, git, plugin and local MCP routes to any tenant principal without admission.
3. **Lean rollout.** One revisioned policy row per feature, read per request; operator CLI with CAS and audit; a missing row means today's behavior. Publication intents, snapshots, feed invalidation and the 5-second decision cache are removed.
4. **Resequenced packages.** Authorization fences move into P0 and execution-surface gating into P1. Real-database and two-user fixtures are built inside each package, not deferred to a final QA phase.

## 2. Decisions (maintainer, 2026-10-20)

| ID  | Decision                                        | Recorded choice and consequence                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Meaning of "space"                              | Reuse Workspace under Org. Personal space stays local/private; it is never published into an organization automatically.                                                                                                                                                                                                                                                                               |
| Q2  | Developer role                                  | No new stored role. `member` keeps its wire value; "Developer" may be a UI label later. Finer control comes from fixed **action presets** derived from standing (`protocol/collab-capabilities-v1.json`).                                                                                                                                                                                              |
| Q3  | Org-admin privacy                               | Org owner/admin traverse workspaces for management; they never gain session _content_ without explicit session membership or the audited break-glass path.                                                                                                                                                                                                                                             |
| Q4  | Who creates organizations                       | Operator-created tenants plus invitations. Self-service creation is out of scope.                                                                                                                                                                                                                                                                                                                      |
| Q5  | Shared-feature cohort                           | The organization. Workspace rules may only narrow.                                                                                                                                                                                                                                                                                                                                                     |
| Q6  | Session-only Guests                             | **Kept.** A non-guest session member's effective standing is capped by their _current_ org/workspace standing. A session Guest's standing comes only from the session (role ceiling, invite expiry, explicit removal). Workspace changes never remove a Guest by accident. No data migration.                                                                                                          |
| Q7  | Trust inside one organization                   | **Members of one org do not fully trust each other at the OS level.** In multi-tenant mode, raw Host surfaces are limited to `host.workspace-surfaces` (workspace maintainer+) and `host.global-surfaces` (org owner/admin). Ordinary members execute only through the sandbox pool. Without a conforming sandbox the Host advertises execution as unavailable; it never falls back to a host process. |
| Q8  | Rollout control plane                           | **Lean.** Per-feature DB policy row, per-request evaluation inside the owning transaction, CAS + audit through an operator subcommand. No publication worker, snapshot, feed invalidation or decision cache in v1.                                                                                                                                                                                     |
| Q9  | Pause vs kill                                   | Pause / not-offered → `existing-only` (no new resources or runs; existing work drains). Kill → `read-only` (also no content mutation; read, export, leave, cancel, delete remain).                                                                                                                                                                                                                     |
| Q10 | Host data partitioning (2026-10-23)             | **One brain process per person** on multi-tenant Hosts. The brain stays single-account by design (`getDb()` is a process singleton used by ~780 files), so partitioning happens at the process boundary, not per request or per row. See §9a.                                                                                                                                                          |
| Q11 | Model calls from person partitions (2026-10-23) | `pet_chat_send` and `pet_soul_generate` stay intentionally dormant on multi-tenant Hosts (`503 model_access_unavailable`) until the P6 credential broker. A person partition starts with no provider configuration.                                                                                                                                                                                    |
| Q12 | A departed member's Host data (2026-10-23)      | **Kept but inaccessible.** Standing is checked on every request, so access ends at once. Data and key stay until an operator runs `cognia-server persons purge`; nothing is deleted automatically.                                                                                                                                                                                                     |

## 3. Verified current state (HEAD `07eb0d44b5`)

Labels: **Confirmed** means read in source at the cited lines. **Inferred** means reasoned from those reads. Revision 1's A01–A12 were all re-confirmed; corrections are noted inline. A13–A18 are new.

| ID  | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Priority / package |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| A01 | **Confirmed.** `types/identity/index.ts:48-67` and `crates/cognia-tenant-auth/src/roles.rs` define the org ladder (owner/admin/member) and workspace ladder (maintainer/member/viewer → manage/write/read). `resolve_workspace_access` (`membership.rs`) is the gate: org owner/admin → manage via `org-admin`; workspace membership without org membership → `guest: true`. The TS helpers `allowsCapability`, `capabilityRank` and `canTraverseWorkspaces` have no production callers; `hooks/workspace/use-membership-admin.ts:257` reimplements them inline.                                                                           | P3                 |
| A02 | **Confirmed.** Invite, role change, remove, offboard and bootstrap are reachable (`lib/collab/membership-admin.ts`, `components/workspace/workspace-members.tsx`). `PgStore::offboard_org_member` locks owner rows and enforces last-owner. **Missing:** atomic ownership transfer, org suspend/delete, invitation/grant rate limits.                                                                                                                                                                                                                                                                                                      | P3 / P5            |
| A03 | **Confirmed, still open.** Offboarding (`store.rs:3946-4010`) and workspace removal (`store.rs:4065-4098`) delete org/workspace rows only. They leave `chat_session_memberships`, approver flags, leases, queued items and live chat tickets untouched. `visible_session` (`chat_store.rs:2360`, memory `:801`) and `pg_member` (used by `claim_run_queue`, `chat_store.rs:2746`) check session membership only. The chat stream rechecks per event (`chat_api.rs:1783`), so an idle stream stays open. The session-level path (`chat_api.rs:942-976`, `chat_store.rs:2471-2502`, `pg_revoke_member_work` `:642`) shows the correct chain. | **P0**             |
| A04 | **Confirmed, sharpens §7 of revision 1.** Session Guests (`chat.rs:124`, ceiling `:185-204`, DB `chat_guest_ceiling`) need no workspace standing (`enforce_member_role_ceiling` returns early for guests, `chat_api.rs:770-778`). A blanket "workspace membership caps every session member" rule would break them; Q6 scopes the cap to non-guests. Demotion is also unhandled: a workspace member demoted to viewer keeps a stored session `member`/`maintainer` role.                                                                                                                                                                   | **P0**             |
| A05 | **Confirmed.** Shared chat, Canvas and feed routes are mounted on process booleans (`api.rs:294-311`). `/health` lists process features. With the master switch off every chat route disappears, so pause/kill cannot keep recovery reads through the switch alone.                                                                                                                                                                                                                                                                                                                                                                        | P2                 |
| A06 | **Confirmed.** Shared chat: build gate AND subtractive local preference. Canvas collaboration defaults **on** in the client (`lib/canvas/feature-flags.ts:7`) while the server defaults it **off** (`main.rs:61`), and the client never asks the server. Agent execution flags: default → env → localStorage.                                                                                                                                                                                                                                                                                                                              | P2 / P3            |
| A07 | **Confirmed.** Software-update rollout uses a random device bucket with a manual bypass of the percentage only. Keep it separate; never copy the bypass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | —                  |
| A08 | **Confirmed, sharpened.** `COGNIA_DEPLOYMENT_MODE` unset → single-user; an invalid value → multi-tenant (fail closed). The baseline `multi_tenant` flag can be set only through `COGNIA_ENVIRONMENT_BASELINE_FILE`; its validator demands a gVisor/VM floor. Nothing cross-checks mode, baseline and pool at boot (`cognia-sandbox-pool/src/boot.rs:210` returns the raw backend when the pool is off). `environment::policy::fault_disposition` has no production caller; `sandbox_routing_backend.rs:595-640` reimplements it inline.                                                                                                    | **P1**             |
| A09 | **Confirmed.** Boot resolves the exec backend, then installs the optional pool. The tenant-volume lease is single-active and proves nothing about per-user isolation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | P1                 |
| A10 | **Confirmed.** No Compose file forwards `COLLAB_SHARED_CHAT_ENABLED`, `COLLAB_CANVAS_ENABLED` or `COLLAB_FEED_ENABLED` to `collab-server`, so shared chat and Canvas can never be on in Compose. `COGNIA_DEPLOYMENT_MODE` appears only in the web-headless E2E overlay (`docker-compose.web-headless-e2e.yml:178`).                                                                                                                                                                                                                                                                                                                        | **P1**             |
| A11 | **Confirmed.** Converting a local `team` session refuses (`shared-chat-conversion.ts:269`). Keep the refusal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | P5                 |
| A12 | **Confirmed.** Web shared-chat E2E is mock-backed (`installCollabScenario`); real Postgres RLS tests are `--ignored` and need explicit admin/app role URLs. `tests/postgres_rls.rs` has **no** offboarding, workspace-removal or demotion test.                                                                                                                                                                                                                                                                                                                                                                                            | each package       |
| A13 | **Confirmed, new, P0.** Base Compose sets `COLLAB_DATABASE_URL` to the `POSTGRES_USER` role (`docker-compose.yml:75,98`), which is a superuser, and `PgStore::connect` runs every DDL migration on that connection (`store.rs:2452-2513`). Superusers and `BYPASSRLS` roles always bypass RLS ([PostgreSQL RLS docs](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)). The tenant RLS layer therefore does not protect a default deployment.                                                                                                                                                                                 | **P0**             |
| A14 | **Confirmed, new, P0.** `GET /internal/shared-chat-metrics` (`api.rs:232`, handler `:342`) has no credential check and is reachable via Caddy `handle_path /collab/*`. It exposes counters only, but the `/internal` prefix must mean service-authenticated.                                                                                                                                                                                                                                                                                                                                                                               | **P0**             |
| A15 | **Confirmed, new, P1.** `build_router_for_mode(_mode, …)` ignores the deployment mode (`cognia-companion/src/server.rs:558`). In multi-tenant mode these run on the Host with no environment admission: terminal PTY/exec, raw absolute-path file RPC, git, plugins, local MCP and OS scheduler registration. Only `workspace_access.rs` (environment approval) consults collaboration standing.                                                                                                                                                                                                                                           | **P1**             |
| A16 | **Confirmed, new.** One internal service credential (`COLLAB_INTERNAL_SERVICE_CREDENTIAL_SHA256`) authorizes queries for any org. With one tenant unit per org, a compromised Host could query other orgs' standing.                                                                                                                                                                                                                                                                                                                                                                                                                       | P2                 |
| A17 | **Confirmed, new.** Chat invitation acceptance (`chat_store.rs:2228-2270`) checks pending/expiry/target only. It does not recheck that the issuer may still manage members, and offboarding revokes only `organization_invitations`, not `chat_session_invites`.                                                                                                                                                                                                                                                                                                                                                                           | **P0**             |
| A18 | **Confirmed, correction to revision 1.** The shared-chat `426 Upgrade Required` carries no `Upgrade` header. [RFC 9110 §15.5.22](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.22) requires one, and 426 means a protocol switch, not an outdated application contract. The existing response stays for wire compatibility (old clients key on it) and is documented as a known deviation. New contract refusals do **not** use 426 (§6).                                                                                                                                                                                       | P2                 |

Primary-source checks (2025–2026) by `gpt-6.1-sol`:

- LaunchDarkly, Unleash, GrowthBook and Statsig all bucket deterministically on a hash of flag/salt/subject. Widening a contiguous bucket range keeps earlier members. Statsig's server SDK uses the first 64 bits of SHA-256 mod 10000. The bias of 64-bit mod 10000 is about 5·10⁻¹⁶, which is negligible.
- OpenFeature leaves the `targetingKey` subject open, so org-level targeting with `targetingKey = orgId` is permitted.
- Kill switches in those products change the _next evaluation_ only. Cancelling running work and keeping the isolation floor are Cognia's job.
- gVisor's current docs require separate sandboxes per mutually untrusted workload. Kubernetes multi-tenancy guidance recommends VM or userspace-kernel sandboxes for hostile code.

## 4. Concepts and authority boundaries

| Concept               | Responsibility                                                            | Boundary                                                                                                |
| --------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Deployment operator   | Infrastructure, tenant placement, rollout policy, emergency stop.         | Not an org role. Acts through the operator subcommand and an operator DB role, never through a browser. |
| User                  | Stable person id with external identities and devices.                    | No global developer role. Roles are per org/workspace/session.                                          |
| Organization          | Ownership, membership, policy, audit, tenant accounting; rollout cohort.  | Org membership alone grants no workspace access.                                                        |
| Workspace             | Scoped collaboration resources and environment bindings.                  | Explicit membership; org owner/admin traverse for management only.                                      |
| Shared session        | Conversation with explicit membership (incl. Guests), one `workspace_id`. | Non-guest standing ≤ current workspace standing (Q6). Content needs session membership (Q3).            |
| Execution environment | Mounts, process boundary, network, credentials, limits for a run.         | An action grant permits _requesting_ execution; it never manufactures isolation.                        |

The authority owners stay where they are:

- `cognia-tenant-auth` owns role ladders, `resolve_workspace_access` and the new action presets.
- `cognia-collab-server` owns membership, sessions, rollout policy and capabilities.
- The Host (`cognia-companion`, `cognia-server`) owns execution admission and Host surface gating. It consults the collaboration server for standing and feature decisions.
- Frontend mirrors are presentation only (`lib/db/identity.ts` already says so).

### Action presets (fixed, derived, never stored)

`protocol/collab-capabilities-v1.json` lists every action. Two kinds:

- **Org-scope actions** are granted by org role.
- **Workspace-scope actions** are granted when the effective workspace capability (after org-admin traversal) meets the action's minimum and, for a workspace Guest, the action is `guestAllowed`.

The file's `presetVectors` pin the result for every role combination. `cognia-tenant-auth::actions::actions_for(org_role, workspace_role)` is the one implementation. The TypeScript side only renders the server's list; it never derives grants.

Session actions keep `authorize_session_action` (`chat.rs:173`) unchanged. High-risk approval stays a session `approver` capability.

## 5. Rollout: server-authoritative, lean

### Policy model

Table `deployment_feature_policies`, one row per feature key. It is deployment-level, not tenant data, so there is no RLS. The app role gets SELECT only; the operator role gets INSERT/UPDATE.

| Field                                                | Contract                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feature_key`                                        | One of `featureKeys` in the contract file; unknown keys are rejected on apply.                                                                                                                                                                     |
| `schema_version`, `revision`                         | `schema_version = 1`. `revision` increases by exactly 1 per apply (CAS on `baseRevision`).                                                                                                                                                         |
| `phase`                                              | `off` \| `internal` \| `canary` \| `general` \| `paused`.                                                                                                                                                                                          |
| `kill`                                               | Emergency stop → `read-only`.                                                                                                                                                                                                                      |
| `allow_org_ids`, `deny_org_ids`                      | Deny wins in every phase.                                                                                                                                                                                                                          |
| `deny_workspace_ids`                                 | Narrows within an eligible org only.                                                                                                                                                                                                               |
| `percentage_basis_points`                            | 0–10000.                                                                                                                                                                                                                                           |
| `cohort_key`, `cohort_salt`, `hash_version`          | `cohort_key` defaults to `feature_key`. Features that must ship together share a cohort key, so independent 10% rollouts do not intersect to 1%. Algorithm in `protocol/collab-rollout-buckets-v1.json`. A salt change is an audited reassignment. |
| `minimum_contract_version`                           | For `shared-chat*`: compared with the client's `x-cognia-collab-protocol`.                                                                                                                                                                         |
| `requires`                                           | Prerequisite feature keys; a prerequisite not `available` → `existing-only` / `prerequisite_unavailable`.                                                                                                                                          |
| `updated_at`, `updated_by`, `reason`, `operation_id` | Audit fields; `operation_id` is unique, and a replay with identical content is a no-op.                                                                                                                                                            |

`deployment_feature_policy_audit` is append-only: old/new revision, operation id, operator principal (the authenticated DB role, `current_user`), reason, bounded JSON diff, and time. It never holds tokens, prompts or content.

**A missing row means "general".** An upgrade therefore changes nothing for a running deployment; policy can only narrow what the deployment master switch allows.

### Evaluation (one pure function, per request)

`rollout::evaluate(policy, master_enabled, org_id, workspace_id, client_contract, prerequisites) -> FeatureDecision { state, reason, policy_revision }`. The first matching rule wins:

1. Master off → `off` / `deployment_disabled`.
2. `kill` → `read-only` / `feature_killed`.
3. Org in `deny_org_ids` → `existing-only` / `org_denied`. Workspace in `deny_workspace_ids` → `existing-only` / `workspace_denied`.
4. A client contract was supplied and is below `minimum_contract_version` → `existing-only` / `client_contract_unsupported`.
5. A prerequisite is not `available` → `existing-only` / `prerequisite_unavailable`.
6. `off` → `existing-only` / `feature_not_offered`. `paused` → `existing-only` / `feature_paused`.
7. `internal`: available iff the org is in the allowlist.
8. `canary`: available iff allowlisted or `bucket < percentage_basis_points`.
9. `general`: available.
10. Otherwise `existing-only` / `feature_not_offered`.

The policy row cannot be read → `existing-only` / `policy_unavailable` for admission (fail closed), while reads continue.

### Enforcement points

State-changing admission reads the policy row **inside the owning transaction**, under the same session-row lock that already orders membership and queue mutations:

| Feature                 | `available` needed for                                        | Blocked in `read-only`                                  | Always allowed when authorized                    |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------- |
| `shared-chat`           | create / convert session, create invite                       | post, edit, react, attach, member add, settings         | list, read, stream, export, leave, delete, cancel |
| `shared-chat-execution` | enqueue run, claim queue item, start run, approve high risk   | heartbeat may only finish/cancel; no new tool approvals | cancel, read run state                            |
| `canvas-collaboration`  | create shared canvas document                                 | document writes, cursor publish                         | read, export                                      |
| `org-governance`        | the new governance UI entry points (client-only presentation) | —                                                       | existing membership administration                |
| `environment-binding`   | bind/approve an environment for a workspace (Host)            | new placements using the binding                        | read binding, release                             |

To keep recovery reachable (A05), the master switch keeps its meaning: off means unmounted, exactly as today. `existing-only` and `read-only` are enforced by handlers, so read, export, leave and cancel survive a pause or kill. A refusal returns **403** with body `{ "error": "feature_unavailable", "feature": "<key>", "state": "<state>", "reason": "<reason>" }`. This comes after authentication and after the hidden-resource check, so a refusal never reveals that a resource exists.

### Contract pinning

`chat_sessions` and `canvas_documents` gain `contract_version` (NOT NULL, default = current protocol version, recorded at creation). A client whose protocol header is below a session's `contract_version` may read but not mutate it. Writes are refused with `client_contract_unsupported`. Re-evaluating rollout never reinterprets stored events.

## 6. Capabilities API and status semantics

`GET /v1/orgs/{org}/capabilities?workspaceId=<id>` (collaboration server):

- Authenticated by the existing grant. The org must be readable by the caller (`readable_scope`); otherwise `403`. An unknown or unreadable `workspaceId` returns `404`.
- Response: the `exampleResponse` shape in `protocol/collab-capabilities-v1.json`, i.e. `schemaVersion`, `orgId`, `workspaceId`, `standing`, `actions`, one entry per feature key, `evaluatedAt`. Headers: `Cache-Control: private, no-store`.
- It contains no allow/deny lists, salts, buckets or other orgs' data. The client may send `x-cognia-collab-protocol` so `client_contract_unsupported` is reflected.
- Old servers return `404` for the route. The client then treats every new flow as unsupported and keeps today's behavior.

The internal Host endpoint `GET /internal/v1/orgs/{org}/workspaces/{ws}/access/{user}` gains additive fields: `orgRole`, `actions`, `features`. A new `GET /internal/v1/orgs/{org}/access/{user}` returns org standing, org actions and features without a workspace.

The internal credential may be **scoped**: `COLLAB_INTERNAL_SERVICE_CREDENTIAL_SCOPES` holds a JSON map from credential SHA-256 to allowed org ids. When it is set, a credential querying another org gets `403`. When unset, the single-credential behavior is unchanged. `/internal/shared-chat-metrics` requires the service credential (A14).

| Status    | Meaning in this contract                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 400 / 422 | Malformed scope, document or version (existing convention: chat uses 422 for body validation).                                                   |
| 401       | Missing or invalid grant or service credential.                                                                                                  |
| 403       | Known forbidden management, or `feature_unavailable` (body distinguishes the two).                                                               |
| 404       | Hidden or absent resource (`Cache-Control: private, no-store` on hidden 404s).                                                                   |
| 409       | Stale `baseRevision` on policy apply; operation-id replay with different content.                                                                |
| 426       | **Legacy only**: the existing shared-chat protocol floor (A18). Not used by new code.                                                            |
| 503       | Policy store unavailable (retryable, `reason: policy_unavailable`), or Host execution isolation unavailable (`execution_isolation_unavailable`). |

## 7. Revocation (P0)

1. **Read-time ceiling (defense in depth).** One store function, `effective_member(org, session, user)`, replaces raw membership reads in `visible_session`, `pg_member` (queue claim), lease heartbeat/complete, approval decisions, attachment-ticket issuance and stream ticket redemption.
   - For a non-guest member it joins current standing (`resolve_workspace_access` over org + workspace rows for the session's `workspace_id`). No standing means not a member.
   - Otherwise the effective session role is `min(stored role, ceiling(standing))`, using the ceiling `enforce_member_role_ceiling` already applies at grant time. `approver` survives only when the capped role still allows approval.
   - Guests are returned unchanged (Q6).
   - Demotion, offboarding, workspace removal and legacy stale rows are therefore all fenced at the next read, even before cleanup runs.
2. **Write-time cleanup in the same transaction.** `offboard_org_member` (every session in the org) and `remove_workspace_member` (sessions in that workspace) apply this to each non-guest session membership of the person, locking `chat_sessions` rows in ascending id order first:
   - delete the membership;
   - `policy_revision += 1`;
   - `pg_revoke_member_work` (fail leases, cancel queued items);
   - revoke pending `chat_session_invites` the person created.

   A workspace demotion (`set_workspace_member`) clamps stored session roles and approver flags in the same way. The memory store mirrors this exactly.

3. **After commit:** revoke the person's chat stream tickets for every affected session (`TicketBook`) and publish membership feed frames. The chat stream loop also re-runs `visible_session` on a 5-second idle tick, like the feed, so an idle stream closes within one tick.
4. **Invitation acceptance** re-checks, inside its existing session-first transaction, that the issuer still holds `ManageMembers` under `effective_member`. A revoked issuer's invitation becomes unavailable.
5. **Linearization point.** A side effect is authorized at claim or approval time under the session-row lock. A revocation that commits after that point cannot stop an effect already dispatched. The lease heartbeat then fails, the Host cancels at its next boundary, and the run records `revoked_during_run`. External effects already sent are shown as unresolved, never as rolled back. Remote erasure of offline device caches is not promised.
6. **Inventory.** `cognia-collab-server audit-standing [--apply]` reports non-guest session memberships whose holder lacks current standing (and roles above the ceiling). `--apply` runs the step-2 cleanup in bounded batches.

**Implementation notes (P0a, 2026-10-20).**

- Two ceilings, both in `chat.rs`.
  - **Read-time:** workspace maintainer/member or org owner/admin → Owner; viewer → Viewer; no standing → not a member. Creating a session makes a writer its owner, so reading must not take that away.
  - **Grant-time:** what someone else may grant. Unchanged: a workspace member may receive at most Member.
- Org offboarding removes **all** of that person's session memberships in the org, guest rows included: offboarding means the person leaves. Otherwise a manager could flip someone to guest just before offboarding them. Workspace-seat changes still never touch guest rows (Q6). External guests who never held org membership cannot be offboarded and are unaffected.
- Member writes, role/approver patches and invite creation re-authorize the actor inside the session lock. An offboarding that commits after the API check therefore cannot be undone by an in-flight write.
- Canvas ticket redemption, sync and the socket re-check workspace read access, with the same 5-second idle tick.
- Cleanup recomputes effective standing; it does not force-delete. Workspace-seat removal leaves an org owner/admin's sessions intact, because they still traverse. A membership whose effective role and approver flag are unchanged is not touched: no revision bump, no ticket revocation.
- Org-role demotion (admin → member) has no write-time cleanup. The read-time ceiling fences it at the next request, and streams close within one 5-second tick.
- **Open (P5):** offboarding a session's only owner leaves the session ownerless. Its members keep their roles, but nobody can manage members until an org owner reclaims ownership through the audited break-glass path. That reclaim flow is not built yet.

### Database roles (A13)

- `COLLAB_MIGRATION_DATABASE_URL` (optional): when set, DDL runs on it and `COLLAB_DATABASE_URL` only serves queries. Migrations end by granting table privileges to the app role named by `COLLAB_APP_DB_ROLE`.
- At startup the server checks `rolsuper` / `rolbypassrls` of `current_user` on the app connection and **refuses to start** if either is true. The only exception is an explicit `COLLAB_ALLOW_PRIVILEGED_DB_ROLE=true`, which logs a warning on every boot and is reported in `/health` as `"rls": "bypassed"`.
- Compose ships an init script creating `cognia_collab_app` (NOSUPERUSER NOBYPASSRLS) and passes the split URLs. The README documents migrating an existing volume.
- `COLLAB_OPERATOR_DATABASE_URL` is used only by the `rollout` subcommands. Its role may write only the two policy tables.

## 8. Deployment isolation and Host surfaces (P1)

**Boot preflight** (`cognia-server run_serve`, before serving): when the deployment mode is multi-tenant, all of the following must hold:

- the environment baseline has `multi_tenant = true`;
- the sandbox pool is enabled;
- the isolation floor is ≥ gVisor;
- the selected runtime is available.

If any fails, boot refuses with a precise reason. The only exception is `COGNIA_EXECUTION=disabled`. In that control-plane-only mode every execution entry point answers `503 execution_isolation_unavailable` and `/api/auth/config` advertises `execution: "unavailable"`. A single-user deployment is unaffected. A baseline with `multi_tenant = true` under single-user mode is allowed (stricter).

**Host surface policy.** It reuses the existing command manifest; there is no second table. Every remote command has a `CommandDescriptor` with one of 22 `capability` values (`protocol/companion-commands.json`). Every transport (device HTTP, internal, A2A, ACP, WebRTC, CLI bridge) reaches dispatch through `remote_execution::execute`.

[`protocol/host-surface-policy.json`](../../protocol/host-surface-policy.json) maps each capability to a class:

| Class                 | Multi-tenant requirement                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client`              | Runs on the client, never gated on the Host.                                                                                                                                   |
| `operator-only`       | Never served to a tenant principal (`service.internal`).                                                                                                                       |
| `org-action`          | The named org action, e.g. `host.global-surfaces` for `host.admin`, `host.execute`, `scheduler.manage`, performance capture.                                                   |
| `workspace-action`    | The named workspace action in the workspace the Host resolves for the target root, never a renderer-supplied id. An unresolved workspace falls back to `host.global-surfaces`. |
| `sandboxed-execution` | `execution.request` in the resolved workspace plus a sandbox placement (`agent.run`, `workflow.run`).                                                                          |

The gate sits in `remote_execution::execute_inner` right after the descriptor lookup and before `authorize_capability`, so it covers every transport. The principal is the device; its person comes from `security_store::device_user`. In multi-tenant mode, a device with no bound person is refused.

Surfaces outside the manifest are each classified explicitly; anything unclassified is denied in multi-tenant mode:

- root WebSocket endpoints, by the capability their ticket is minted for;
- the `workflow_app_*` / `dify_*` bridge names, which have their own app-session authentication.

A test asserts that every manifest capability appears in the policy file. Single-user mode never consults it: the host owner is the only principal.

Note: `require_device_jwt`'s OIDC branch is not mounted on any production route (`middleware.rs:107`). Tenant principals reach the Host only as paired devices bound to a person, and P1 keeps it that way.

**Host data is not partitioned (found during P1 review, 2026-10-21).** The 61 `client.read` / `client.write` commands (messages and transcripts, files library, pet, issues, characters, glance, push tokens, twin profile) are `target: execution`: they run on the Host against its active-account store, which has no caller person or tenant selector. Classing them `client` would let any paired tenant device read and write every member's data. Decision: in multi-tenant mode they are refused (`403 host_data_unpartitioned`, intentional dormancy per Rule 7) until P5 partitions the store; member collaboration data goes through the collaboration server. The eight Host-global configuration arms among them (`plugin_set_enabled`, `plugin_cogset_activate`, `plugin_install_origin_record`, `mcp_set_enabled`, `mcp_set_tool_rules`, `skill_set_enabled`, `adapter_update_policy`, `app_settings_update`) instead require `host.global-surfaces` through `commandOverrides`.

Grants come from the collaboration internal access endpoints. They are cached per principal for at most 5 seconds and only for _admission_. Revocation still lands at the next admission, and fencing stays in the collaboration server.

**Fallback.** `sandbox_routing_backend` calls `environment::policy::fault_disposition` instead of its inline copy. In multi-tenant mode a sandbox fault never falls back.

**Compose.**

- Forward `COLLAB_SHARED_CHAT_ENABLED`, `COLLAB_CANVAS_ENABLED` and `COLLAB_FEED_ENABLED` to `collab-server`.
- Forward `COGNIA_DEPLOYMENT_MODE`, `COGNIA_ENVIRONMENT_BASELINE_FILE` and `COGNIA_EXECUTION` to `cognia-server`.
- AC10 verifies the effective model with `docker compose config`.

## 9. Resource and execution binding (P4)

- **Placement.** Every sandbox placement carries server-resolved `orgId`, `workspaceId`, `actorUserId` and run/resource ids. The Host derives them from the authenticated principal and the collab binding, never from the renderer body.
- **Mounts.**
  - Private scratch per (actor, task).
  - The workspace root is mounted read-write only with `workspace.write`, read-only with `workspace.read`.
  - Viewers get no execution.
- **Credentials.** Injection requires `credential.use`; listing or reading values requires `credential.manage`. A sandboxed process that receives a plaintext credential can read it, so `credential.use` without `credential.read` is promised only for brokered uses. Plain environment injection is labeled as such in the UI and the type, and pinned by a test (Rule 7).
- **Shared runs.** Queue claim and run start check `shared-chat-execution` admission and `effective_member` inside the session-row transaction. Heartbeat/complete re-run `effective_member`; on failure the lease is failed and the Host coordinator cancels.

## 9a. Host data partitioning (P5)

Verified 2026-10-23 (HEAD `bef52bd74`): the 53 refused `client.read` / `client.write` arms reach the brain over the desktop-writes, messages and sync bridges (`crates/cognia-companion-rpc/src/rpc/data_sync.rs`), except push tokens (one Rust JSON registry) and `sync_list_tables`. Handlers get no caller person and read `getDb()`, the single active account database. The bridge holds one brain slot (`ws_bridge.rs` `SOCKET_BRIDGE`).

**Shape.** On a multi-tenant `cognia-server`, each person whose paired device calls one of these arms is served by a brain process of their own: the existing headless brain started with the `person` profile.

- **Identity.** The person comes from the device's OIDC-verified binding (P1), never from the request. The partition's local account id is `pb_` + the first 24 hex digits of SHA-256(`org_id` NUL `user_id`).
- **Storage.** Data root `<data_dir>/persons/<account>/`. A random 256-bit content key per person is created on first start and kept in the encrypted server secret store, like the operator brain's key.
- **Lifecycle.** Started on the person's first request; the request waits up to the ready timeout, then `503 person_brain_unavailable` (retryable). Stopped after `COGNIA_PERSON_BRAIN_IDLE_SECS` idle (default 900). At most `COGNIA_PERSON_BRAINS_MAX` run at once: the least-recently-used idle brain is stopped first, and when none is idle the request gets `503 person_brain_capacity` (retryable). A brain with an in-flight request is never stopped. Crashes use the operator brain's backoff, per person.
- **Profile.** The `person` profile registers only the data runtimes (event publisher, sync source, message and write sources). No scheduler, connectors, bots, plugins, account sync, issue tracker, workflow triggers, rooms or sidecar. A roster test pins the list.
- **Token.** A person brain authenticates with scope `person-brain`, bound to its account. It opens only its own bridge slot; every `scope == "service"` check stays false for it.
- **Routing.** Bridge slots are keyed by account. In multi-tenant mode a host-data arm from a tenant device is sent only to the caller's person brain. There is no fallback to the operator brain or to the headless AppStore.
- **Admission.** Each request needs a bound person with live, non-guest org standing. Revocation lands at the next request.
- **Rust-only arms.** Push tokens are keyed by person account and device; push delivery for a person's events uses only that person's tokens.
- **Intentional dormancy (Rule 7).**
  - `pet_chat_send` and `pet_soul_generate` answer `503 model_access_unavailable` (Q11).
  - Message arms store and read history only. Replies need agent runs, which stay refused (`execution_isolation_unavailable`) until sessions run in a sandbox.
  - Desktop Hosts have no multi-tenant preflight, so they keep `host_data_unpartitioned`.
- **Unchanged.** Single-user mode, and the eight Host-global override arms, which stay on the operator brain behind `host.global-surfaces`.
- **Offboarding (Q12).** `cognia-server persons list` shows partitions with their last use and current standing. `cognia-server persons purge --org <org> --user <user>` stops the brain, destroys the key, deletes the data root and writes an audit record. A person who later rejoins starts with an empty partition.

### Sessions in a person partition (P5d)

Found in P5c (2026-10-23): a member can store and read history in their partition but cannot create a conversation. Conversations are created through HostState (`session.create` on `host_state_submit`). The person brain already hosts HostState, since its message source installs the write source. Four things stop the call:

- **Gate.** `host_state_*` and `host_feature_manifest` are classed by capability (`host.observe`, `workspace.write`), and that class is `workspace-action`. A member gets `403 host_surface_forbidden`.
- **Authority binding.** `rpc/host_state.rs` binds the operator's account namespace and the device's operator grants. It should bind the partition account.
- **Intent grants.** HostState authorizes `session.create` with `process.spawn` ("creating a session starts a runtime") and deletion, truncation and import with `host.admin`. A member holds neither.
- **Runtime target.** HostState requires an active runtime target whose account is the caller's.

**Shape.**

- **Routing.** On a multi-tenant Host with a fleet, `host_state_status`, `host_state_snapshot`, `host_state_submit` and `host_feature_manifest` from a tenant device are `host-data`. They go to the caller's person brain. The status and snapshot arms need `client.read`; submit needs `client.write`. These arms are listed in a policy key of their own, with reasons, in the same way as `personModelCommands`. Single-user and desktop Hosts are unchanged.
- **Authority.** Inside a partition, the bound account is the partition account and the Host id is the Host's. The caller is the owner of the partition. HostState authorizes by the partition policy below, not by the device's operator grants.
- **Partition policy.** These intents are allowed, because each one only changes the person's own data:
  - `session.create`, which writes a row and starts no runtime in a partition;
  - session metadata: rename, archive, pin, folder, order;
  - folders;
  - `draft.replace`;
  - `session.delete`, `transcript.edit`, `transcript.truncate` and `session.import`: the partition is the person's, and Q12 already makes them its owner.
- **Refusals.**
  - Intents that need a runtime (`message.enqueue`, `turn.*`, `approval.respond`, `elicitation.respond`) are refused per action with `execution_isolation_unavailable`. This is the same dormancy as the message arms.
  - `session.workspace` is refused with `workspace_unavailable`: a partition has no Host workspaces.
  - A `session.create` seed keeps a character only if the partition owns it, and drops `projectId`.
- **Negotiation.** `host_state_status` lists exactly the allowed intents, so a client does not offer a send button that always fails. `host_feature_manifest` reports the partition's scope and marks agent execution unavailable.
- **Runtime target.** A person brain activates its partition account's runtime target at boot.

## 10. Frontend (P3)

- **`lib/collab/capabilities.ts`.** Strict parser for the v1 response: unknown features and actions are dropped, unknown states map to `off`. `CollabClient.capabilities()` sends the protocol header. A `404` yields `{ status: "unsupported" }`.
- **`hooks/collab/use-org-capabilities.ts`.** Keyed by endpoint + local account + org + workspace. In-memory only, never Dexie. Refreshes on mount, scope change, window focus, collab refresh ticks and a 60 s interval. A response is discarded if its scope changed in flight.
- **Shell org switcher.** Shows the current org, the role, and switching. The switch logic is extracted from `account-identity-tab.tsx` into a shared hook so both surfaces use one path.
- **Workspace access summary card.** Current standing, granted actions and feature availability with localized reasons.
- **Ownership transfer dialog.** Owners only, backed by a new atomic `POST /v1/orgs/{org}/ownership-transfer`. Clear last-owner errors.
- **Entry-point gating.** Shared-chat convert/create, invites and run controls, plus Canvas collaboration, consult the capability decision on top of the existing build gate. Local state can only subtract. `existing-only` keeps existing sessions usable; `read-only` disables composer, attach and run controls with the reason.
- **`useMembershipAdmin`** prefers server `actions` and falls back to the existing Dexie-derived mirror only when capabilities are unsupported.
- **i18n.** All strings in split sources for en and zh-CN; reason and action labels are keyed by the contract's finite lists. A test checks that every contract entry has both locales.

## 11. Acceptance criteria

AC01–AC18 from revision 1 stand, with these changes:

- **AC05** adds demotion.
- **AC06** is narrowed to the §7.5 linearization.
- **AC07** distinguishes session Guests (survive workspace changes) from workspace Guests (lose access with the workspace grant).
- **AC15** distinguishes brokered from injected credentials.

New criteria:

| ID   | Given / when                                                                                       | Required result                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| AC19 | The app DB role is superuser or BYPASSRLS.                                                         | The server refuses to start unless explicitly overridden; `/health` reports the override.                            |
| AC20 | A tenant principal calls each Host surface class in multi-tenant mode.                             | Matrix holds; an unclassified surface is denied; the classification test fails when a new route is unclassified.     |
| AC21 | A policy row is absent, paused, killed, denied, canary at 0/50/100%, or has an unmet prerequisite. | Decisions match the evaluation order and the golden bucket vectors; reads, exports, leave and cancel stay available. |
| AC22 | An offboarded issuer's pending chat invite is accepted.                                            | Refused; the invite shows as unavailable.                                                                            |
| AC23 | A scoped internal credential queries another org.                                                  | `403`; unscoped single-credential deployments unchanged.                                                             |
| AC24 | A tenant device calls a `client.read` / `client.write` data command on a multi-tenant Host.        | Before P5: `403 host_data_unpartitioned`. After P5: it reads and writes only its own person's partition.             |
| AC25 | Persons A and B of one org use one multi-tenant Host; A writes messages, files, pet and issues.    | B's reads return none of A's rows; A's data root is encrypted with A's key only.                                     |
| AC26 | A person brain's token is presented to a route or check that accepts `service`.                    | Refused.                                                                                                             |
| AC27 | A departed member's device calls a data arm; the operator then purges them; they rejoin.           | `403` while departed, data kept; purge removes key and data root; after rejoining the partition is empty.            |
| AC28 | `COGNIA_PERSON_BRAINS_MAX` brains are busy and another person calls.                               | `503 person_brain_capacity`, retryable; an idle brain is stopped first when one exists.                              |
| AC29 | A member on a multi-tenant Host creates, renames, archives and deletes a conversation.             | Each is applied in their partition only; the other member's `session_list` never shows it.                           |
| AC30 | The member enqueues a message, steers a turn or moves a session to a workspace in their partition. | Per-action refusals `execution_isolation_unavailable` / `workspace_unavailable`; status never advertises them.       |
| AC31 | A single-user Host or a desktop Host receives the same HostState calls.                            | Behaviour unchanged: device grants decide, as before.                                                                |

## 12. Work packages and execution plan

Each package lands with co-located tests and a changeset where user-facing. Each is committed separately, only its own paths, per CLAUDE.md Rule 8.

| Package | Content                                                                                                                                                                                                                                                                                                                                 | Implementer                                          | Verification                                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| P0a     | §7 steps 1–6: `effective_member`, cleanup on offboard/removal/demotion, invite re-check, stream idle tick, metrics auth, `audit-standing`.                                                                                                                                                                                              | Codex `gpt-6.1-sol`                                  | `cargo test -p cognia-collab-server --lib`; new Postgres tests in `tests/postgres_rls.rs` run against local `postgres:16` (AC03–AC07, AC22). |
| P0b     | §7 DB roles: migration URL split, grants, privileged-role refusal, Compose init script and URLs, README.                                                                                                                                                                                                                                | Codex `gpt-6.1-sol`                                  | Unit tests + Postgres test with a superuser app URL (AC19); `docker compose config`.                                                         |
| P2      | §5–§6: action presets in `cognia-tenant-auth`, policy tables + migration 0016, evaluator, `rollout show/apply`, capabilities + internal endpoints, credential scopes, enforcement points, contract pinning, ownership transfer endpoint.                                                                                                | Codex `gpt-6.1-sol`                                  | Unit tests pin `protocol/*.json`; Postgres tests for CAS/audit and admission under lock (AC08–AC11, AC21, AC23).                             |
| P3      | §10 frontend.                                                                                                                                                                                                                                                                                                                           | Claude                                               | Co-located Jest, `pnpm i18n:build`, `pnpm lint:i18n`, typecheck of touched files, browser check of the switcher and summary card.            |
| P1      | §8: preflight, Host surface policy table + gating, `fault_disposition` wiring, Compose forwarding.                                                                                                                                                                                                                                      | Codex `gpt-6.1-sol`                                  | `cargo test -p cognia-companion`, `-p cognia-server`, `-p cognia-external-agent`; the classification exhaustiveness test (AC12, AC14, AC20). |
| P4      | §9: placement identity, mount policy, credential labeling, shared-run fences on heartbeat/complete, Host coordinator cancel on fence failure.                                                                                                                                                                                           | Codex `gpt-6.1-sol` (Rust) + Claude (TS coordinator) | Crate tests + `lib/collab/shared-run-coordinator.test.ts` (AC05, AC06, AC13–AC15).                                                           |
| P5a     | §9a Rust: person-brain fleet in `cognia-server` (account id, secret-store keys, lazy start, idle stop, cap), account-keyed bridge slots and routing, `person-brain` token scope, admission rule, push tokens per person, `persons list/purge`, policy and README. Measures an idle person brain's RSS and sets the default cap from it. | Codex `gpt-6.1-sol`                                  | Crate tests outside the sandbox; a two-person routing test over fake bridge transports; adversarial review (AC24–AC28).                      |
| P5b     | §9a TS: `person-brain` headless host kind and roster, `COGNIA_BRAIN_PROFILE=person` in `cognia serve`, diagnostics labels for `model_access_unavailable`, `person_brain_capacity` and `person_brain_unavailable`.                                                                                                                       | Claude                                               | Co-located Jest (roster pin, labels), `pnpm i18n:build`, `pnpm lint:i18n`.                                                                   |
| P5c     | End-to-end: two persons on one multi-tenant `cognia-server` with two paired devices.                                                                                                                                                                                                                                                    | Claude                                               | AC25 on a real server.                                                                                                                       |
| P5d     | §9a "Sessions in a person partition": HostState routing and authority binding for partitions (Rust), partition intent policy and status negotiation, person-brain runtime target (TS).                                                                                                                                                  | Codex `gpt-6.1-sol`                                  | Crate tests outside the sandbox; co-located Jest; rerun of the P5c rig (AC29–AC31).                                                          |
| P6      | Deferred: org suspend/delete, rate limits, credential broker, shared multi-agent sessions (AC16), real-service E2E lane (AC17–AC18).                                                                                                                                                                                                    | —                                                    | Separate plan.                                                                                                                               |

Order: P0a → P0b → P2 → P1 → P4 → P5 (P5a and P5b in parallel, then P5c, then P5d), one Codex implementation job at a time. P3 runs in parallel against the contract files and switches to the live endpoint once P2 lands. Every Codex job is followed by Claude review of the diff, a rerun of its verification commands, and an adversarial Codex review on security-relevant packages (P0a, P2, P1).

Rollout stages (revision 1 §10) remain the operating procedure once P0–P4 ship:

- For small deployments, use explicit allowlists rather than 1% steps.
- Security failures have zero tolerance.
- Expansion is always an explicit operator action.

## 13. Risks

| Risk                                                                          | Mitigation                                                                                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Privileged-role refusal breaks existing Compose installs on upgrade.          | Release note plus README migration steps; the explicit override keeps them running with a visible `rls: bypassed` until migrated.                 |
| Host surface gating blocks a legitimate admin flow.                           | Single-user mode is untouched; multi-tenant admins hold `host.global-surfaces`; the classification table is reviewed route by route.              |
| Lock ordering across many sessions during offboarding.                        | Ascending-id `FOR UPDATE` before membership deletes; one deadlock retry; the read-time ceiling makes correctness independent of cleanup timing.   |
| Per-request policy reads add latency.                                         | One indexed row per feature inside an existing transaction; measure in the Postgres tests before adding any cache.                                |
| Multi-tenant Hosts lose Host-side chat, files and other client data until P5. | Intentional and labeled (`host_data_unpartitioned`); single-user unaffected; collaboration data stays available through the collaboration server. |
| Disk pressure during Rust builds (≈4 GB free at planning).                    | One Rust job at a time; check free space between jobs.                                                                                            |

## 14. Source index

- Identity: [types](../../types/identity/index.ts), [Rust roles](../../crates/cognia-tenant-auth/src/roles.rs), [membership resolver](../../crates/cognia-tenant-auth/src/membership.rs), [RLS contract](../../crates/cognia-tenant-auth/src/rls.rs).
- Collaboration: [API](../../crates/cognia-collab-server/src/api.rs), [store](../../crates/cognia-collab-server/src/store.rs), [chat API](../../crates/cognia-collab-server/src/chat_api.rs), [chat store](../../crates/cognia-collab-server/src/chat_store.rs), [session policy](../../crates/cognia-collab-server/src/chat.rs), [feed](../../crates/cognia-collab-server/src/feed.rs), [binary](../../crates/cognia-collab-server/src/main.rs), [Postgres tests](../../crates/cognia-collab-server/tests/postgres_rls.rs).
- Host: [deployment mode](../../crates/cognia-companion-security/src/deployment.rs), [router](../../crates/cognia-companion/src/server.rs), [workspace authority](../../crates/cognia-companion/src/workspace_access.rs), [server boot](../../crates/cognia-server/src/main.rs), [environment policy](../../crates/cognia-environment/src/policy.rs), [baseline](../../crates/cognia-environment/src/catalog.rs), [sandbox boot](../../crates/cognia-sandbox-pool/src/boot.rs), [sandbox routing](../../crates/cognia-external-agent/src/sandbox_routing_backend.rs).
- Frontend: [collab client](../../lib/collab/client.ts), [runtime context](../../lib/collab/runtime-client.ts), [membership admin](../../lib/collab/membership-admin.ts), [admin hook](../../hooks/workspace/use-membership-admin.ts), [members UI](../../components/workspace/workspace-members.tsx), [account identity tab](../../components/account/manage/account-identity-tab.tsx), [shared-chat gate](../../lib/collab/shared-chat-feature.ts), [Canvas flags](../../lib/canvas/feature-flags.ts), [team refusal](../../lib/collab/shared-chat-conversion.ts).
- Deployment: [base Compose](../../deploy/compose/docker-compose.yml), [production](../../deploy/compose/compose.production.yaml), [T2](../../deploy/compose/docker-compose.t2.yml), [Caddyfile](../../deploy/compose/Caddyfile).
- ADRs: [0054](../content/docs/en/adr/0054-local-multi-account-isolation.md), [0059](../content/docs/en/adr/0059-cloud-deployment-headless-brain.md), [0149](../content/docs/en/adr/0149-a-person-is-not-a-device.md), [0177](../content/docs/en/adr/0177-a-room-is-one-conversation-shape.md).
