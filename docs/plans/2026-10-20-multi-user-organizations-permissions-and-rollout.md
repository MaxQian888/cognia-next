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

| ID  | Decision                                        | Recorded choice and consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Meaning of "space"                              | Reuse Workspace under Org. Personal space stays local/private; it is never published into an organization automatically.                                                                                                                                                                                                                                                                                                                                                                             |
| Q2  | Developer role                                  | No new stored role. `member` keeps its wire value; "Developer" may be a UI label later. Finer control comes from fixed **action presets** derived from standing (`protocol/collab-capabilities-v1.json`).                                                                                                                                                                                                                                                                                            |
| Q3  | Org-admin privacy                               | Org owner/admin traverse workspaces for management; they never gain session _content_ without explicit session membership or the audited break-glass path.                                                                                                                                                                                                                                                                                                                                           |
| Q4  | Who creates organizations                       | Operator-created tenants plus invitations. Self-service creation is out of scope.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Q5  | Shared-feature cohort                           | The organization. Workspace rules may only narrow.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Q6  | Session-only Guests                             | **Kept.** A non-guest session member's effective standing is capped by their _current_ org/workspace standing. A session Guest's standing comes only from the session (role ceiling, invite expiry, explicit removal). Workspace changes never remove a Guest by accident. No data migration.                                                                                                                                                                                                        |
| Q7  | Trust inside one organization                   | **Members of one org do not fully trust each other at the OS level.** In multi-tenant mode, raw Host surfaces are limited to `host.workspace-surfaces` (workspace maintainer+) and `host.global-surfaces` (org owner/admin). Ordinary members execute only through the sandbox pool. Without a conforming sandbox the Host advertises execution as unavailable; it never falls back to a host process.                                                                                               |
| Q8  | Rollout control plane                           | **Lean.** Per-feature DB policy row, per-request evaluation inside the owning transaction, CAS + audit through an operator subcommand. No publication worker, snapshot, feed invalidation or decision cache in v1.                                                                                                                                                                                                                                                                                   |
| Q9  | Pause vs kill                                   | Pause / not-offered → `existing-only` (no new resources or runs; existing work drains). Kill → `read-only` (also no content mutation; read, export, leave, cancel, delete remain).                                                                                                                                                                                                                                                                                                                   |
| Q10 | Host data partitioning (2026-10-23)             | **One brain process per person** on multi-tenant Hosts. The brain stays single-account by design (`getDb()` is a process singleton used by ~780 files), so partitioning happens at the process boundary, not per request or per row. See §9a.                                                                                                                                                                                                                                                        |
| Q11 | Model calls from person partitions (2026-10-23) | `pet_chat_send` and `pet_soul_generate` stay intentionally dormant on multi-tenant Hosts (`503 model_access_unavailable`) until the P6 credential broker. A person partition starts with no provider configuration.                                                                                                                                                                                                                                                                                  |
| Q12 | A departed member's Host data (2026-10-23)      | **Kept but inaccessible.** Standing is checked on every request, so access ends at once. Data and key stay until an operator runs `cognia-server persons purge`; nothing is deleted automatically.                                                                                                                                                                                                                                                                                                   |
| Q13 | Member agent turns (2026-10-24)                 | **With tools, in a sandbox.** A member's turn runs a bundled external agent inside a sandbox-pool container with gVisor or VM isolation. It never runs in a Host process or the shared sidecar. Cognia's own agent does not run in the sandbox. **Amended 2026-10-24 (P6c):** a member may also chat with Cognia's own agent with no tools at all (`toolSurface: "none"`, enforced by the Host). That tool-less turn runs in the Host's shared sidecar; any turn with tools still needs the sandbox. |
| Q14 | Org model credentials (2026-10-24)              | **Org owner/admin configure them in the app**, with an operator CLI as fallback. Keys live only in the Host's encrypted secret store and are never shown again. Members use them only through brokered gateway tickets.                                                                                                                                                                                                                                                                              |
| Q15 | Member usage (2026-10-24)                       | **Monthly token cap per member.** The org admin sets a default; unlimited is allowed. Over the cap, the member gets a clear refusal. Admins see each member's usage.                                                                                                                                                                                                                                                                                                                                 |
| Q16 | Agents members may run (2026-10-24)             | **Org admin allowlist** over the bundled agents, with a default. An agent is offered only when an org credential covers its provider.                                                                                                                                                                                                                                                                                                                                                                |
| Q17 | Member working directory (2026-10-24)           | **One persistent personal workspace per member.** Files persist across conversations, with a size cap. It is purged together with the member's partition.                                                                                                                                                                                                                                                                                                                                            |

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

## 9b. Member agent turns with org credentials (P6)

Verified 2026-10-24 (HEAD `f78e9f1840`), code-read:

- **No model path from a partition.**
  - Route tickets are service-only. They take no principal and are owned by the gateway's single account (`provider_admin.rs` `mint_bridge_ticket`, `crates/cognia-gateway/src/lib.rs` `mint_route_ticket`).
  - Provider credentials are Host secrets keyed by (kind, name), with no org dimension (`crates/cognia-secrets/src/host_secrets.rs`).
- **The sandboxed agent path exists.**
  - `spawn_external_agent` runs a bundled agent CLI, from `deploy/bundle/agent-versions.json`, in a sandbox-pool container (`crates/cognia-sandbox-pool/src/docker.rs`).
  - Placement is Host-stamped (`PlacementBinding`). Credentials are `Brokered` when only `COGNIA_GATEWAY_TOKEN` / `COGNIA_GATEWAY_TASK_CONFIG` enter the container.
  - Output returns as `external-agent://*` events, persisted as chat parts.
  - Multi-tenant pools need gVisor or VM isolation and the local driver.
- **The run binding is a workspace.** A partition has none. The session scratch workspace (`EnsureSessionScratchWorkspace`) has no person or org owner.
- **Usage ledgers.** No per-member monthly ledger exists. Route tickets reserve and settle per ticket only.

**Shape.**

1. **Org credentials (P6a).**
   - **Storage:** Host secrets gain an org scope: kind `org-provider`, key `<org_id>/<provider>`.
   - **Operations:** set, list (metadata only: provider, fingerprint, updatedAt, updatedBy) and delete.
     - App: org owner/admin, through the Host as an org-action under a new `org.model-credentials` action.
     - CLI: `cognia-server org-credentials …`.
   - **Disclosure:** keys are never returned. Every change is audited.
   - **Approval (decided 2026-10-24):** every org write (keys, allowlist, caps) is authorized by the caller's live org owner/admin standing and the signed device request alone. Neither Host-operator consent nor an admin lease is asked for, because a cloud Host has no operator at hand.
   - **Allowlist:** an org agent allowlist with a default (Q16) is stored next to the keys. An agent is offered only when an org credential covers its provider.
2. **Usage ledger and cap (P6b).**
   - **Ledger:** a Host table keyed by (org, member account, UTC month) with `reserved` and `spent` tokens, plus an org default cap and per-member overrides (Q15).
   - **Admin operations:** set the cap and read per-member usage, both under the same org action.
   - **Refusal:** over the cap gives `429 member_usage_cap_reached`, which is not retryable before the month rolls over.
3. **Partition tickets and tool-less member chat (P6c).**
   - **Correction (2026-10-24):** the pet cannot be the first outcome. No headless brain has a pet: every `pet_*` arm answers `headless-host` there, on single-user Hosts too. The pet arms leave `personModelCommands` and get that same honest answer from the person brain.
   - **Brain-to-Host channel:** a person brain's token is accepted on loopback `/internal/_rpc` and `/internal/events` too, but dispatch admits only a fixed list (`person_model_ticket_mint` and the agent send, interrupt and close arms). Every other command is `403 host_surface_forbidden`. The two sockets skip route admission (they check the live generation themselves, and events are filtered per frame); `agent_close_session` closes only the caller's own or a never-bound session, so a replayed turn can retire stale runtime context.
   - **Mint:** `person_model_ticket_mint { provider, model, sessionId }` mints a route ticket for the caller's own partition only. The ticket names the partition (owner account) and the member, and carries the org credential as a provider override on top of the Host's provider profile (base URL, protocol, models). The key never reaches the brain. With no org credential for the provider: `503 model_access_unavailable`. Changing or deleting the org credential revokes the org's outstanding tickets for that provider.
   - **Budget:** reservations settle against the member's monthly ledger (P6b), so `429 member_usage_cap_reached` applies.
   - **Tool-less turn:** the Host enforces it for a person brain's `agent_send`, whatever the brain sends: no tools, MCP servers, plugins, hooks or subagents; the provider credential must be a ticket owned by the caller's partition, pointed at the Host gateway; the session is bound to the partition on first send, and another partition (or the operator brain) cannot drive it.
   - **Events:** sidecar events of a partition's session reach only that partition's brain and devices, never the operator brain or another partition.
   - **Brain:** the person brain gains the HostState dispatcher and reply write-back for `message.enqueue` (and turn cancel), allowed only when the Host advertises partition chat; approvals and elicitations stay refused (a tool-less turn raises none). Its artifact keys (work submissions, evaluations) derive from its own account content key, because the Host keyring is shared by every partition.
   - **Verified (2026-10-24, P6f rig):** without an org key the enqueue operation fails `model_access_unavailable`; with one the member gets the fixture reply through the Host gateway, the turn settles `completed` and their usage grows; capped at 1 token the gateway refuses the reservation with `429 member_usage_cap_reached`, the turn ends `fatal-error` and nothing is spent. Known gap: the session binding lives in Host memory (a Host restart forgets it, so the first send rebinds). The 429 retries, the enqueue left `dispatching` and the code-less `fatal-error` were fixed by item 9.
4. **Personal workspace and partition execution (P6d).**
   - **Workspace:** each partition gets one persistent personal workspace under `COGNIA_WORKSPACES_DIR/persons/<account>/` (Q17), with a size cap. Purge deletes it.
   - **Admission:** a person brain may call the external-agent spawn, status and kill arms for its own partition. Admission comes from the partition: the person's live org standing, and the person as owner of their own workspace. The binding is the personal workspace.
   - **Placement:** a sandbox is mandatory. Credentials must be brokered, and the ticket comes from P6c. Remote providers stay refused.
   - **Without a sandbox:** with no conforming pool, it stays `execution_isolation_unavailable`, labelled as today.
   - **Surface:** `personBrainCommands` gains `person_agent_lease_prepare`, `spawn_external_agent`, `get_external_agent_status` and `kill_external_agent`; `send_to_external_agent` waits for P6e. The lease is a member-billed task ticket owned by the partition (120 s), the spawn must name an allowed bundled runtime with its catalog launch, and the Host writes the broker configuration itself. Refusals: `org_agent_not_allowed`, `model_access_unavailable`, `credential_delivery_refused`, `workspace_mount_forbidden`, `execution_isolation_unavailable`, `507 person_workspace_quota_exceeded` (`COGNIA_PERSON_WORKSPACE_MAX_BYTES`, default 5 GiB; a 30 s watchdog stops a live run that grows past it). Events of a person run reach only that partition's brain and devices.
   - **Verified (2026-10-25, P6f rig, gVisor `runsc` release-20261019.0 under colima, locally built `claude-agent-acp` bundle):** as member bob, the lease and spawn succeed and the run starts in a `runsc` container with network `none`, `cap-drop ALL`, the read-only bundle volume, and one bind mount, `persons/<bob>/` → `/workspace`. The binding is `{org, person:<bob>, usr_smoke-bob, runId}`, and the only credential inside is the gateway task token. Bob's brain sees `placement` (`gvisor`), `spawn` and `state-change`; the other member sees none of them, and her status and kill on bob's run get `403 host_surface_forbidden`. Refused live: `codex-acp` (not allowed), provider `openai` (no org key), an injected `ANTHROPIC_API_KEY`, cwd `/tmp`, execution disabled (no advertisement, `503`, no container), and a full workspace (`507` with `usedBytes`/`maxBytes`). Over the 1 MiB rig cap, the watchdog stopped every live run within 20 s, with `reason: person_workspace_quota_exceeded` on its `state-change` and `exit` events. Purge with a live run stopped the container, then removed the workspace and both record stores. The run caught a purge bug: it read the records from the brain's data dir, not the runtime's binding root.
   - **Known gaps:** `get_external_agent_status` on a run its owner already killed answers `403` (the record is retired), so P6e must follow the `exit` event; external-agent channels are off by default, so a brain subscribes before it sees them; the lease mints even with execution disabled (it is useless without a spawn and expires in 120 s); the person mount check derives its workspace root from the binding root, so a Host without `COGNIA_WORKSPACES_DIR` refuses person mounts (fail closed; the Docker driver requires the variable anyway).
5. **Partition agent sessions (P6e).**
   - **Runtimes:** the person profile gains the external-agent runtime pieces needed to drive a session.
   - **Dispatch:** HostState `message.enqueue` and the turn intents become allowed when the Host advertises partition execution. They dispatch to the session's external agent.
   - **Agent choice:** the session's agent must be on the org allowlist.
   - **Negotiation:** `session_attach` `supportedActions` follows. Without execution the P5d refusals stand.
   - **Surface (decided 2026-10-25):**
     - A session seed may carry `agentRuntimeId` (kept only for a partition and only for a catalogued runtime). Otherwise the org `defaultAgent` runs. With neither, the turn stays tool-less chat.
     - `person_agent_policy_get` (added to `personBrainCommands`, with `send_to_external_agent`) gives the brain the allowlist, the default and `execution`.
       - The brain refuses `org_agent_not_allowed`, `execution_isolation_unavailable` or `model_access_unavailable` before any lease.
       - The Host checks every lease and spawn again.
     - One long-lived sandboxed agent per session (`lib/headless/person-agent/`), reused while runtime, provider and model match. It is stopped after 15 minutes idle. A fresh agent gets the earlier transcript once.
     - Tool permissions are granted automatically inside the sandbox. Elicitations and async questions are declined. Approval and steer intents stay refused.
     - The partition owns a closed process plane:
       - The spawn is rebuilt to the Host contract: no client sandbox, and only the gateway token, task config and locale env.
       - Files and terminals are refused.
       - The Host's stop reason (`person_workspace_quota_exceeded`, `host_authority_unavailable`, …) becomes the turn's error.
     - A message queued behind a running turn reports `queue accepted` and then `delivered` or `dropped`.
     - New diagnostics: `person_agent_exited` and `person_agent_attachment_unsupported`; documents are refused.
     - `cognia serve` removes the CLI's local process table for a person brain, so a member brain cannot spawn on the Host.
     - Claude Code's commit attribution (`noreply@anthropic.com`) tripped the gateway PII gate. Both the Host broker and the operator gateway task now write `claude/settings.json` with attribution off, and the sandboxd task-file allowlist admits that file.
   - **Verified (2026-10-25, P6f rig, gVisor, `claude-agent-acp`):** the persons tier is green twice, once against the deterministic fixture and once against a real model (`ark-deepseek-v4.1-flash` through an OpenAI-compatible proxy, set as the org `deepseek` deployment).
     - Member ada's explicit `claude-agent-acp` session and her org-default session both settle `completed` with a reply, and her usage grows (7120 → 23648 tokens on the real model).
     - `codex-acp` is refused `org_agent_not_allowed` before any spawn.
     - The P6c tool-less chat, keyless and cap checks still pass, and so does the purge.
     - The agents run in `runsc` containers with network `none`, mounting only `/workspace` and the bundle. Claude Code itself reports `Linux 4.19.0-gvisor` with cwd `/workspace`.
     - The real-model run found two gateway translation refusals for Claude Code against non-Anthropic upstreams, both fixed in `crates/cognia-gateway/src/translate/`:
       - a mid-conversation `role: "system"` message now joins the IR system prompt, recorded as a merged loss;
       - `thinking: {"type":"adaptive"}` crosses as the reasoning effort alone, recorded as an approximated loss. Budgets stay refused.
   - **Known gaps:**
     - Agent output reached devices only as persisted message writes, throttled to 1 s and written at settle. Live replies landed later (item 8).
     - Members could not pick the agent from a device before P6g (now done, see item 6).
     - The manifest's `claude.tool-less-chat` health is unchanged.
     - The local rig bundle is the p6d image with a rebuilt `cognia-sandboxd` layered on top, not a full bundle build.
6. **Frontend (P6g).**
   - **Admin page:** org admin settings for model credentials, allowed agents, caps and usage. It reuses the org admin surfaces.
   - **Member UI:** an agent picker limited to the allowlist, plus labels for the cap and for missing credentials.
   - **Decisions (2026-10-25):**
     - The person brain writes the member's agents into its own `host_feature_manifest`, as `personAgents`, beside `personPartition`. No `org_*` command is opened to members.
     - The agent is chosen only when a conversation is created (seeded `agentRuntimeId`). An existing conversation shows its agent, locked.
     - The picker shows what is left of the member's month before a turn is refused.
   - **Surface:**
     - Host: `person_agent_policy_get` gains `models` (the org-served model ids per allowed provider, from the gateway snapshot) and `usage` (the caller's own month: spent, reserved, cap; `null` without a ledger). `org_policy::person_own_usage` reads only the caller's row.
     - Brain: `lib/companion/desktop-write-source.ts` adds `personAgents` (allowlist, default, execution, models, usage) to the partition manifest, bounded at 5 s and left out when the read fails. `lib/platform/host-feature-manifest.ts` validates it strictly and refuses it without `personPartition`.
     - Client: the runtime snapshot carries `host.personAgents`. `hooks/chat/use-person-agents.ts` re-reads it on demand. `components/chat/composer/person-agent-chip.tsx` replaces the runtime selector on a member partition: it names the conversation's agent (locked), warns about an agent the org no longer allows, a Host without member execution, a missing org key, a model the org does not serve, or a used-up month, and starts a new conversation with an allowed agent seeded with an org-served provider and model (`lib/chat/person-agent-choice.ts`, `startNewSession` → `hostSessionSeed`).
     - Admin: `components/devices/org-models/org-usage-panel.tsx` in the org models section shows each member's month against their cap and edits the default cap and per-member caps (limit, unlimited, back to the default) through `org_member_usage_get`, `org_usage_cap_set` and `org_member_usage_cap_set`.
   - **Verified (2026-10-25, P6f rig, real `ark-deepseek-v4.1-flash`):** the persons tier is green, including a new check that member ada's own manifest lists `claude-agent-acp`, the served `deepseek` model and a month that covers her charged turns, and names no other person or provider outside the allowlist. Jest covers the manifest round trip and refusals, the snapshot patch, the seed, the chip's labels and the usage panel's edits.
   - **Verified in a browser (2026-10-25, P6f rig, with item 8):** a dev browser paired to the rig Host as ada over OIDC (`cognia-server pair --tenant-id … --advertise-url http://127.0.0.1:27891 --direct` with `COGNIA_DEPLOYMENT_MODE=multi-tenant`; the Host runs `--browser-listener-port 27891` with `COGNIA_ALLOWED_WEB_ORIGINS`).
     - The chip names a conversation's agent (locked), shows the month ("No monthly limit · 279K tokens used"), starts a new conversation with `claude-agent-acp`, and warns on a conversation whose model the org stopped serving.
     - The usage panel lists both members against the default cap, and removing the Anthropic key through the org models section seeds the next new conversation with the only served model, `ark-deepseek-v4.1-flash`.
     - The check found the member composer had never worked; item 8 fixes it.
   - **Known gaps:**
     - ~~Members are listed by organization user id; the Host has no display names to give.~~ Fixed by item 12.
     - A Host older than P6g sends no `models`, so the picker labels every agent "no model" and cannot seed one.
     - ~~A default new conversation is not corrected to an org-served provider and model.~~ Fixed by item 10.
     - ~~The composer's model picker lists the browser's own providers, not the models the org serves.~~ Fixed by item 10.
7. **E2E lane (P6f).**
   - **Compose:** fix `cognia-server-cloud` in `docker-compose.web-headless-e2e.yml`: master key, collab service credential, `COGNIA_EXECUTION=disabled`, and the brain fleet.
   - **Smoke tier:** a `persons` tier in `scripts/smoke/compose-smoke.mjs`. Two OIDC persons of one org pair into one Host, using the fixture's `/e2e/token`, device registration and signed RPC. It checks:
     - isolation;
     - HostState sessions;
     - dormancy;
     - purge;
     - once P6c lands, a member's tool-less chat reply through an org credential pointed at `anthropic-fixture`, charged to that member's usage.
   - **CI:** wired into `compose-e2e.yml` tier 2. Sandboxed turns need gVisor, so the sandbox half runs only where `runsc` is available and is otherwise reported as skipped.

8. **Live member replies and member event streams (P6e follow-up, 2026-10-25).**
   - **Decisions:** the person brain sends part snapshots of the reply in flight on a person-only topic; the client draws them as the live tail and hides the timeline's copy of that turn. A member device gets an event stream of its own partition only.
   - **Surface:**
     - Brain: `lib/headless/person-agent/runner.ts` encodes the reply with `lib/chat/transcript/live-frames.ts` (changed parts every 100 ms, a keyframe every 2 s, `settled` with the transcript revision it lands at, `reset` when a frame passes 200 KiB or the turn ends without parts) and publishes `transcript://live`.
     - Host: `ws_bridge.rs` accepts the topic from a person brain only, rebuilds the frame from its known keys (256 KiB cap), paces streaming frames to 50 ms per member session, and publishes one partition-stamped, never-replayed frame (`EventBus::publish_person_ephemeral`), so it reaches exactly that member's bound devices. The catalog entry is off by default.
     - Member event streams: `host_surface_gate::events_audience` admits a member with data standing in their partition to `/ws/events` (owners and admins keep the Host-wide stream); `ws.rs` re-checks it on every heartbeat and closes the socket when standing ends; the relay data channel (`signaling/dispatch.rs`) applies the same audience, which also closes a pre-existing leak of Host-wide frames to members over the relay.
     - Client: `TranscriptSource.subscribeLive`, `hooks/chat/use-transcript-live-turn.ts` and `lib/chat/transcript/live-turn-view.ts` draw the live reply in `CompanionTranscriptMessages` and let go of it once the timeline reads past its revision (10 s at most).
     - Member composer: on a person partition the send gate reads `agent_send` (the brain declares it healthy exactly when it runs partition chat), and a member's turn goes in as HostState `message.enqueue` (`hostStateSendEligible` gains `personPartition`). Before this the gate read `claude_send`, which is always isolated there, and a direct `agent_send` from a member device is refused.
     - Retry: gate refusals that describe the deployment (`execution_isolation_unavailable`, `model_access_unavailable`) are sent `retryable: false`, and the transport keeps its RPC plane ready on a 503 the Host marks non-retryable. Before, an open conversation's context-usage probe on a multi-tenant Host marked the plane down, and the boot provider's recover → resync loop drained the read quota and pinned the browser on "Reconnecting".
   - **Verified (2026-10-25, P6f rig, `ark-deepseek-v4.1-flash`):**
     - The persons tier is green with new checks: ada's device receives at least two live frames for her agent turn, the first a streaming keyframe, sequence numbers rising, and a settled keyframe whose text equals the kept message; member bob's device is issued an events ticket and receives none of ada's frames.
     - In the browser (item 6), three member turns streamed: 52–54 frames each, median gap 101 ms, a keyframe every 20 frames, and one settled keyframe; the screen drew the reply as it grew and each reply appears once after settle.
   - **Known gaps:**
     - A reply whose frame passes 200 KiB stops live delivery for that turn; the timeline catches it up at settle.
     - Agent stdout reaches the brain over the Host's event bus, which closes a lagging subscriber; a burst that lags the brain's socket can corrupt a turn. Per-device fan-out of purge invalidations (`publish_person_to`) is one such burst.
     - ~~The Host's title replaces the browser's optimistic title after the first turn, which briefly re-mounts the transcript.~~ Fixed by item 15.

9. **Readable member turn failures (P6c follow-up, 2026-10-25).**
   - **Decisions:** a failed turn carries the runtime's failure code into HostState, and a member's devices show the diagnostics catalog's explanation for it (or for the code a refused send failed with) as the chat banner. Only a short identifier crosses: never the provider's message or body.
   - **Surface:**
     - Gateway: the cap refusal sends `x-should-retry: false` (read by the Anthropic and OpenAI SDKs, so by Claude Code and Codex in the sandbox) and names its code in the message, because an agent CLI reports only the message.
     - Sidecar: `providerForbidsRetry` (`sidecar/src/providers/http-error-meta.ts`) reads that header or a `retryable: false` body; a model middleware re-marks such an APICallError non-retryable for the AI SDK's own retries, and the runtime's transport loop stops on it. `session_ended` keeps its own code on the canonical `failure` (it was always `session_error`). The AI SDK runtime now reports each turn `running` (`session_state_changed`), so HostState starts the turn; it went from `queued` straight to its end before.
     - HostState: `HostStateSessionChannel.turnErrorCode` (set by an error `turn.settled`'s `errorCode`, cleared by the next turn; `isTurnErrorCode` bounds it). A new turn counts the oldest queued message no runtime confirmed (`accepted` or `dispatching`) as delivered: dequeued and `acknowledged`. A send the Host abandons for good is `message.dropped`, so it leaves the queue.
     - Brain: the person-agent runner lifts `member_usage_cap_reached` / `member_usage_unavailable` out of the agent's error text (closed list) and drops a reply that was only that refusal. `ws_bridge.rs` gains the person brain's `companion_host_state_publish` arm, partition-stamped: without it every HostState change of a member brain was dropped, and member devices saw turn state only on a snapshot.
     - Client: `persistConfirmedState` shows the failure once per failure id (a dismissal sticks) and clears only its own banner; `member_usage_unavailable` maps to `serviceUnavailable`.
   - **Verified (2026-10-25, P6f rig, `ark-deepseek-v4.1-flash`):** persons tier green with new checks. Over the cap the tool-less turn fails in 1.2 s (was 20.5 s of retries) and the agent turn in 1.9 s, both `member_usage_cap_reached`, nothing spent, no raw "API Error" reply kept; the keyed message settles `acknowledged` with an empty queue. In the browser as ada: a send in a chat whose model has no org key shows "No model access on this shared Host" live, and a send in a DeepSeek chat with a 1-token cap shows "Monthly allowance used up" live, with the chat marked in the sidebar.
   - **Known gaps:** a refused message leaves the queue, and the Host never wrote it, so the member's text is gone once the transcript syncs (the banner says why; the text is not given back to the composer). A Host restart re-shows a failure banner once per client.

10. **Members default to org models (P6g follow-up, 2026-10-25).**
    - **Decisions:** a member's new conversation starts on a model the org serves, and the model menu offers only those. A conversation's model can change: the pick is a HostState intent, so the Host records it and its next turn runs on it. The agent stays fixed at creation.
    - **Surface:**
      - Host: `person_agent_policy_get`'s `models` also names every other provider the org holds a key for and this Host serves, because tool-less chat mints on any of them. It never names a provider without an org key. The tool-less mint and the agent lease refuse an unserved model as `model_access_unavailable` (503); before, it was a bare `malformed_request` (400).
      - HostState: `session.model { provider, model }`, bounded like a session seed pick. It is priced `workspace.write`, since it re-points only the next turn, the same as `session.workspace`. It is allowed on a person partition, because the org policy still decides at the turn, and it does not need live control. The Host writes `model` and `providerOverride` on its `sessions` row with no channel mutation; replicas learn the row through table sync. A Host that does not know the intent gets the local write the client made before (`host-state-intent-settlement.ts`).
      - Client:
        - `lib/chat/person-agent-choice.ts` adds `personServedModels` (the agent's providers for an agent conversation, every served provider for chat) and `personDefaultModel`. Chat now reports `chat-model-not-served`.
        - `startNewSession` re-points a member's new conversation to an org-served model after creation, keeping the default preset.
        - `components/chat/composer/model-picker.tsx` on a member partition lists only `personServedModels` under "Your organization's models", hides Auto and this device's providers, names the model a new conversation will start on, and sends a pick in an existing conversation as `session.model`. Any HostState-routed conversation sends it, not only a member's; the local write and live switch stay for the rest.
    - **Verified (2026-10-25, P6f rig, `ark-deepseek-v4.1-flash`):**
      - The persons tier is green with new checks: a tool-less turn on `smoke-unserved-model` fails `model_access_unavailable`; a `session.model` pick to the served model makes the same conversation's next turn complete with a reply; the member manifest names no provider the org holds no key for.
      - In the browser as ada, the welcome composer's model chip reads `ark-deepseek-v4.1-flash` and its menu lists only that model, with no Auto row. The first send creates a conversation on that model and gets a DeepSeek reply.
      - A conversation on Claude Sonnet 5.5 shows the chat warning. Picking the DeepSeek model clears the warning once the Host's row syncs back (nothing is written locally), and the next send replies.
      - The agent chip renders on member partitions as the dense glyph at the right of the toolbar. The earlier report of a missing chip did not reproduce.
    - **Known gaps:**
      - ~~The menu names models by id; the gateway snapshot has no display names to give.~~ Fixed by item 16.
      - An agent conversation offers only its agent's providers, so a chat-only provider cannot be picked there.
      - ~~The member browser polls `bot_console_read` (403) and `claude_session_context` (503) on a partition.~~ Fixed in item 11.

11. **Member actions follow what the Host offers (P6 follow-up, 2026-10-25).**
    - **Decisions:** a client reads the `supportedActions` the Host answers `host_state_status` with and hides or disables what it leaves out, saying why. A refused intent no longer fails silently. A message a member sends while their turn runs is queued on the Host and runs as the next turn, because members cannot steer.
    - **Surface:**
      - Client:
        - `lib/sync/host-state-offered-actions.ts` records the answer per Host scope. Every installed sync publishes it, re-reads it on resync and retracts it on stop; installs are counted per target. No answer means "not restricted".
        - `enqueueHostStateIntentIfAvailable` throws `HostStateActionNotOfferedError` for a kind the Host leaves out and queues nothing. It does not fall back to a local write behind the Host's back.
        - `useHostStateActionOffered` gates "Move to workspace": the row menus drop it, and session settings disables the picker with the reason. The chat controller sends a mid-turn message as `message.enqueue` where `turn.steer` is not offered.
        - A rejected change is announced with the `hostStateIntentRefused` diagnostic: rename, archive, pin, folder, order, workspace, model, delete and the folder intents. Conflicts, sends, drafts and the old-Host fallback are not announced.
        - `useBotHostRead` stops polling after a refusal the Host marks final. `useSdkContextUsage` asks only a Host that offers `claude_send`.
      - Brain:
        - Tool-less member chat had no queue. A second send rehydrated the history (`replacesHistory`), which closed the running turn, and the message sat in `dispatching` with no turn. `lib/claude/person-chat-turn.ts` now keeps one line per conversation (`admitPersonChatTurn`).
        - The dispatcher projects `queue accepted`/`delivered` (or `dropped` with the failure code) for a held message, like the person-agent runner, and frees itself while the message waits.
        - The line is released only after the turn's settlement has written its reply (`lib/work-submission/terminal-events.ts`), or when the sidecar exits.
        - Settlement replaces the transcript with the turn's mirror. It now keeps rows written after that mirror was loaded. Before, it deleted the user row of a message the Host accepted mid-turn.
    - **Verified (2026-10-25, P6f rig, `ark-deepseek-v4.1-flash`):**
      - The persons tier is green with a new check: two messages sent back to back both reach `acknowledged`, both user rows stay in the transcript, and both get a reply. Before the fix the second stayed `dispatching` forever and its user row was deleted.
      - In the browser as ada:
        - Two sends 400 ms apart both ran, in order.
        - The row menu has no "Move to workspace". Session settings shows the picker disabled with "This shared Host doesn't let members move conversations between workspaces."
        - `bot_console_read` is asked once per page, and `claude_session_context` is not asked.
    - **Known gaps:**
      - A member's browser still repeats some refused reads: `background_job_list` and `background_monitor_list` (403 on each turn), `session_mark_read` (403), and `socket-ticket` (503).
      - The refusal toast is pinned by unit tests only. With the offered gate, the browser has no path to a refused change.
      - Stopping a running tool-less turn lets the next held message start, as the sidecar queue does for an owner.

12. **Members named in the usage panel (P6g follow-up, 2026-10-25).**
    - **Decisions:** the Host names each member of its usage report as the org's collaboration plane knows them. The name is a label only: when the plane cannot be asked, the report goes out with ids, as before.
    - **Surface:**
      - Collaboration server (replaced by item 13's `GET` listing): `POST /internal/v1/orgs/{org_id}/people { userIds }` answered `{ people: [{ userId, displayName }] }` for those ids that are members of the org, ordered by id. Anyone else is left out, so an id outside the org is never confirmed. It takes the Host service credential and its org scope, like the access routes, and at most 500 well-formed ids. `Store::org_member_names` implements it in memory and on Postgres under the org's RLS scope.
      - Host (`workspace_access::org_members` since item 13): `workspace_access::org_member_names` asked with the collab service credential (same client, timeout, proxy and no-redirect policy, 256 KiB cap) and keeps only the ids it asked about. `org_member_usage_get` adds `displayName` (trimmed, at most 200 characters) to each member it got a name for. A failure is logged and omitted. The response schema gains the optional field.
      - Client: `OrgMemberUsage.displayName`. The usage panel shows the name with the id beneath, falls back to the id, and names the person in the saved-cap toast.
    - **Known gaps:** ~~the report still lists only people the Host has records for (its person brains and the usage ledger), not every org member, so a cap cannot be set before someone's first use.~~ Fixed by item 13.

13. **Every org member in the usage panel (P6g follow-up, 2026-10-25).**
    - **Decisions:**
      - The usage report lists everyone in the org, named, including people who have never used the Host, so an admin can cap someone before their first turn. Rows come from one plane answer, which both adds the people and names them.
      - When the plane cannot be asked or cuts its list short, the report falls back to the people the Host already knows (its person brains, the usage ledger, the cap overrides) and says `membersIncomplete`. The panel then says that some members may be missing. It never presents a partial list as everyone.
      - A person who left the org keeps their row while the ledger or an override names them, without a name.
    - **Surface:**
      - Collaboration server: `GET /internal/v1/orgs/{org_id}/people` answers `{ people: [{ userId, displayName }], truncated }`: the org's members ordered by id, at most 5 000 (`MAX_ORG_PEOPLE`). It takes the Host service credential and its org scope, like the access routes. `Store::org_member_names(org, limit)` implements it in memory and on Postgres under the org's RLS scope (a join of `org_memberships` and `users`). It replaces item 12's `POST`, which had no other caller.
      - Host: `workspace_access::org_members` asks with the collab service credential (same client, timeout, proxy and no-redirect policy, 4 MiB cap) and drops ids that are not well formed. `org_member_usage_get` fetches the members before it builds the report, adds them to the people it reports on, and names the rows from the same answer (trimmed, at most 200 characters). The response schema gains the optional `membersIncomplete: true`.
      - Client: `OrgUsageReport.membersIncomplete` (only a literal `true` counts). The panel shows the note above the rows.
      - Smoke: the owner's report lists both people with no `membersIncomplete`. With `COGNIA_SMOKE_PERSONS_UNUSED_MEMBER` set, it also lists that member, named, at 0 tokens.

14. **Device page follows the device's grants (P6 follow-up, 2026-10-26).**
    - **Decisions:**
      - An org member's browser, the owner's included, holds no `host.admin`, `secret.manage` or `performance.observe` on a multi-tenant Host. The device page asked anyway: the worker list every 5 s and each management section on every visit and focus, each refused `missing_capability` (`retryable: false`).
      - The client now reads the grants the Host names for this device (the manifest's `deviceGrants`, the same SecurityStore snapshot the refusal checks) and does not ask for what it lacks. It says why in the page's "does not apply" record.
      - Only a positive answer counts. No manifest, a v1 manifest or an empty list is unknown, and an unknown device still asks; the Host's refusal stays the authority. Organization models are not gated this way, because the Host admits them by org role, not by device grant.
    - **Surface:**
      - `lib/devices/grant-capabilities.ts`: `deviceLacksCapability(declared, capability)`.
      - `lib/devices/section-plan.ts`: `MANAGED_HOST_SECTION_GRANT` (secrets `secret.manage`, updates and runtimes `host.admin`, system `performance.observe`). A section the device lacks the grant for leaves the plan and leads the not-applicable record with `devices.notApplicable.missingGrant.*`.
      - `lib/fleet/execution-workers.ts`: `executionWorkersReachable(host)`. The device rows poll skips the worker list, and the settings workers card says why (`settings.fleet.workers.notAdmin`) with enrolling disabled.
    - **Verified (2026-10-26, P6f rig, owner Ada's browser):** the page shows the four rows in the record. Over 50 s nothing is refused, where `fleet_worker_list` had been refused every 5 s.
    - **Known gaps:** ~~at page load, before the Host's manifest lands, each section and the worker list still ask once and are refused once.~~ Fixed by item 17.

15. **A conversation keeps its first-message title (P6 follow-up, 2026-10-26).**
    - **Decisions:**
      - The bug was two writers. The Host gave its `sessions` row the first message's opening words, while the conversation's HostState channel kept the "New conversation" from `session.create`. Every replica writes the channel's title over its own row on each confirmed update, so a paired browser's title flipped to the preview and back to "New conversation" for good, sidebar included.
      - The Host now names the channel too. A `session.renamed` of its own, committed just before the first message is queued, keeps the row and the channel in step, and every client already reads the mutation. Nothing new crosses the wire.
      - Only a placeholder is replaced, read inside the commit, so a rename that lands first wins. The id is the message's action id, so a redelivered send names nothing twice.
    - **Surface:**
      - `lib/chat/placeholder-title.ts`: `instantSessionTitle(text)`, the one rule (whitespace folded, at most 40 characters), used by the row write and the channel.
      - `lib/sync/host-state-service.ts`: `nameFromFirstMessage`, through `commitHostStateRuntimeProjection`, whose mutation callback may now return `null` to commit nothing.
      - `lib/sync/host-state-store.ts`: a HostState `session.rename` now also sets `titleAuto: false` on the Host's row, as a local rename does.
      - Smoke: the persons tier creates an untitled conversation and checks that the Host's channel carries its first message's title.
    - **Verified (2026-10-26, P6f rig, `ark-deepseek-v4.1-flash`):**
      - The persons smoke is green with the new check.
      - In the browser, Ada's new conversation went from "New conversation" to its first message's title and kept it, header and sidebar both. The transcript did not remount after the title change: the only swap is the welcome screen giving way to the chat on send.
    - **Review fix (2026-10-26, Codex review of items 13–17):** the rename's broadcast ran unguarded before the message commit, so a broadcast failure failed the submit and lost the first message (the rename was durable, the message never written). The message's mutation was also built from the snapshot read before the rename, so it repeated the rename's revision and a client holding that revision could pass a stale `draft.replace`. Now a failed title broadcast is left for the sweep, and the message is rebuilt from the renamed state. Pinned by two tests in `host-state-service.test.ts`. The same review found no duplicated implementation in items 13–17.
    - **Known gaps:** ~~the browser does not generate a model-written title for a HostState conversation; it keeps the 40-character preview.~~ Fixed by item 18. One smoke run in two missed the agent reply's settled live frame on a turn that finished in about a second; the rerun was green.

16. **Member model menu names models (P6 follow-up, 2026-10-26).**
    - **Decisions:**
      - The deployment names its models, and that name reaches the member's menu. The Host's profile store already had a `displayName` per deployment model, but its projection into the gateway snapshot dropped it, so the snapshot had no name to give.
      - A model the deployment does not name takes this app's own catalog name, else its id. The id stays the key everywhere; only the label changes.
      - Only names that say more than the id travel, trimmed and bounded to 200 characters, and only for models the map serves.
    - **Surface:**
      - `cognia-agent-state` `gateway_snapshot_json`: `modelMetadata: [{ id, name }]` for each named deployment model, the key `/v1/models` already maps to `display_name`.
      - Host `person_agent_policy_get`: `modelNames { provider: { modelId: name } }` beside `models`, read from the snapshot's metadata. The response schema gains the field.
      - Brain `fetchPersonAgentPolicy` and `PersonAgentsManifest.modelNames` (optional, checked when present). `personServedModels` entries carry `names`, and the model picker labels each row and the chip with them, falling back to `resolveModelDisplayName`.
      - Smoke: with `COGNIA_SMOKE_PERSONS_MODEL_NAME` set, the member's manifest must name the persons model so, and name nothing it does not serve.
    - **Verified (2026-10-26, P6f rig, `ark-deepseek-v4.1-flash`):** the rig's deployment profile gave the model "DeepSeek V4.1 Flash" (`cognia-server profiles import`, profileVersion 3). The persons smoke is green with the new check. In Ada's browser the composer chip and the menu read "DeepSeek V4.1 Flash", with the id beneath in the menu.
    - **Known gaps:** a Host that projects its snapshot from app settings instead of the profile store names only models whose settings carry a name (`resolveModelDisplayName`). The welcome screen's usage stats still name the top model by id.

17. **Grant-bound reads wait for the Host's manifest (P6 follow-up, 2026-10-26; item 14's gap).**
    - **Decisions:**
      - A paired client learns its device grants from the manifest it negotiates at boot. Until that lands, its grants are unknown, and "unknown" used to mean "ask": the device page's managed sections, the worker list, the Bot console read and the provider-key follower each sent their read at once and were refused (`missing_capability`, final) a moment before the manifest said the same.
      - One rule, `hostGrantGate(snapshot, capability)` in `lib/runtime/operation-availability.ts`, answers `ask`, `wait` or `lacks`. A companion target with no manifest yet waits. Known grants that lack the capability skip the read. A manifest that names no grants, or an incompatible one, still asks, and the Host's answer decides. A native host or a standalone client has no manifest to wait for.
      - A read that waits is retried when the answer changes, not on every snapshot change.
    - **Surface:**
      - `executionWorkersAccess(snapshot)` replaces `executionWorkersReachable(host)`. The device console's poll and the settings card ask nothing while waiting, and the card claims neither "no workers" nor "not an admin" then.
      - The `/pair` Host's device row carries `pairedHostGrants` while it has no manifest of its own: `"pending"` before the boot provider has the manifest, then the snapshot's grants. Managed sections (secrets, updates, runtimes, system) are left out of both the grid and the not-applicable record while pending.
      - `useBotHostRead` waits on the paired Host's manifest and reads a lacked `workspace.write` as the refusal the Host would answer.
      - The provider-key follower (`lib/host-secrets/remote-host-keys-follower.ts`) waits for the manifest, keys nothing for a device without `secret.manage`, and no longer asks again on every return to the foreground.
    - **Verified (2026-10-26, P6f rig, Ada's paired browser):** before the change a reload of the devices page drew `host_secret_list`, `fleet_worker_list` (twice) and `bot_console_read` refusals. After it, a 40 s window after a reload and a deep-linked reload of the Host's page show no refusal of those reads, and the Host's page states the four sections in "Does not apply here".
    - **Known gaps:** `background_job_list` and `background_monitor_list` are still refused once at load (the member refused-requests work owns them). The Host's page asks `managed_desktop_list` and `managed_desktop_list_configs` and gets `managed_desktop_account_required` (400) on a Host with no managed-desktop account. A v1 manifest's grants are derived from the operations it advertises, so a v1 Host is judged by those.

18. **A HostState conversation gets a model-written title (P6 follow-up, 2026-10-26; item 15's gap).**
    - **Decisions:**
      - The device's own title upgrade (`runUtilityModelTasks`) runs in the chat view that drove the turn, and a HostState conversation's turn is driven by the Host, so a paired browser's or a member's conversation kept its 40-character preview for good. The Host now asks the same pipeline (`runTitleTask`) once a conversation's first turn completes, and names it with a `session.renamed` in its channel, as item 15 does for the preview.
      - Who pays: an owner's Host titles with the utility model its own settings resolve. A person partition holds no provider key, so it titles with the org model the conversation runs on, through a Host ticket minted for the conversation. The call is charged to the member's monthly usage like a turn, and a reached cap leaves the preview.
      - Only a machine title is replaced. The row must not be `titleAuto: false`, the transcript must hold exactly one assistant turn, and the channel title must still be the placeholder or the first message's preview. The commit re-reads the channel, so a rename that lands while the model runs wins. The envelope id is the session's, so it happens once.
      - A desktop Host with the conversation open runs both upgrades. They share the pipeline's in-flight dedup, so one asks the model. When the chat view's call wins, the Host takes the chat view's title from the row instead of asking again.
      - A runtime `session.renamed` now also writes the Host's own `sessions` row (title, `titleAuto: true`) in the same transaction. Before, only the replicas' rows took a Host-originated title.
      - Titles and timeline labels get a 2048-token output cap (`SHORT_UTILITY_ANSWER_MAX_TOKENS`), up from 32 and 24. A reasoning model spends hidden reasoning from the same budget: `ark-deepseek-v4.1-flash` spent about 400 tokens on a one-line title and returned no text at 32 or 256. A plain model still stops after the title, so the cap costs it nothing. This affected every owner whose utility model reasons, not only HostState.
    - **Surface:** `lib/sync/host-state-title.ts` (`hostStateTitleSource`, `createHostStateTitleGenerator`, `personTitleClient`, `deviceWrittenTitle`), `titleAfterFirstTurn` in `host-state-service.ts` (scheduled after the settle is broadcast, off the projection call), the `generateTitle` service option, and `runTitleTask`'s `buildClient`, built only after the feature switch and PII gate pass. `extractPlainText` and `extractAssistantText` moved to `lib/chat/message-text.ts` (the hooks module re-exports them), so the brain reads a transcript without loading the chat view. The persons smoke checks for a model title that is not a cut of the first message, when a real model is configured.
    - **Verified (2026-10-26, P6f rig, `ark-deepseek-v4.1-flash`):** the persons smoke's model-title check passed in every run on the new brain ("Why sky is blue then red", "Sky blue at noon red at sunset"), and fails on the previous brain. A browser check was not done: other sessions' edits kept the shared dev server full-reloading, which reset the pairing form. The client path that renders a channel rename is unchanged since item 15.
    - **Known gaps:** the agent live-frame checks (`agent reply streams to their device as live frames`, `final live frame is the reply the Host kept`) failed in one of two runs on the new brain and in both runs on the previous brain, and one previous-brain run also refused the agent turn as `member_usage_cap_reached` right after the cap test restored the cap. Both are pre-existing smoke flakes, not caused by this item. The title is generated once. A later topic drift does not retitle (`run-title-task.ts`'s FUTURE note).

**Intentional dormancy (Rule 7).**

- Tool turns need a conforming sandbox pool. Without one they keep `execution_isolation_unavailable`.
- Model calls need an org credential. Without one they keep `model_access_unavailable`.
- Member chat stays tool-less unless the Host advertises `COGNIA_PERSON_EXECUTION=sandboxed` (only on a conforming pool, `crates/cognia-server/src/brain.rs`, pinned by `p6d_execution_advertisement_requires_conforming_pool_and_is_person_only`). Only then does the person brain install the `person-agent` runtime, which stays inert otherwise (`lib/headless/runtimes/person-agent.test.ts`). A session with no allowed or default agent stays tool-less chat, and the Host strips any tool surface from it.
- Single-user and desktop Hosts are unchanged.

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

| ID   | Given / when                                                                                       | Required result                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| AC19 | The app DB role is superuser or BYPASSRLS.                                                         | The server refuses to start unless explicitly overridden; `/health` reports the override.                                                   |
| AC20 | A tenant principal calls each Host surface class in multi-tenant mode.                             | Matrix holds; an unclassified surface is denied; the classification test fails when a new route is unclassified.                            |
| AC21 | A policy row is absent, paused, killed, denied, canary at 0/50/100%, or has an unmet prerequisite. | Decisions match the evaluation order and the golden bucket vectors; reads, exports, leave and cancel stay available.                        |
| AC22 | An offboarded issuer's pending chat invite is accepted.                                            | Refused; the invite shows as unavailable.                                                                                                   |
| AC23 | A scoped internal credential queries another org.                                                  | `403`; unscoped single-credential deployments unchanged.                                                                                    |
| AC24 | A tenant device calls a `client.read` / `client.write` data command on a multi-tenant Host.        | Before P5: `403 host_data_unpartitioned`. After P5: it reads and writes only its own person's partition.                                    |
| AC25 | Persons A and B of one org use one multi-tenant Host; A writes messages, files, pet and issues.    | B's reads return none of A's rows; A's data root is encrypted with A's key only.                                                            |
| AC26 | A person brain's token is presented to a route or check that accepts `service`.                    | Refused.                                                                                                                                    |
| AC27 | A departed member's device calls a data arm; the operator then purges them; they rejoin.           | `403` while departed, data kept; purge removes key and data root; after rejoining the partition is empty.                                   |
| AC28 | `COGNIA_PERSON_BRAINS_MAX` brains are busy and another person calls.                               | `503 person_brain_capacity`, retryable; an idle brain is stopped first when one exists.                                                     |
| AC29 | A member on a multi-tenant Host creates, renames, archives and deletes a conversation.             | Each is applied in their partition only; the other member's `session_list` never shows it.                                                  |
| AC30 | The member enqueues a message, steers a turn or moves a session to a workspace in their partition. | Per-action refusals `execution_isolation_unavailable` / `workspace_unavailable`; status never advertises them.                              |
| AC31 | A single-user Host or a desktop Host receives the same HostState calls.                            | Behaviour unchanged: device grants decide, as before.                                                                                       |
| AC32 | An org member (not owner/admin) tries to set, read or delete an org credential.                    | Refused; owner/admin succeed; no call ever returns key material; each change is audited.                                                    |
| AC33 | A member's partition mints a ticket, then another partition presents it.                           | Refused; the ticket names its partition; the org credential never reaches the brain.                                                        |
| AC34 | A member exceeds their monthly cap mid-turn.                                                       | The reservation fails before the call: `429 member_usage_cap_reached`; other members are unaffected; usage shows per member.                |
| AC35 | A member runs a tool turn on a Host with a conforming sandbox pool.                                | It runs in a sandbox container bound to their personal workspace with brokered credentials only; another member's workspace is not mounted. |
| AC36 | The same request on a Host without a conforming pool, or with an agent outside the allowlist.      | `execution_isolation_unavailable` / refused agent; no Host process is started.                                                              |

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
| P6a     | §9b.1 Org model credentials and agent allowlist: Host org-scoped secrets, admin RPC, `cognia-server org-credentials`, audit.                                                                                                                                                                                                            | Codex `gpt-6.1-sol`                                  | Crate tests outside the sandbox (AC32).                                                                                                      |
| P6b     | §9b.2 Member usage ledger and monthly cap.                                                                                                                                                                                                                                                                                              | Codex `gpt-6.1-sol`                                  | Crate tests, cap race test (AC34).                                                                                                           |
| P6c     | §9b.3 Partition route tickets; tool-less member chat (the pet stays desktop-only).                                                                                                                                                                                                                                                      | Codex `gpt-6.1-sol` + Claude (TS)                    | Crate tests + Jest; rig run against `anthropic-fixture` (AC33, AC34).                                                                        |
| P6d     | §9b.4 Personal workspace and partition execution admission.                                                                                                                                                                                                                                                                             | Codex `gpt-6.1-sol`                                  | Crate tests; sandbox run where `runsc` exists (AC35, AC36).                                                                                  |
| P6e     | §9b.5 Person brain drives external-agent sessions.                                                                                                                                                                                                                                                                                      | Claude                                               | Jest; rig run.                                                                                                                               |
| P6f     | §9b.7 Real-service E2E lane (`persons` tier, CI wiring).                                                                                                                                                                                                                                                                                | Claude                                               | Lane green locally and in CI.                                                                                                                |
| P6g     | §9b.6 Frontend: org model settings, agent picker, cap labels.                                                                                                                                                                                                                                                                           | Claude                                               | Jest, i18n, browser check.                                                                                                                   |
| P7      | Deferred: org suspend/delete, rate limits, shared multi-agent sessions (AC16).                                                                                                                                                                                                                                                          | —                                                    | Separate plan.                                                                                                                               |

Order: P0a → P0b → P2 → P1 → P4 → P5 (P5a and P5b in parallel, then P5c, then P5d) → P6 (P6f first and alongside; then P6a → P6b → P6c → P6d → P6e, with P6g after P6a), one Codex implementation job at a time. P3 runs in parallel against the contract files and switches to the live endpoint once P2 lands. Every Codex job is followed by Claude review of the diff, a rerun of its verification commands, and an adversarial Codex review on security-relevant packages (P0a, P2, P1).

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
