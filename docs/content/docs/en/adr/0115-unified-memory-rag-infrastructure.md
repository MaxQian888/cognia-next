---
title: "ADR-0115: Unified Memory and RAG Infrastructure"
description: One safe retrieval kernel and recoverable control plane shared by Memory, Twin, Project Knowledge, Knowledge Base, and External RAG.
---

# ADR-0115: Unified Memory and RAG Infrastructure

## Status

Accepted (2026-08-13). This is a Heavy ADR. Rollout is phased and each phase has an independent kill switch, compatibility boundary, validation gate, and rollback exercise.

## Context

Cognia has five retrieval domains: learned Memory, Digital Twin, Project Knowledge, Knowledge Base, and External RAG. They intentionally have different ownership, authorization, retention, review, and presentation semantics. They nevertheless duplicated query embedding, lexical search, vector fusion, retry behavior, indexing lifecycle, and diagnostics.

The duplication created security and reliability gaps:

- provider locality was sometimes inferred from the vector backend rather than the embedding provider;
- some chat and workflow paths embedded raw queries outside the PII boundary;
- vector failure could be indistinguishable from an empty corpus;
- Project, KB, and Twin indexing could delete the serving generation before replacement succeeded;
- Memory jobs collapsed no-output, skipped, and successful work into `completed`;
- traces and caches had no common content-free identity or retention policy;
- procedural findings could reach retrieval before explicit review;
- legacy governance defaults represented unknown values as known values.

The domains must not be merged into one entity model. Memory is governed learned state, Twin is a curated personal corpus, Project Knowledge follows workspace trust and source snapshots, KB has explicit source management, and External RAG is a compatibility bridge. They share infrastructure, not business identity.

## Decision

### 1. Canonical profile and provider locality

`RetrievalProfileV1` is the stable configuration boundary. It records the embedding provider/model, vector backend, query budget, expansion/rerank choices, and safety policy. Its canonical SHA-256 fingerprint is independent of object key order. A changed fingerprint requires a new index generation; it never mutates a serving generation in place.

Provider locality comes only from `@cognia/provider-embedding/embedding-catalog`. `native-local`, `local-openai`, and `browser` providers are local. Bedrock and hosted providers are remote even when the vector database is local.

### 2. One outbound embedding gateway

Every application-owned query/document embedding crosses `SafeEmbeddingGateway`.

- Remote providers always receive a redacted projection and fail closed if the post-redaction scanner still detects PII.
- A local provider receives original text only when the profile explicitly allows it; the default is still redaction.
- Cache identity is `provider:model:SHA256(safeText)`. Cache entries, results, jobs, and traces never contain the text.
- Empty, non-finite, or dimension-mismatched embeddings are rejected before vector search.

Query expansion, provider reranking, and the final assembled provider prompt must use the same locality/redaction/fail-closed rule. Retrieved data is always placed behind a data-only trust boundary.

### 3. One compositional retrieval kernel

`@cognia/rag` owns the only fusion and budget orchestration kernel. A request contains reader scope, eligible domains, query, budgets, optional precomputed safe embedding, and cancellation. Domain adapters own only authorization joins, source-specific scoring fields, encrypted content resolution, and UI mapping.

The kernel runs lexical retrieval regardless of vector availability. Vector absence, embedding failure, timeout, or dimension mismatch returns an explicit BM25 partial/degraded result with a machine-readable reason. It cannot masquerade as a normal empty result.

The old `RAGRuntime`, `RAGPipeline`, workflow node, plugin API, MCP, RPC, and companion contracts remain compatibility façades. They delegate into the profile/gateway/kernel/control-plane services without changing their public signature during the compatibility window.

### 4. Content-free traces

`RetrievalTraceV1` stores only query hash, profile fingerprint, generation id, candidate/hit ids, component scores, exclusion reasons, cache state, budget, latency, and grounding counts. It forbids query text, content, paths, and user identifiers. Trace writes reject content-bearing field names.

Successful/no-output jobs and traces are retained for 30 days and capped at 20,000 rows per profile. Failures, quarantine, and safety events retain for 90 days. Content-free audit retains for 180 days.

### 5. Generation-based indexing

Each corpus/profile pair builds a new `IndexGeneration` through:

`staging → validating → active → retiring`, with `failed` as a terminal branch.

Validation records count, content hash, and vector dimension. A transaction changes the active pointer and retires the previous generation. A failed generation never changes the pointer. Cloud stores use a generation namespace or mandatory metadata filter. Project source snapshots advance only after activation.

### 6. Durable shared jobs

`RetrievalJob` and `MemoryJob` use:

`queued | running | retry_wait | succeeded | no_output | skipped | failed | cancelled`.

Claims are leased, heartbeated, attempt-bounded, deduplicated, cancellable, and recoverable after lease expiry. Retry scheduling uses exponential backoff. A terminal policy denial is `skipped`, an extractor with no durable result is `no_output`, and exhausted transient work is `failed`; none is reported as success.

Memory consolidation is serialized by profile + scope + namespace. Memory mutation, evidence attachment, and audit projection must commit atomically. Reconciliation detects orphan vectors, missing chunks, and invalid active pointers.

### 7. Memory governance and multi-agent isolation

Global `useMemory` and `learnFromChats` values are defaults. A session `inherit/on/off` override may enable or disable them. Hard gates remain `enabled`, temporary mode, agent operation/scope permissions, external-context policy, and `autoExtract`.

Automatic writes default to workspace when a project exists, otherwise global. Character, agent, branch, or path narrowing requires an explicit applicability rationale. Every read carries project, agent, Git branch, and normalized workspace-relative path.

User-authored and assistant/tool evidence carry distinct roles. Assistant output is never represented as a user assertion. Agent and external-agent findings start as private, untrusted inbound drafts. Shared Memory requires supervisor policy or explicit user promotion.

Unreviewed procedural rows migrate to `pending_instruction` and are never retrieved. Acceptance may promote them to verified instruction, disabled Skill, or Workflow using the existing inbound draft/materializer path.

Ranking uses relevance, recency, importance, confidence, provenance, feedback, staleness, review, and contamination. Expired, conflicted, quarantined, and pending procedural rows are hard-excluded.

### 8. Encryption and device keys

Canonical content, safe projections, evidence excerpts, and lexical segments persist only as `EncryptedContentEnvelopeV1`: AES-256-GCM with key id, random 96-bit IV, ciphertext, and AAD hash. A profile DEK is distinct from pairing/signing keys.

Each device generates a wrapping key in its native protection boundary: OS keyring on Desktop, SecureStorage on Mobile, configured secret store on Headless, and unlocked Browser Vault on Web. Locked Browser Vault is an explicit locked state; plaintext fallback is prohibited.

Sync transports ciphertext envelopes only. A client without the key protocol receives `upgrade_required`. Portable backup wraps the DEK using the existing backup passphrase/key. Plaintext export is a separate, confirmed, audited action.

### 9. Authorization, trust, and deletion

Source authorization and workspace trust are evaluated before scoring. Revocation immediately removes a source from eligibility, then retires its generation and asynchronously cascades vector/cache cleanup. Retrieved chunks carry trust and contamination. Prompt-injection-risk chunks are quarantined without altering canonical content.

Deletion cascades domain entity, source/chunk/evidence references, encrypted index/cache rows, and a sync tombstone. Tombstones remain until every known device acknowledges them, then at least 30 more days. Audit retains only content-free, de-identified events.

### 10. Grounding and compaction continuity

RAG answers produce claim-to-chunk support and exact offsets. Interactive chat annotates unsupported claims after streaming. Automation, external sends, and high-risk paths block or safely retry below their grounding threshold.

Compaction reuses working set, boundary, undo, and Optical Archive. `CompactionCheckpointV1` records goal, completed work, active state, decisions/rationale, evidence refs, blockers, next steps, constraints, do-not-repeat items, exact reinjection versions, and token counts. Resume/fork/model-switch deterministically re-injects policy, verified instruction, working set, selected Skills, and eligible Memory/RAG within budget.

## Storage and migration

Dexie v163 adds profiles, generations, active pointers, jobs, traces, encrypted content, tombstones, and a migration journal. Dexie v164 adds Memory governance indexes and migrates the job state model. Dexie v165 indexes derived RAG chunks by generation, v166 adds the shared rollout kill switch, and v167 indexes Memory updates for bounded Companion sync. Legacy confidence/expiry/staleness remains explicitly unknown. Legacy unreviewed procedural content becomes pending review.

Migration is journaled and resumable:

1. add schema;
2. enable dual read and compare results;
3. encrypt canonical content and lexical segments in bounded batches;
4. backfill unknown governance fields without model inference;
5. build and validate new generations;
6. pass quality gates;
7. atomically cut over reads and writes;
8. clear legacy plaintext only after verification.

Rollback changes only the active pointer and compatibility adapter. It never restores plaintext and never downgrades to a client that cannot decrypt the current envelope/key protocol. A single kill switch stops new-kernel reads, ingestion, and promotion while preserving decryption, export, deletion, reconciliation, and safe BM25 reads.

## Capacity and SLO

Desktop/Headless target 100,000 Memory history rows, 1,000,000 chunks, and 10 GB canonical content per profile. Web/Mobile use the same contracts with a bounded offline set and recent-hit cache; authenticated Desktop/Headless remains the online authority.

- hot BM25 p95 ≤ 150 ms;
- native hybrid p95 ≤ 500 ms;
- first context batch ≤ 700 ms;
- additional peak memory ≤ 512 MB;
- indexing never runs on the UI thread.

Timeout returns an explicit BM25 partial result.

## Consequences

Security and failure semantics are fixed once in shared infrastructure. Domain code becomes smaller but keeps its authorization and lifecycle ownership. Migration requires temporary dual storage and more control-plane rows. Encryption prevents ad-hoc IndexedDB inspection and makes key recovery/rotation part of product operation. Compatibility façades delay removal of duplicated public APIs until all surfaces prove parity.

## Verification

Required gates include locality and PII fail-closed tests, session override/scope tests, governance ranking/exclusion, job state and lease failure injection, generation switch failure, encryption/AAD/key rotation, revocation/deletion/tombstones, grounding, migration restart/rollback, fixed bilingual retrieval evals, scale/SLO tests, full coverage/type/lint/i18n/static-export/data-governance audits, plugin/companion contracts, build, and Web/Mobile/Tauri E2E.
