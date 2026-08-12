---
title: "ADR-0112: Unified Decision, Provenance, and Conflict Ledger"
description: Make control decisions, content evidence, lineage, and pre-merge conflicts inspectable through one privacy-preserving local contract.
---

# ADR-0112: Unified Decision, Provenance, and Conflict Ledger

## Status

Accepted (2026-08-11).

## Context

Cognia already persisted Memory evidence and conflicts, Workflow lineage, Twin observations, connector audit rows, and Action Review receipts. Those domain models answered local questions but could not jointly answer “why did this action happen?” without bespoke joins. Twin re-distillation also de-duplicated equivalent choices but did not preserve contradictory choices as an explicit review object.

## Decision

1. `@cognia/agent-config-types/governance` defines versioned, dependency-free `DecisionCaseV1`, `DecisionEventV1`, `EvidenceRefV1`, `LineageEdgeV1`, `ConflictSetV1`, and `ProvenanceEnvelopeV1` contracts. Domain payloads remain in their owning stores. The ledger holds references, redacted user-facing rationale, primitive metadata, and SHA-256 digests only; it never stores prompts, tool arguments/results, connector bodies, captured text, secrets, or model chain-of-thought.
2. Dexie v157 adds six device-local tables: `governanceDecisions`, `governanceDecisionEvents`, `governanceEvidence`, `governanceLineage`, `governanceConflicts`, and `governanceProvenance`. Writes are idempotent by producer-stable IDs. Decision events are append-only and advance a current-state projection.
3. Producers project Workflow branches, all `approveTool` outcomes, Action Review receipts/effects, Memory conflict resolution, Twin decisions, capture persistence, and connector inbound routing. Projection failures are best-effort and cannot break the source action.
4. Conflict detection runs before semantic merge. Equivalent Twin context-and-choice observations union their evidence references; different choices for the same normalized context remain separate, transition to `disputed`, and create an open `ConflictSet`. Memory’s existing `CONFLICT` and human resolution flow projects the same generic conflict/decision/lineage objects. Raw capture and connector events remain immutable evidence; they are not silently promoted into facts.
5. The Security & Privacy settings page mounts a live Context Inspector. It lists recent decisions and shows outcome, reason, event/evidence/lineage/provenance counts, and open-conflict status. It reads only the redacted ledger.
6. All six tables are protected, account-scoped, device-local audit data. They are excluded from portable backup and Companion sync; account deletion removes them with the account database.

## Consequences

- Workflow, authorization, approval, connector, Memory, and Twin decisions share one query model while keeping their specialized source records.
- Replay is safe and state changes remain explainable as events.
- Contradictions are reviewable before consolidation instead of being overwritten.
- The ledger is a thin derived relation projection, not an RDF/OWL or rule-engine dependency.
- Existing source actions remain available if governance projection fails; missing projections are observable as an audit gap rather than an action outage.

## Verification

Contract validators, Dexie v157 schema/index migration, repository idempotency and event ordering, each producer’s content-redaction behavior, Twin evidence union/conflict creation, Memory conflict resolution, Workflow routing, connector routing, tool authorization success/failure, Context Inspector interaction, i18n parity, data-catalog exclusion from sync/backup, typecheck, lint, coverage, and static-export checks.

## References

- `docs/research/decision-evidence-lineage-conflict-design-2026-08-11.md`
- `docs/research/semantica-borrowable-ideas-2026-08-11.md`
