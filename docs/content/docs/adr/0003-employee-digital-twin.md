---
title: ADR-0003 — Employee Digital Twin
description: Distil documents, chats, and code into a chat-ready twin with style-faithful retrieval-augmented responses.
---

# Employee Digital Twin

| Status   | Accepted                                                            |
| -------- | ------------------------------------------------------------------- |
| Date     | 2026-05-01                                                          |
| Replaces | The empty `lib/document/knowledge-rag.ts` stub from initial commit. |

## Context

cognia-next started with Character + Skill + Custom Mode as the unit of
delivery, but had **no way to absorb the user's own data**. Every
character was hand-authored. The team wanted a faithful "digital twin"
of an employee that could:

- Retrieve answers from the user's documents, chat exports, and code.
- Match the user's prose tone in generated emails, PRs, and replies.
- Surface playbooks for repeated work patterns ("how does Alice triage
  P1s?") to onboarding teammates.

Two scenarios drove the design:

- **A — Self augmentation.** The user distils themselves into a local
  twin so a Claude session continues their style + reaches for their
  Skills automatically.
- **D — New-hire onboarding.** A predecessor's exports become a twin
  the new hire can interrogate.

## Decisions

### 1. Profile-first distillation

Instead of treating the user's data as one big embedding pool, we
distil first into a **structured profile** (style samples, playbooks,
entity dictionary, decision log) and synthesise Character + Skill
drafts from it. The profile is what the runtime keys off; the raw chunk
pool is its retrieval companion, not the source of truth.

### 2. RAG runs on the renderer, vector store is remote

cognia-next is a Tauri renderer + sidecar. Running the vector index
inside the sidecar would force every read through IPC and break the
"works in the browser too" path. We treat the vector store as a remote
dependency (Qdrant / Pinecone / Milvus / Weaviate / Chroma server are
all supported via the ported `lib/vector/*` clients) and let the
renderer do RAG directly.

### 3. PII redaction before any cloud call

Every chunk passes through `lib/twin/ingest/redact.ts` before we embed
it or feed it to the distill LLM. Redaction is symmetric: we keep the
original text in `twinChunks.content` (for the workbench display) and
the placeholder version in `twinChunks.contentRedacted` (for the
network). The map is encrypted on disk.

### 4. Five sub-agents under one orchestrator

`lib/twin/distill/orchestrator.ts` chains five specialists:

1. **KnowledgeAgent** — entity extraction, batched 100 chunks at a time.
2. **StyleAgent** — representative writing samples.
3. **PlaybookAgent** — repeated work patterns with confidence scoring.
4. **Synthesizer** — composes the Character + Skill drafts.
5. **Evaluator** — scores each draft from a newcomer's perspective.

The orchestrator never talks to a specific provider; it goes through
the `LlmClient` interface in `lib/twin/distill/llm.ts`. Tests inject a
deterministic mock; production wires `createAnthropicLlmClient`.

### 5. Drafts park in their own table until a human accepts

`twinDrafts` is the review queue. Acceptance writes a real
`characters` or `skills` row and stamps `acceptedAsId` on the draft for
audit. This keeps the live picker clean and gives the user a chance to
edit before the twin influences any conversation.

### 6. Soft-bind, no separate twin entity

A "twin" is just a string id. Characters opt in via
`Character.twinId`. Multiple characters can share the same twin
(self-distill, self-summarise, self-coach), and Dexie indexes
`[twinId+kind]` / `[twinId+status]` so the same database can host
multiple unrelated twins without UI gymnastics.

### 7. Runtime injection lives in `applyTwinContext`

`lib/twin/runtime/apply-twin-context.ts` is the single seam between
the chat-send pipeline and the twin subsystem. It always returns
(never throws) so a vector-store outage degrades gracefully to a
no-context send rather than breaking the chat. Phase 8 will expose it
through `lib/claude/build-options.ts:resolveSendOptions` so any
character with a `twinId` automatically picks up RAG + few-shot.

## Data model

Five new Dexie tables sit at v14:

```
twinSources     — registered raw artefacts (file, chat export, code repo)
twinChunks      — sliced text + remote vector pointer + provenance
twinProfile     — distilled structured profile (1:1 with twinId)
twinDrafts      — synth output queued for human review
twinJobs        — ingest / distill workflow tracking
```

`Character` gains optional `twinId` + `twinSettings` to opt into the
runtime injection.

## Pipeline

```
Ingest:   sources → parse → redact → chunk → embed → persist (Dexie + vector store)
Distill:  chunks  → knowledge → style → playbook → synth → evaluate → drafts
Runtime:  user msg → embed (1×) → RAG topK + style topK → 4-segment system prompt
```

## What this does NOT include

- Importers for non-document sources (Slack / Lark / DingTalk / WeChat
  / .mbox / .eml / git-repo). The pipeline accepts pasted text in
  Phase 7; these importers land later as `lib/twin/importers/*`.
- The scheduler executor that drives cron-driven distill retries.
  Phase 4-5 ship a manual job-worker (`lib/twin/job-worker.ts`); the
  scheduler integration follows.
- `lib/claude/build-options.ts` does NOT yet call `applyTwinContext`.
  The runtime is opt-in until that wiring lands; until then the
  workbench shows the prompt assembly in isolation.

## Consequences

- We pay for two writes per chunk: Dexie (full text + provenance) and
  the remote vector store (vector + 200-char preview). Storage cost is
  small and the redundancy lets us recover if either side drifts.
- Distill is bursty: ~5 LLM calls per run (one per agent) plus ⌈N/100⌉
  knowledge calls. A 1k-chunk run runs in ~2 minutes against Claude
  Sonnet 4.6 and costs roughly $0.30.
- Runtime adds ~150ms to a chat send (one embed + one vector search +
  one Dexie batch lookup). The 4-segment prompt is structured so
  Anthropic's prompt cache catches the identity block.

## See also

- `lib/twin/ingest/job-runner.ts` — seven-stage ingest pipeline
- `lib/twin/distill/orchestrator.ts` — five-agent distill pipeline
- `lib/twin/runtime/apply-twin-context.ts` — runtime entry point
- `components/twin/twin-panel.tsx` — review workbench
- `~/.claude/plans/superpowers-deep-penguin.md` — original execution plan
