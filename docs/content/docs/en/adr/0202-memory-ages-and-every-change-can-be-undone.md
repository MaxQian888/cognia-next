---
title: "0202 — Memory ages, and every change can be undone"
description: "Long-term memory gains the aging and reversibility machinery ported from ai-memory: every text change keeps the previous text as a revision (restore, as-of recall), retention with access reinforcement drives forgetting, belief strength comes from corroborating evidence, an opt-in daily sweep compacts or folds cold episodes, rule-based lint reports what deserves a look, recall gains session-recall routing and a bounded LLM rerank, recalled facts sit behind a data-only trust boundary, the redactor catches more secret shapes, and a labeled bilingual eval pins retrieval quality."
---

# ADR 0202 — Memory ages, and every change can be undone

**Status:** Accepted
**Date:** 2026-09-29
**Related:** [ADR-0069](./0069-long-term-memory-external-api-surfaces) (memory subsystem and API surfaces), [ADR-0115](./0115-unified-memory-rag-infrastructure) (retrieval kernel, governance, trust boundary)

## Context

[ai-memory](https://github.com/akitaonrails/ai-memory) is a memory server for
coding agents. Compared against it, Cognia's memory was ahead on governance
(provenance trust, contamination gating, fail-closed PII, encrypted content,
leased jobs, evidence rows, review queues) and behind on four things:

1. **Reversibility.** A consolidation UPDATE, an API patch or a console edit
   replaced `text` in place; the previous wording was gone. A comment in
   `memory-row.tsx` promised a restore that nothing implemented.
2. **Aging.** Decay existed only as a recency factor in ranking. `accessCount`
   was stored and never read, so a memory the user kept needing was forgotten
   under the per-scope cap exactly like one nobody had touched.
3. **Signal breadth in recall.** Two legs (BM25 + vector); no notion of "the
   question asks about a past conversation", no corroboration signal, no rerank.
4. **Evaluation.** ADR-0115 requires fixed bilingual retrieval evals; none
   existed.

Two gaps were security-relevant: personal recalled facts reached the prompt as
bare bullets (ADR-0115 §2 requires a data-only boundary), and the redactor
missed several common secret shapes.

## Decision

### 1. Supersede, never overwrite — revisions in the same table

Every change to a memory's `text` writes the outgoing text as a **revision
snapshot** row in `memories` itself, in the same transaction as the change
(`preserveRevisionIfTextChanges`, called from both write chokepoints:
`updateMemory` and `runMemoryMutation`). A snapshot is `status: "invalidated"`,
`revisionOf` = `supersededById` = the live memory's id, and carries no
`vectorDocId`, `key`, `sourceMessageId` or `sourceSessionId`.

No new table and no schema version: `invalidated` rows are already excluded
from recall, eviction and every active-row query; the new fields
(`revisionOf`, `revisionReason`, `revisedAt`, `compactedAt`, `beliefInputs`) are
unindexed; snapshots inherit encryption, sync and backup from the table.
`listMemories` hides snapshots unless `includeRevisions`; external surfaces
never expose a snapshot by id and refuse to edit or forget one. Deleting a
memory deletes its history; clearing forgotten memories clears history too.

The live row keeps its id and version counter, so MCP/plugin/device callers and
compare-and-swap checks are unaffected. `restore-revision` puts an earlier text
back and keeps the replaced text as the newest revision, so a restore is itself
undoable.

### 2. Historical (`asOf`) recall

`[revisedAt ?? createdAt, invalidatedAt)` is the window a row's text was live
(ingestion time, as in ai-memory's bi-temporal-lite). With `asOf`, the retriever
searches `loadHistoricalCandidates` filtered by `wasLiveAt` plus the governance
exclusions the row had then — lexical only (a vector describes today's text),
no access bump, no rerank. Exposed on `searchMemoriesExternal`, MCP
`memory_search(asOf)` and plugin `ctx.memory.search({ asOf })`; hits whose text
was an earlier wording carry `revisionId` / `validFrom` / `validTo` while `id`
stays the memory's id.

### 3. Retention drives forgetting, not ranking

`retention = salience·e^(−λ·age) + σ·ln(1+accessCount)·e^(−μ·idle)`
(λ 0.02, σ 0.6, μ 0.04; salience derived from existing retrieval feedback).
Eviction ranks by normalized retention + importance. Access reinforcement is on
by default (`accessReinforcementWeight`, 0 disables) because it only ever keeps
memory longer. Access bumps have a 60 s cooldown per memory. As in ai-memory,
retention never enters recall ranking: a memory must not rank higher merely for
having been recalled.

### 4. Belief strength from corroboration

`beliefInputs` (live evidence count, distinct sessions, newest evidence) is
recomputed whenever evidence changes. `belief = clamp(support·recency·
1/(1+contradictions), 0, 0.95)` with ai-memory's constants; `null` when there is
no evidence (legacy rows are "unknown", never "disbelieved"). The consolidation
judge's NOOP now names the memory that already captures a candidate, and the
turn's evidence is attached to it — a restatement is a new witness, not an edit,
and never resets review status. Shown in the inspector; enters ranking only with
`beliefRankingWeight > 0` (default 0).

### 5. Opt-in lifecycle sweep

A daily `memory-lifecycle-sweep` job (enqueued only when a pass is on) selects
cold memories — episodic, unpinned, not a project claim, never compacted,
retention below `coldRetentionThreshold` — coldest first, at most 500:

- **Dedup** (`dedupColdClusters`): per namespace, DBSCAN over stored vectors
  with an adaptive radius capped at cosine distance 0.15; each cluster folds
  into its highest-retention member, whose text absorbs every member's durable
  tokens; the others are superseded and their evidence re-attached to the
  survivor. Deviation from ai-memory: the k-distance radius uses
  `k = minPts − 1`, fixing an off-by-one that kept a two-member group from ever
  merging.
- **Compaction** (`compactColdEpisodic`): summary (≤ 500 bytes) plus up to 48
  durable tokens (URLs, paths, filenames, error codes, HTTP codes, inline code,
  constants, identifiers).

Both write through the revision path; nothing is hard-deleted.

### 6. Memory lint

Report-only checks in the console's Health tab: stale, cold, pinned-but-expiring,
duplicate, feedback-flagged, open conflict, evidence gone, preference awaiting
review, and suspected contradiction (durable memories with cosine similarity in
[0.4, 0.75), coldest 60, ≤ 25 findings). Findings carry ids and numbers only.

### 7. Recall additions

- **Session-recall routing** (`sessionRecallRouting`, opt-in): bilingual
  "last time / 上次" markers multiply episodic scores by 1.25 — ai-memory's +0.25
  on a multiplicative authority factor, mapped onto Cognia's additive score.
- **Bounded LLM rerank** (`llmRerank`, opt-in): one call per recall over at most
  30 candidates, 4 in flight process-wide, all-or-nothing validation, redacted
  query, candidates framed as untrusted data; any failure keeps the local order.
- The dep builder carries these preferences as `defaults`, so every recall
  surface honours one setting; consolidation's similarity lookup opts out.

### 8. Trust boundary and redaction

Recalled facts render under the existing heading followed by a data-only
preamble (shared by chat and the desktop pet); verified working preferences get
a precedence note instead, since the user approved them. The redactor (and the
Rust egress gate) now catch Stripe, full GitHub token family, AWS `ASIA`,
Google OAuth refresh, Meta, Telegram and Slack app tokens, `Bearer` tokens,
env-style secret assignments and credential directory paths, and scan a copy
with escape/bidi control characters removed.

### 9. Labeled retrieval eval

`packages/memory/src/eval` runs the real retriever over a fixed bilingual
golden set (facts, preferences, paraphrase, Chinese, episodes, corroboration,
historical) and reports hit@k, recall@k and MRR per arm and category with deltas
against a lexical baseline. Its test enforces a recall@5 floor of 0.7 and that
routing never costs a non-episode question. `pnpm memory:eval` prints the table.

## Not adopted

- **Markdown wiki as source of truth** — plaintext files contradict ADR-0115's
  encrypted content; backup/export already covers portability.
- **Hook capture of tool output into memory** — contradicts the contamination
  rule (external context never creates memory automatically).
- **Cross-harness claim-once handoffs** — Cognia already has thread handoff
  (ADR-0103); ai-memory's version solves multi-CLI continuity via a shared server.
- **Rule-based session summaries, path/kind authority multipliers** — Cognia's
  memories have no page kinds, and its LLM episode distillation is PII-gated.
- **Companion RPC `asOf`** — the paired-device `memory_search` contract is
  generated across protocol, OpenAPI, CLI and Rust catalogs; left for a
  follow-up so that change lands with its own contract review.

## Consequences

- Memory history grows with every text change. Snapshots are small (one
  statement each), invisible to recall, and removed with their memory.
- Two opt-in passes rewrite text in the background; both are reversible from
  the inspector.
- Recall ranking is unchanged by default except for the recall preamble; every
  new ranking signal is opt-in and measured by the eval.
