# Proposal section model

## Core structure

### Light

1. Metadata and executive summary
2. Context, goals, non-goals
3. Proposed design and rationale
4. Verification and acceptance
5. Risks and mitigations
6. Work plan
7. Decisions and review record

### Standard

1. Metadata and executive summary
2. Context/problem, goals, non-goals
3. Current system and evidence
4. Proposed design and alternatives
5. Contracts/interfaces/data model
6. Failure, concurrency, recovery, compatibility
7. Security/privacy/permissions
8. Observability
9. Migration, rollout, rollback
10. Verification and acceptance
11. Work plan, risks, decisions, review record

### Heavy additions

- terminology and invariants;
- dependency/ownership matrix;
- capacity/cost/performance budget;
- detailed state machine and sequence;
- schema/backfill/data reconciliation;
- multi-version compatibility matrix;
- phased rollout/feature flag/kill switch;
- operational runbook and SLOs;
- adversarial/security analysis;
- alternative rejection record.

## Layer-based tailoring

| Touched layer | Must cover |
|---|---|
| UI/App Router | route/component ownership, accessibility, i18n, static export, hydration, responsive states, loading/error/empty |
| State/Dexie | source of truth, transaction boundary, schema/index, migration, cross-tab/account isolation, backup/sync |
| AI/agents | model/provider contract, prompt/tool/event flow, PII gate, approvals, cancellation, deterministic testing |
| External-agent/CLI/TUI | protocol mapping, capability negotiation, process install/discovery, terminal interaction, parity |
| Tauri/Rust | command/event contract, serialization, registration/ACL, locks across await, task shutdown, platform matrix |
| Mobile/Capacitor | runtime mode, native plugin contract, permissions, offline/reconnect, iOS/Android differences |
| Plugins/SDK/WIT | manifest/API version, activation/reachability, host capability, compatibility, packaging/scaffold |
| Services/remote runtime | ingress/auth, tenant/workspace boundary, network trust, health, resource/queue limits, deployment |
| Docs | English/Chinese parity, navigation, implementation source links, docs build |
| Cross-layer | end-to-end data/control flow, ownership table, version/skew, rollout order, rollback seam, E2E |

Delete untouched layer sections. Cross-layer proposals need one whole-system view plus boundary tables.

## Section contracts

### Metadata and executive summary

State status, author, date, scope, source issue/PRD, related ADRs, reviewers, branch/milestone. The executive summary answers:

- What changes?
- Why now?
- What is the blast radius?
- What must reviewers decide?

### Context/problem

Use confirmed current facts. Show the user/operator failure or engineering constraint. Quantify scale and explain why current behavior is insufficient.

### Goals/non-goals

Every goal is measurable and maps to acceptance. Separate:

- in scope;
- deferred but compatible;
- explicitly not supported.

### Current system

Name owning symbols/files and data/control flow. Mark confirmed, inferred, and open. Explain constraints that the design must preserve.

### Design and alternatives

State the recommendation first. For each material decision include:

| Decision | Chosen | Alternatives | Why chosen | Cost/tradeoff |
|---|---|---|---|---|

Do not list options without a recommendation.

### Contracts and data

Specify types, validation, errors, versioning, storage, indexes, units, ownership, and consumers. Include schemas/pseudocode only when it clarifies a contract.

### Failure/recovery/compatibility

Cover timeout, retry, idempotency, order, cancellation, crash, restart, partial write, stale client, old data, platform/provider differences, and user recovery.

### Security/privacy

Map trust boundaries, authn/authz, approval, secrets, PII, filesystem/network/process access, logging/redaction, retention, and abuse cases.

### Observability

Name signals, dimensions, cardinality, thresholds, alerts, and operator action. Avoid “add metrics” without definitions.

### Migration/rollout/rollback

Give ordered phases, compatibility window, backfill/reconciliation, feature flag or kill switch, abort threshold, and rollback effects on stored data.

### Verification

Use Given/When/Then or explicit contracts. Include narrow unit/integration checks, E2E/platform coverage, gates, and manual/operational validation. State what cannot be verified locally.

### Work plan

Each package is independently verifiable, has dependencies and a unique owner/role, and includes tests/docs/migration/rollback work. Avoid arbitrary person-day estimates without team input; label estimates and assumptions.

### Decisions/review record

Each `Qn` has context, options, recommendation, and consequence. TODOs have one owner/role and ISO DDL.
