/**
 * Prompt templates for the distill sub-agents. Kept in a single file so
 * the prompts can be read end-to-end as one document — they cross-reference
 * each other (the synthesizer expects the playbook agent's confidence
 * scoring rubric, etc.).
 *
 * All prompts use simple `{token}` interpolation; the agent file fills the
 * template via `applyTemplate`.
 */

const SHARED_PREAMBLE = `You are part of a multi-agent pipeline that distils a person's
documents, chat history, and code commits into a faithful "digital twin".
The user is OK with you using their data — privacy-sensitive material has
already been replaced with placeholders like <EMAIL_001> / <NAME_002> /
<CN_ID_003>. Treat those tokens as opaque identifiers (do not try to guess
the original).

You MUST respond with strict JSON only — no prose before or after — and
follow the schema described inside the user prompt verbatim. If a field is
not derivable from the input, omit it (do not invent).`

export const STYLE_AGENT_PROMPT = `${SHARED_PREAMBLE}

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
{chunks}`

export const PLAYBOOK_AGENT_PROMPT = `${SHARED_PREAMBLE}

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
{chunks}`

export const KNOWLEDGE_AGENT_PROMPT = `${SHARED_PREAMBLE}

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
{chunks}`

export const SYNTHESIZER_PROMPT = `${SHARED_PREAMBLE}

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
{profile}

Recent chunks (sample):
{chunks}`

export const EVALUATOR_PROMPT = `${SHARED_PREAMBLE}

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
{drafts}`

/** Trivial token replacement; no logic / loops in the templates. */
export function applyTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : `{${key}}`
  )
}
