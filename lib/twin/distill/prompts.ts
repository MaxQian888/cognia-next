/**
 * Prompt templates for the distill sub-agents. Kept in a single file so
 * the prompts can be read end-to-end as one document — they cross-reference
 * each other (the synthesizer expects the playbook agent's confidence
 * scoring rubric, etc.).
 *
 * Each is a Prompt Center definition (ADR-0236): the agent resolves it with
 * its data as `{{chunks}}` / `{{profile}}` / `{{drafts}}` values, which are
 * inserted once and never re-scanned. The JSON keys each agent parses are
 * required fragments, so a customized body cannot stop asking for them.
 */

import { definePrompt, type PromptVariableSpec } from "@/lib/prompts/types"

/** Chunk and profile text is bounded by the agents' own caps; this only guards. */
const DATA_MAX = 1_000_000

function twinDistillPrompt(input: {
  stage: string
  consumer: string
  variables: readonly string[]
  requiredFragments: readonly string[]
  defaultBody: string
}) {
  return definePrompt({
    id: `twin.distill.${input.stage}`,
    contractVersion: 1,
    kind: "feature-template",
    group: "twin",
    operation: "replace-template",
    scopes: ["account"],
    activation: "next-operation",
    // Each stage's reply is parsed as JSON against the schema in its body.
    risk: "protocol",
    hosts: ["app"],
    maxChars: 16_000,
    variables: input.variables.map((name): PromptVariableSpec => ({
      name,
      required: true,
      maxChars: DATA_MAX,
    })),
    requiredFragments: input.requiredFragments,
    consumers: [input.consumer],
    defaultBody: input.defaultBody,
  })
}

const SHARED_PREAMBLE = `You are part of a multi-agent pipeline that distils a person's
documents, chat history, and code commits into a faithful "digital twin".
The user is OK with you using their data — privacy-sensitive material has
already been replaced with placeholders like <EMAIL_001> / <NAME_002> /
<CN_ID_003>. Treat those tokens as opaque identifiers (do not try to guess
the original).

You MUST respond with strict JSON only — no prose before or after — and
follow the schema described inside the user prompt verbatim. If a field is
not derivable from the input, omit it (do not invent).`

export const STYLE_AGENT_PROMPT = twinDistillPrompt({
  stage: "style",
  consumer: "lib/twin/distill/agents/style-agent.ts",
  variables: ["chunks"],
  requiredFragments: ['"samples"'],
  defaultBody: `${SHARED_PREAMBLE}

Your job is to extract **representative writing samples** from the chunks
below. Pick samples that show recurring patterns in tone, structure, or
vocabulary. Aim for 5-15 samples covering distinct contexts (rejection
emails, PR descriptions, customer replies, meeting notes, …); skip
samples that are duplicated by an earlier choice.

Schema:
{
  "samples": [
    {
      "contextLabel": "short human-readable label",
      "original":     "verbatim chunk text (do not paraphrase)",
      "summary":      "one-sentence description used as a retrieval key",
      "tone":         ["array", "of", "short", "tone", "tags"]
    }
  ]
}

Chunks:
{{chunks}}`,
})

export const PLAYBOOK_AGENT_PROMPT = twinDistillPrompt({
  stage: "playbook",
  consumer: "lib/twin/distill/agents/playbook-agent.ts",
  variables: ["chunks"],
  requiredFragments: ['"playbooks"'],
  defaultBody: `${SHARED_PREAMBLE}

Your job is to detect **repeated work patterns** — the same kind of problem
solved with a similar sequence of steps in 3+ chunks. Output at most 10
playbooks ordered by frequency. Skip one-off sequences.

Schema:
{
  "playbooks": [
    {
      "title":      "short imperative title",
      "trigger":    "natural-language description of when this playbook applies",
      "steps":      [{"order": 1, "action": "...", "rationale": "optional why"}],
      "examples":   [{"sourceChunkIds": ["chunkId1", "chunkId2"], "outcome": "what happened"}],
      "confidence": 0.0   // 0..1; reflect frequency × step-similarity
    }
  ]
}

Chunks (each prefixed with its id in square brackets):
{{chunks}}`,
})

export const KNOWLEDGE_AGENT_PROMPT = twinDistillPrompt({
  stage: "knowledge",
  consumer: "lib/twin/distill/agents/knowledge-agent.ts",
  variables: ["chunks"],
  requiredFragments: ['"entities"', '"perChunk"', '"decisions"'],
  defaultBody: `${SHARED_PREAMBLE}

Your job is to extract **named entities and decisions** mentioned in the chunks.
Entities include people, teams, projects, systems, and abstract concepts. Merge aliases — if multiple
chunks call the same project "X-service", "x-svc", and "the X service",
collapse them into one record with all aliases.

Schema:
{
  "entities": [
    {
      "name":      "canonical name",
      "aliases":   ["other", "spellings"],
      "role":      "person|team|project|system|concept",
      "relation":  "optional one-line note on how the user relates to it",
      "firstSeenChunkId": "the chunkId where the entity first appears"
    }
  ],
  "perChunk": [
    { "chunkId": "...", "entityNames": ["X-service", "alice"] }
  ],
  "decisions": [
    {
      "context": "the situation or tradeoff",
      "choice": "what the user chose",
      "rationale": "why they chose it",
      "sourceChunkIds": ["chunkId1"],
      "timestamp": 1735689600000
    }
  ]
}

Chunks (each prefixed with its id in square brackets):
{{chunks}}`,
})

export const SYNTHESIZER_PROMPT = twinDistillPrompt({
  stage: "synthesizer",
  consumer: "lib/twin/distill/agents/synthesizer.ts",
  variables: ["profile", "chunks"],
  requiredFragments: ['"character"', '"skills"'],
  defaultBody: `${SHARED_PREAMBLE}

You receive an already-distilled \`profile\` (style samples, playbooks,
entities, decisions) and a sample of recent chunks for grounding. Produce:

  • exactly one Character draft (system prompt + voice description), and
  • one Skill draft per playbook with confidence ≥ 0.6.

Skills must read as standalone Markdown the user could approve and start
using on day 1. Each skill should embed at least one example pulled from
the playbook's examples list.

Schema:
{
  "character": {
    "name":         "Twin display name",
    "description":  "short marketing-style summary",
    "systemPrompt": "the actual prompt — sets voice, scope, defaults",
    "voiceSummary": "one-paragraph distilled voice (≤200 chars)"
  },
  "skills": [
    {
      "name":            "short imperative skill title",
      "description":     "one-line description",
      "content":         "Markdown body of the skill",
      "sourcePlaybookId": "id of the playbook it was derived from",
      "rationale":       "why this draft exists (count of examples / chunks)"
    }
  ]
}

Profile:
{{profile}}

Recent chunks (sample):
{{chunks}}`,
})

export const EVALUATOR_PROMPT = twinDistillPrompt({
  stage: "evaluator",
  consumer: "lib/twin/distill/agents/evaluator.ts",
  variables: ["drafts"],
  requiredFragments: ['"evaluations"'],
  defaultBody: `${SHARED_PREAMBLE}

You are a critical reviewer. Score each draft below from a "newcomer just
joining the team" perspective. Flag concerns that would block them from
acting on the draft, and concrete suggestions to improve it.

Schema:
{
  "evaluations": [
    {
      "draftId":      "echoes the input draftId",
      "qualityScore": 0.0,           // 0..1
      "concerns":     ["short bullets"],
      "suggestions":  ["short bullets"]
    }
  ]
}

Drafts:
{{drafts}}`,
})

/**
 * The cross-batch entity merge (M3). It does not share the preamble: it sees
 * only entity names, aliases and relations, never chunk text. `{{role}}` is
 * one of the five entity roles and `{{entries}}` the numbered registry rows.
 */
export const ENTITY_MERGE_AGENT_PROMPT = twinDistillPrompt({
  stage: "entity-merge",
  consumer: "lib/twin/distill/agents/entity-merge-agent.ts",
  variables: ["role", "entries"],
  requiredFragments: ['"clusters"', '"canonical"', '"aliases"'],
  defaultBody: `You are normalising an entity registry of role "{{role}}" extracted from
chunked employee documents and chats. Group entries that refer to the
SAME real-world entity — e.g. "Engineering Infra Team" + "infra-team" +
"Eng-Infra" all map to one team.

Only merge when you have high confidence the names share a referent. Do
not merge near-misses (e.g. "Platform Team" vs "Infrastructure Platform")
unless context strongly suggests they're the same.

Output JSON of the form:
{
  "clusters": [
    { "canonical": "Engineering Infra Team", "aliases": ["infra-team", "Eng-Infra"] },
    ...
  ]
}

Entries with no merge group can be omitted. Names that share a cluster
must NOT also appear in another cluster.

Entries:
{{entries}}`,
})
