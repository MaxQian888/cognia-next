---
title: "0149 — A person is not a device, and a profile is not an account"
description: "Cognia has three identity systems that do not know each other and no entity for a human being. This ADR introduces User, Org membership and an external-identity table, demotes the device from principal to credential, and defines a server-readable collaboration plane — while the local plane stays single-profile and offline."
---

# ADR 0149 — A person is not a device, and a profile is not an account

**Status:** Accepted
**Date:** 2026-08-25
**Related:** [ADR-0054](./0054-local-multi-account-isolation), [ADR-0091](./0091-lark-unified-identity-dual-entry), [ADR-0059](./0059-cloud-deployment-headless-brain), [ADR-0132](./0132-issue-tracker), [ADR-0133](./0133-terminal-session-sharing), [ADR-0135](./0135-diagnostic-service-completion), [ADR-0143](./0143-device-console), [ADR-0144](./0144-workspace-as-the-unit-of-work)

## Context

Cognia has three identity systems, and none of them knows the other two exist.

| System | Authority | Subject |
| --- | --- | --- |
| Local account ([ADR-0054](./0054-local-multi-account-isolation)) | Dexie `cognia-account-registry` | `acct_…` — one person, one password, one physical database |
| Device identity (Companion) | Rust SQLite `SecurityStore` | `device_id` — a P-256 keypair |
| Tenant + Logto OIDC | Rust `host_bindings`, cloud Postgres | `tnt_<uuid>` |

They are pinned together by exactly one row shape:
`host_bindings(local_account_namespace UNIQUE, tenant_id UNIQUE)` — a hard 1:1.
And `host_identity.rs` documents its own residual risk: Rust cannot prove that
an account id supplied by the renderer is real, so it pins a namespace to the
first verifier it sees and refuses any other.

### There is no entity for a human being

This is not an oversight. It is the shared premise of eight accepted ADRs
(0011, 0019, 0042, 0054, 0059, 0088, 0097, 0132). The consequences
are concrete and load-bearing:

- `types/issues/index.ts` says it outright: *"`id` is optional because the local
  app is single-user."* An issue assigned to a `human` carries **no id**, so the
  `[assigneeKind+assigneeId]` index means nothing for people and "assigned to me"
  degrades to "assigned to the human".
- `NotificationRecord` has no recipient. `StoredMessage` has no author —
  `MessageSenderKind` is `user | assistant | system`, which is a role, not a person.
- Authorization hangs off hardware. [ADR-0133](./0133-terminal-session-sharing)
  states it plainly: *"The grant is device-wide, not per session. Removing the
  grant is the 'kick'."* On a team, off-boarding one person means hunting down
  their devices one by one — and nothing records which device is whose.
- Six server-side components authenticate six different ways.
  `services/share-server/` is the worst: one global bearer creates any share,
  reads are fully public, and there is no tenant column at all.

### Three footholds already exist

The gap is narrower than it looks, because three pieces are already built:

1. **`cogniaUserId` and `logtoSubject` are live in code**, not just in
   [ADR-0091](./0091-lark-unified-identity-dual-entry) —
   `lib/connectors/principal/`, `src-tauri/src/companion_api/lark_entry.rs`, and
   the CLI all carry them, and a principal can already be rebound to a non-account
   id. Today `lib/connectors/principal/bootstrap.ts` falls back to
   `cogniaUserId: accountId` only because there is no `User` table to point at.
2. **Logto Organizations is wired end to end.** `organization_id` flows through
   PKCE login, token exchange and refresh in `lib/logto/client.ts`, is validated
   in `src-tauri/src/companion_api/oidc.rs`, and `organization_roles` is already
   folded into the group set used by release access policy.
3. **[ADR-0054](./0054-local-multi-account-isolation) reserved this exact
   follow-up**: *"If a later feature needs server-visible account grouping for
   owner tokens, that belongs in a follow-up ADR."* Nothing needs superseding.

The product has outgrown the premise: the target is a small team of real people,
plus one operator across several devices, plus external people arriving through
IM. That needs the two layers Cognia never built.

## Decision

### 1. The vocabulary is frozen

"Account" currently means at least four different things. It stops here.

| Term | Id prefix | What it is called today |
| --- | --- | --- |
| `User` | `usr_` | does not exist (`cogniaUserId` is half of it) |
| `Org` | `org_` | `tnt_<uuid>`, equal to a Logto organization |
| `Workspace` | keeps `projectId` | unchanged ([ADR-0144](./0144-workspace-as-the-unit-of-work)) |
| `LocalProfile` | keeps `acct_` | "local account" — the id stays, only the name and docs change |
| `ProviderAccount` | — | the `accountId` in `lib/subscription` (an Anthropic/Codex login) |
| `Device` | `dev_` | `device_id` |
| `ExternalIdentity` | — | `feishuPrincipals` rows plus `logtoSubject` |

There is precedent inside the codebase: `lib/subscription/core/transport.ts`
already distinguishes `localAccountId` from `accountId` in the same file. The
split was made once, at the hardest point, and never propagated. This ADR
propagates it.

A gate enforces it going forward (see Batch 0). Existing occurrences are renamed
when touched, not in one sweep — the working tree is shared with other sessions.

### 2. Five layers, and Cognia is missing the middle two

1. **Credential** — proves possession. Password verifier, device keypair, OAuth
   token. ✅ present and plural already.
2. **User / Principal** — the person, with a stable id. ❌ **missing; created here.**
3. **Org / Tenant** — the ownership and audit boundary. ⚠️ exists as `tnt_…`,
   but pinned 1:1 to a LocalProfile.
4. **Membership + Role** — `user × org → role`. ❌ **missing**; roles today are
   attached to devices.
5. **Session / Token** — short-lived derived credentials. ✅ present and strong:
   DPoP with a replay cache, 5-minute access tokens, single-use socket tickets,
   one-shot admin leases, per-tenant KMS envelope keys, Postgres RLS.

The problem was never cryptography. It was two missing nouns, which forced the
device to stand in as the principal.

### 3. The User is the subject; external identities hang off it

`User` is the stable subject. Logto is the IdP — **self-hosted**, one instance —
but `logtoSubject` is only an external identifier, never a foreign key. Every
external identity, including an IM principal, becomes a row in
`ExternalIdentity` pointing at a `User`, in the shape Auth0 and Logto both call
`identities[]`.

This is the decisive property: **the same human arriving from Lark today and
from the web tomorrow is one `User`.** The alternative — keeping the principal
as the subject — produces two records that can never be merged.

The fail-closed resolution already built for Lark principals
([ADR-0091](./0091-lark-unified-identity-dual-entry)) is preserved verbatim:
an unbound sender is still parked, and cross-account never executes under the
active account. Only the target of the binding changes, from a LocalProfile id
to a `User` id.

### 4. Membership is two-tier, Linear-style, and admits guests

Members attach at **both** Org and Workspace:

- Workspace membership is recruited independently — being in the Org does not
  imply seeing every Workspace.
- An Org admin can traverse into any Workspace, for off-boarding, audit and
  compliance. Privacy that hides a Workspace from its own Org's admin is not
  offered.
- **Workspace Guest**: a `User` may hold Workspace membership without Org
  membership. This is the landing point for people arriving through IM and for
  outside collaborators, and it is the reason the Notion-style "Org role cascades
  down" model was rejected — it can only over-grant.

Because a permission decision now walks two levels, an effective-permission
resolver is required. It reuses the structure of
`lib/workspace/capability-overlay.ts`, which already computes an effective value
from stacked layers, together with a projection cache. It is not a new pattern.

### 5. A device belongs to a person, in two steps

The device stops being the principal and becomes a credential held by a `User`.
Authorization resolves `device → user → membership → capability`, and a
device-level override remains available — but only to *narrow*, never to widen.

This lands in **two steps, deliberately**:

1. `devices` gains `user_id`. Pure bookkeeping, no change to any decision path.
   This alone makes "whose machine is this?" answerable, which it is not today.
2. The grant decision is rerouted through membership.

`capability_grants` is on the hot request path — `rpc.rs` and `ws_terminal.rs`
read it directly — so collapsing these into one release is not acceptable.

### 6. The collaboration plane is server-authoritative and server-readable

**Scope, first cut**: Issues, Workspace metadata, Plans and Runs. These already
have stable ids and event streams (`issueEvents`, `agentPlanEvents`,
`operation_events`), and `IssueActor` already has the `human | agent | team`
skeleton — it only lacks the id. Sessions and messages are a **second cut**, not
part of this one.

**Consistency**: the server is authoritative for the collaboration plane; the
client keeps a read-only cache. Core local functionality stays fully offline;
collaboration requires connectivity. These are two consistency models on purpose,
and no attempt is made to unify them.

**Encryption**: the collaboration plane is **server-readable**, protected by
per-tenant KMS envelope keys plus Postgres row-level security — the design
already proven in `services/diagnostic-server/`, including crypto-erase via
`shred_tenant_keys`. Group end-to-end encryption (MLS-class key redistribution
on every membership change) is rejected: it destroys server-side search,
notification and aggregation, and it would not even be self-consistent, because
[ADR-0054](./0054-local-multi-account-isolation) already states the local Dexie
database is not encrypted at rest.

The zero-knowledge share links of [ADR-0037](./0037-public-share-links) remain untouched as a separate
capability. Sending a stranger a link and collaborating with a teammate are two
different problems and are not merged.

### 7. Service placement, and one shared auth crate

`crates/cognia-ops-controller` and `services/diagnostic-server` implement grant
issuance, an RBAC ladder and tenant scoping **twice**, independently, in the two
highest-quality security codebases in the repository — and they do not know
about each other. There are 37 crates and not one of them is about auth.

- New: `crates/cognia-collab-server` — the collaboration plane. It is not folded
  into `cognia-ops-controller`, whose scope vocabulary (`servers:read`,
  `servers:operate`, `servers:admin`) is about operating machines and would be
  permanently polluted by team semantics.
- New: `crates/cognia-tenant-auth` — grant minting and verification, the RBAC
  ladder, and the `set_config('app.tenant_id', …)` RLS fixture, shared by all
  three.

**Corrected during Batch 2 — the cost was misidentified.** This ADR originally
priced the obstacle as a `rust-version` split (`1.82` in
`services/diagnostic-server` against the workspace's `1.89.0`). That turned out
to be a phantom: its `Dockerfile` builds on `rust:1.95-bookworm` and the repo
pins `channel = "1.95"`, so the declared `rust-version` is a floor nothing
actually compiles at.

The real obstacle is the **image build context**.
`.github/workflows/images.yml` builds that service with
`context: services/diagnostic-server`, so a `path = "../../crates/…"`
dependency resolves under `cargo test` and then fails inside Docker, where the
parent directory does not exist. Changing a deploy pipeline's build context to
serve a refactor is the worse trade, so `cognia-tenant-auth` is a workspace
crate that diagnostic-server does not consume — see the roadmap row for Batch 2.

### 8. Authentication converges selectively, not uniformly

| Component | Disposition |
| --- | --- |
| `cognia-collab-server` (new) | Copy the diagnostic-server model: OIDC → short-lived HMAC grant → RBAC ladder → RLS. Invent nothing. |
| `services/share-server/` | **Must** gain a tenant column and real identity. One global bearer plus fully public reads means any leak is a total leak. |
| `crates/cognia-ops-controller` | Add Postgres RLS. Every table already carries `tenant_id`; today isolation depends entirely on application code being correct. |
| `services/signaling-server/` | **Unchanged, deliberately.** `room_id = SHA256(descriptor containing both parties' public keys)` means the relay sees nothing and two users cannot land in one room. Adding identity here would *reduce* privacy. This is a design property, not a gap. |
| `src-tauri/src/companion_api/` | Unchanged in this ADR beyond §5. DPoP, socket tickets and capability grants stay. |
| `services/workspace-runtime/` | Unchanged. One bearer per pod, isolation by pod, adequate. |

### 9. LocalProfile survives, and binds on first login

`acct_…` ids and the `cognia-account-<id>` databases stay exactly where they are
and keep their role as the local encryption/unlock boundary. On first login a
LocalProfile binds to a `User`, and `host_bindings` widens from a pair to
`(localProfile, user, org)`.

Two reasons. [ADR-0054](./0054-local-multi-account-isolation) already set the
precedent — *"The legacy source database is not deleted during migration. It
remains a rollback source."* And it is the only migration that keeps "offline, I
am still me" true: a LocalProfile unlocks on its own, and the `User` is a remote
binding on top of it.

The `UNIQUE` constraints on `host_bindings` must be relaxed, and the
"pin the first verifier seen" trust model in `host_identity.rs` rewritten.

### 10. What happens to the eight single-user ADRs

None are superseded wholesale. Each single-user statement is classified:

| ADR | Statement | Disposition |
| --- | --- | --- |
| 0011 Workflows | "Multi-user collaboration / CRDT — single-user desktop app" | **Narrowed** — true of the local plane; workflow collaboration is out of the first cut. |
| 0019 Goal | "multi-model, single-user desktop product" | **Still true** — /goal is local. |
| 0042 Notification Center | rejects multicast and tenant scoping | **Narrowed** — notifications stay local; collaboration notification is a second-cut question. |
| 0054 Local isolation | non-goal: "Cloud identity, account sync, or remote login" | **Superseded** on that line only, by the follow-up its own line 68 anticipated. Option A (a database per profile) and the rejection of Option B (`userId` on every table) both stand. |
| 0059 Cloud deployment | "local-first… the desktop is the server"; T3 multi-tenant deferred | **Narrowed** — local-first still holds for the local plane; this ADR is the deferred tier arriving. |
| 0088 Pro IDE | "on a single-user desktop, a process running as the user…" | **Still true** — the security position is about the local machine. |
| 0097 Cross-device settings | notes conflicts are rare for "a single user" | **Narrowed** — settings remain per-LocalProfile. |
| 0132 Issue tracker | `IssueActor.id` optional "because the local app is single-user" | **Superseded** on that point. `id` becomes required once Issues enter the collaboration plane. |

## Non-goals

Explicitly out of scope, and not to be inferred from anything above:

- Public self-serve sign-up. The target is a known team, not an open product.
- A billing, licensing or entitlement server. None exists today
  (`LICENSE_NAME = null`), and none is created here. `lib/subscription/` remains
  a local credential vault, not billing.
- Group end-to-end encryption for the collaboration plane (see §6).
- Adding `userId` to the ~700 local Dexie tables. [ADR-0054](./0054-local-multi-account-isolation)
  rejected this and the rejection stands.
- Sharing sessions and messages. That is the second cut and needs its own ADR:
  `StoredMessage` has no author field, and attachment bytes do not cross hosts.
- Changing `services/signaling-server/`.

## Consequences

- The local plane keeps working exactly as it does today for a user who never
  logs in. `AccountGate`, the password verifier and the per-profile database are
  untouched.
- "Assigned to me" becomes true. `[assigneeKind+assigneeId]` becomes a usable
  index instead of a decorative one.
- Off-boarding becomes an operation on a person rather than a hunt for hardware.
- Two consistency models now coexist in the product, and users will feel it:
  collaboration data is unavailable or stale offline. This is accepted, stated in
  the UI, and must not be papered over with optimistic local writes.
- `host_identity.rs` loses its "first verifier wins" shortcut and needs a real
  trust model. This is the single riskiest edit in the roadmap.
- Three services will share `cognia-tenant-auth`, so a bug in it is a bug in all
  three. It gets its own test suite before any caller is migrated.

## Roadmap

Batches are sequenced by risk, not by visible value. Batch 0 ships no feature.

| Batch | Content | Key files |
| --- | --- | --- |
| **0** | Freeze the vocabulary; add the lint gate. Zero functional change. | `scripts/gates/check-identity-vocabulary.mjs` (modelled on `check-workspace-attribution.mjs`) — rejects bare `accountId` in new code |
| **1** | `User` / `Org` / `Membership` model; Logto login; LocalProfile↔User first-login binding | `lib/logto/*` (org support already present), `stores/account/account-store.ts`, `src-tauri/src/companion_api/host_identity.rs` |
| **2** | ✅ `crates/cognia-tenant-auth` | **Not** a merge — see the note below. Ships the identity core (`usr_`/`org_` ids, both role ladders, `resolve_workspace_access`), the RLS session-variable contract, and the HMAC grant plane behind a `grants` feature. Consumed today by `src-tauri`, which now validates the ids it persists. |

**Batch 2 finding — the two files shared nothing.** This roadmap said
`cognia-tenant-auth` would be "merged from `services/diagnostic-server/src/auth.rs`
and `crates/cognia-ops-controller/src/auth.rs`". Those two files share no type,
no function and no constant. They are two different auth designs for two
different threat models: diagnostic-server verifies OIDC against a **static RSA
PEM** (RS256 only, `tenant_id: Uuid`, four-rung role enum), while ops-controller
runs **JWKS discovery with a TTL cache** across nine algorithms (`tenant_id:
String`, free-form scope set). They are additionally on incompatible majors of
`jsonwebtoken` (9 vs 11).

So the OIDC verification plane stays where it is, in both services, and the
shared crate owns the layer above it: what a verified token *means*. That is
also the layer this ADR actually invents — neither existing file has a `User`.
| **3** | ✅ `crates/cognia-collab-server` + Issues on the plane | Server: RLS-scoped Postgres, the two-step auth chain, and `POST /v1/orgs/{org}/grants` — the one door in. Client: `types/issues/collab.ts` (the actor narrowing), `lib/collab/` (grant-caching client + pull), Dexie v195 `collabIssues`, and a fifth federated board source. |

**Batch 3 notes.** Three things this ADR did not anticipate:

1. **`IssueActor.id` is conditionally required, not unconditionally.** §10 says
   "once Issues enter the collaboration plane", and that condition is
   load-bearing: a machine nobody has signed in on has no `usr_` at all, and
   decision 4 keeps it working offline. So the local type keeps `id?` and the
   *boundary* narrows — `resolveCollabActor` refuses rather than inventing an
   id. What ADR-0132 loses is its justification ("the local app is
   single-user"), not its shape.
2. **The plane needed a grant-minting endpoint.** Verification without an
   exchange is a service nothing can authenticate to. The exchange verifies the
   org named in the path *inside that org's own RLS scope*, which avoids needing
   a privileged escape from row-level security.
3. **§7's shared crate found its real justification here.** Batch 2 showed the
   two existing services shared no code. The third service is what made a shared
   JWKS verifier correct, and `cognia_tenant_auth::oidc` now owns it.
| **4a** | ✅ `devices.user_id` bookkeeping | `security_store.rs` (column, migration, enrolment inherits the bound person, sign-in adopts the unclaimed), `lib/devices/`, the console's "Belongs to" row. **No decision path reads it**, pinned by two tests. |
| **4b** | ✅ Reroute the grant decision | `has_capability` joins `host_bindings` and refuses a device attributed to somebody else; `lib/devices/grant-capabilities.ts` mirrors the predicate so the console can say why; a new `suspended` grant state and its banner. Shipped as a **separate release** from 4a — see below. |

**Why 4a and 4b are numbered apart.** §5 says "two releases, never one", and
the roadmap row hid that inside a single line. The risk is concrete:
`capability_grants` is read per request by `rpc.rs`, `ws_terminal.rs` and
`remote_execution.rs`, and every device that existed before the upgrade has a
NULL `user_id`. A release that both introduced the column and started routing
decisions through it would evaluate the new rule against a fleet that has not
been attributed yet — a lockout, not a migration. 4a exists so the column has a
release to fill in before anything depends on it.

`host_bindings.tenant_id` keeps its `UNIQUE` constraint through 4a. Relaxing it
is listed under §9, but nothing needs it yet, and it is what makes "which person
does this tenant belong to" a single-row lookup — which is exactly how an
enrolling device learns its owner. It should be relaxed when two profiles
genuinely share one Org's tenant, and not before.
**Batch 4b notes.** What "membership" means on a host.

The rule this ADR states is `device -> user -> membership -> capability`. The
host has no membership table and should not grow one: memberships belong to the
collaboration server, and a local mirror would either *grant* while stale (a
hole) or *narrow* while stale (a lockout on every network hiccup). What the
host does have is `host_bindings`, which records the one person a tenant belongs
to.

So the host enforces the part it can prove — the device's person must be the
person this host acts for — and the shape stays the intersection the ADR
describes: the person's ceiling is "everything" for the bound person and
"nothing" for anyone else, and the device's own `capability_grants` narrow it
from there. When a membership mirror eventually lands, only the ceiling gets
finer; the rule does not move.

Concretely, what 4b stops: person A signs out, person B signs in on the same
machine, and A's still-paired phone keeps running agents on B's host. Until now
it could.

Both NULLs still pass, and that is the whole safety argument. A host nobody has
signed in on decides nothing by ownership, and an unattributed device — every
device that existed before 4a — is not treated as a stranger's. Denying either
would be the fleet-wide lockout the two-release split existed to avoid, so both
are pinned by their own tests.

The predicate now exists twice: as SQL on the hot path and as TypeScript in the
console, which needs it only to explain a switch it is drawing as off. A test on
each side reads the other's source, because a mirror that drifts is worse than
no mirror — it would keep drawing a grant as live that the host has been
refusing for weeks.

`suspended` is a new grant state rather than a reuse of `denied`. Nothing was
revoked; handing the device back to its person restores it without a re-grant,
and showing it as "not granted" would invite an owner to re-grant something
that is already granted.

| **5** | ✅ `ExternalIdentity` absorbs IM principals | `lib/identity/external-person.ts` (find-or-mint by external subject), `lib/connectors/principal/person.ts` (the Lark id ranking), `bootstrap.ts` and `approveFeishuBind` no longer fall back to `accountId`, Dexie v196 `subject` index, and the principals card's person + standing badge. **Guest is derivable and rendered but has no producer** — see below. |
**Batch 5 notes.** Three things this ADR did not anticipate:

1. **Guest cannot land in this batch, and shipping the derivation is the
   honest half.** A guest is a `User` holding Workspace membership without Org
   membership. Nothing writes `workspaceMemberships` in production: the
   collaboration server owns those rows, and the client has no configured
   endpoint to pull them from — `pullCollabIssues` itself has no production
   caller yet either. So Batch 5 ships the derivation (`personStandingFrom`,
   `resolvePersonStanding`) and the surface that renders it, and the `guest`
   value stays unreachable until Batch 7 gives the plane a configuration and a
   membership pull. `lib/db/workspace-membership-producers.test.ts` pins that:
   it walks the tree for a writer and fails on the day one appears, so the
   claim cannot rot into a stale comment.

2. **An IM-first person and a web-first person are two `User`s, and merging
   them is an operator decision.** Sign-in derives its id from `(issuer, sub)`,
   which nothing minted from a Lark `open_id` can reproduce. Convergence
   happens automatically only in the direction the evidence exists: a principal
   carrying a `logtoSubject` resolves to the person who already signed in with
   it. In the other order the operator rebinds the principal to the real
   `usr_…`, which now re-points the external identity too. No automatic path
   merges two people — that would attribute one human's messages to another.

3. **`cogniaUserId` had to become validated, not just populated.** The field
   defaulted to the LocalProfile id for so long that `acct_…` still *looks*
   right in it, and `cognia lark rebind --user bob` was accepted. It is now
   refused at both the operator channel (`user_invalid`) and the mutation
   floor. Rows written before this batch keep their `acct_…` value; the
   principals card falls back to showing the raw id rather than a word that
   says nothing, the same call the device console's owner row makes.

| **6** | ✅ `share-server` gains tenancy and identity; `ops-controller` gains RLS | Controller: `0002_tenant_isolation.sql` (ENABLE + FORCE on all twelve tables) and every statement inside a `tenant_scope` transaction. Share: `org_id`/`creator_user_id` columns, grant verification in both the Rust server and the Worker, and a grant-only `/v1/orgs/{org}/shares` plane. |
| **7** | Workspace, Plans and Runs on the collaboration plane | follows Batch 3 |

**Batch 6 notes.** Four things worth recording.

1. **The controller's `WHERE tenant_id = $1` was the isolation, and that was
   the bug.** Every table already carried the column and every query already
   filtered on it, so one forgotten predicate in any of ~30 statements served
   another tenant's servers, logs and operations — and only review stood
   between that and production. `FORCE` matters as much as `ENABLE`: the
   controller connects as the table owner, and an owner is exempt from a
   merely-ENABLEd policy, so the migration would have been theatre.

2. **Three statements cannot be scoped, and they are named rather than
   tolerated.** Consuming an enrollment token and authenticating an agent are
   credential lookups where the tenant is the query's *output*; the lease sweep
   is cross-tenant by definition. They take an explicit `app.cross_tenant`
   escape and a test pins that exactly three callers use it. `heartbeat_operation`
   and `transition_operation` did *not* take that escape — the agent gateway
   already holds the agent's authenticated tenant, so they gained a parameter
   instead.

3. **The grant verifier now exists three times, and that is not a mistake.**
   `.github/workflows/images.yml` builds both services with their own directory
   as the Docker build context, so a `path = "../../crates/…"` dependency
   resolves under `cargo test` and fails inside the image — the same constraint
   §7 already recorded for `services/diagnostic-server`. The Worker is
   TypeScript besides. So the format is duplicated in `cognia-share-core`, in
   the Worker, and in `cognia-tenant-auth` which owns it, and all three verify
   one **frozen wire vector** checked in beside the owner. Duplicated code that
   nothing pins drifts, and this drift would surface only in production, as
   "sharing stopped working".

4. **The app cannot present a grant yet, and no client path was built to
   pretend otherwise.** `lib/share/client.ts` sends the configured upload
   secret; obtaining a grant needs a configured collaboration endpoint, which
   is the same thing Batch 5 found missing for `pullCollabIssues`. The server
   half is complete and inert until Batch 7 gives the plane a configuration
   surface — which is why the legacy secret keeps working and pre-tenancy
   shares are left alone rather than backfilled with a guess.

