# Technical proposal review gates

Read every section. Mark each item pass, fixed, not applicable with reason, or open decision.

## Proposal integrity

- [ ] Recommendation and user/operator outcome are explicit.
- [ ] Current state is verified against current code/config/tests.
- [ ] Confirmed, inferred, proposed, and open statements are distinguishable.
- [ ] Goals are measurable and map to acceptance.
- [ ] Non-goals and deferred work are explicit.
- [ ] Scope has no unrelated refactor or speculative platform.
- [ ] Existing modules/contracts were considered before new abstractions.
- [ ] Every alternative has tradeoffs and a recommendation.
- [ ] Every material decision explains why.

## Architecture and contracts

- [ ] Owners, consumers, sources of truth, and boundaries are named.
- [ ] Inputs, outputs, types, validation, units, errors, and versioning are defined.
- [ ] State transitions and terminal states are unambiguous.
- [ ] Ordering, concurrency, idempotency, timeout, cancellation, retry, and recovery are covered.
- [ ] Cross-layer serialization and tuple/object shape are explicit.
- [ ] New module/command/component/plugin is wired to a runtime entry.
- [ ] Static-export constraints are preserved.
- [ ] Tauri commands are registered and capability/ACL implications covered.
- [ ] Provider/platform differences are explicit rather than hidden in generic language.

## Data and migration

- [ ] Stored data owner and lifecycle are defined.
- [ ] Schema/index/constraints/retention are justified.
- [ ] Dexie/SQLite/file-format version migration is forward-safe.
- [ ] Backfill, partial failure, resume, and reconciliation are defined.
- [ ] Cross-account/workspace isolation and deletion propagation are covered.
- [ ] Rollback behavior for newly written data is explicit.
- [ ] Backup/export/import compatibility is considered.

## Security and privacy

- [ ] Trust boundaries and threat actors are named.
- [ ] Authentication and authorization are separate and enforced at boundaries.
- [ ] Permission/approval modes and irreversible actions are covered.
- [ ] Secrets never enter logs, prompts, URLs, or persisted plain text.
- [ ] Outbound model/embedding/cloud text passes PII redaction.
- [ ] Filesystem paths, symlinks, traversal, process execution, and network destinations are constrained.
- [ ] Multi-tenant/account/workspace isolation has adversarial tests.
- [ ] Auditability, retention, deletion, and incident response are covered.

## Reliability and observability

- [ ] Failure domains and first observable failure are identified.
- [ ] Logs/metrics/traces/audit events have names, dimensions, and owners.
- [ ] Metric dimensions are bounded; no high-cardinality user content.
- [ ] Alert thresholds and operator actions are concrete.
- [ ] Crash/restart/reconnect/duplicate delivery/stale state are covered.
- [ ] Background tasks shut down; no detached work keeps tests/processes alive.
- [ ] Degradation and kill switch preserve a safe minimum behavior.

## Performance and cost

- [ ] Baseline and target are measured or clearly estimated.
- [ ] Critical path, memory, bundle, startup, DB, network, and concurrency costs are considered.
- [ ] Resource limits and backpressure exist for queues/processes/pages/sessions.
- [ ] Caching has invalidation, scope, and stale behavior.
- [ ] Added service/storage/model cost is quantified when material.

## UX, mobile, and accessibility

- [ ] Loading/empty/error/offline/recovery states are designed.
- [ ] Accessible name, keyboard, focus, contrast, and screen-reader behavior are covered.
- [ ] User-facing strings and aria labels are localized in English and Chinese.
- [ ] Desktop web, Tauri, mobile standalone/paired, iOS/Android differences are scoped.
- [ ] Destructive or external actions have clear confirmation and result feedback.

## Testing and delivery

- [ ] Unit/integration tests own edge cases at the narrowest layer.
- [ ] Edited governed source has co-located tests.
- [ ] E2E decision is explicit with behavior contract and project/platform.
- [ ] Static export/native/real service claims use the correct harness.
- [ ] Verification commands exist and match current scripts.
- [ ] CI platform gaps are stated.
- [ ] Rollout phases have entry, success, abort, and rollback conditions.
- [ ] Work packages include tests, docs, migration, observability, and cleanup.
- [ ] Every TODO has one owner/role and ISO DDL.

## Structure and communication

- [ ] Executive summary answers what/why/impact/decision.
- [ ] Section titles and first sentences form a coherent story.
- [ ] Lists use one MECE dimension.
- [ ] Vague adjectives are replaced with numbers or hypotheses.
- [ ] Diagrams each carry one conclusion and have been rendered/inspected.
- [ ] No private tokens, secrets, personal paths, or stale absolute line numbers.
- [ ] Sources are linked to repository files/docs and directly support claims.

## Approval bar

A proposal is review-ready only when:

1. no critical implementation gap is disguised as a TODO;
2. open items are explicit reviewer decisions;
3. implementation, verification, migration, and rollback are independently executable;
4. security/privacy and platform constraints are resolved or have blocking owners;
5. the canonical Markdown is complete and source-controlled.
