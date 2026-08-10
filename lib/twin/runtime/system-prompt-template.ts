/**
 * System prompt assembly for twin-bound characters.
 *
 * Produces a four-segment prompt:
 *
 *   1. Character system prompt (user-authored / accepted draft)
 *   2. Twin identity block (voice + entity dictionary) — STABLE per-twin,
 *      so it sits at the top to maximise Anthropic prompt-cache hits.
 *   3. Retrieved knowledge chunks for THIS turn (variable, but kept
 *      together so the cached prefix stays intact).
 *   4. Style few-shot samples for THIS turn.
 *
 * The runtime also returns metadata describing what was injected so the
 * UI's citation panel can show the user "your twin pulled from these
 * sources for this answer".
 */

import type {
  DecisionRecord,
  Playbook,
  ProfileEntity,
  RetrievedTwinChunk,
  StyleSample,
} from "@/types/twin"

export interface ApplyTemplateInput {
  /** The character's existing systemPrompt (may be empty for fresh twins). */
  baseSystemPrompt?: string
  /** Display name for the twin — surfaced inside the identity block. */
  twinName: string
  /** Voice summary persisted by the synthesizer. */
  voiceSummary?: string
  /** Person / team / project entries to surface in the entity dictionary. */
  entities: ProfileEntity[]
  /**
   * Distilled behavioural playbooks (trigger → steps). Per-profile, so they
   * ride the STABLE segment. Already-promoted playbooks (those adopted into a
   * Skill) are filtered out here so they aren't double-injected. Defaults to
   * none.
   */
  playbooks?: Playbook[]
  /** Recent decisions, pinned first, used as stable behavioural context. */
  decisions?: DecisionRecord[]
  /** Retrieved chunks for THIS turn (already filtered by the RAG step). */
  retrievedChunks: RetrievedTwinChunk[]
  /** Selected style few-shot samples for THIS turn. */
  styleSamples: StyleSample[]
  /** Maximum entities to list (alphabetical). Defaults to 20. */
  maxEntitiesShown?: number
  /** Maximum length for `voiceSummary` before truncation. Defaults to 200. */
  maxVoiceSummary?: number
  /** Maximum playbooks to inject (highest-confidence first). Defaults to 5. */
  maxPlaybooksShown?: number
  /** Maximum decisions to inject. Defaults to 5. */
  maxDecisionsShown?: number
}

export interface AppliedTemplate {
  /** Final assembled system prompt. */
  systemPrompt: string
  /**
   * The same prompt split at the stable/dynamic boundary for cache-friendly
   * assembly (`AppSettings.cacheOptimizationEnabled`): `stable` carries
   * sections 1–2 (character prompt + twin identity, constant per twin),
   * `dynamic` carries sections 3–4 (retrieved chunks + style few-shot,
   * different every turn). `stable + dynamic` joined with the section
   * separator always equals `systemPrompt`.
   */
  cacheSegments: {
    stable: string
    dynamic: string
  }
  /** Provenance metadata for the citation panel. */
  metadata: {
    twinName: string
    retrievedChunkIds: string[]
    styleSampleIds: string[]
  }
}

const ENTITY_ROLE_LABELS: Record<ProfileEntity["role"], string> = {
  person: "Person",
  team: "Team",
  project: "Project",
  system: "System",
  concept: "Concept",
}

function formatEntityDictionary(entities: ProfileEntity[], maxShown: number): string {
  if (entities.length === 0) return ""
  // Surface people, teams, and projects first — concepts are noisier and
  // tend to overflow the budget on long-running twins.
  const priority: ProfileEntity["role"][] = ["person", "team", "project", "system", "concept"]
  const sorted = [...entities].sort((a, b) => {
    const pa = priority.indexOf(a.role)
    const pb = priority.indexOf(b.role)
    if (pa !== pb) return pa - pb
    return a.name.localeCompare(b.name)
  })
  const shown = sorted.slice(0, maxShown)
  return shown
    .map((entry) => {
      const role = ENTITY_ROLE_LABELS[entry.role]
      const aliases = entry.aliases.length > 0 ? ` (aka ${entry.aliases.join(", ")})` : ""
      const relation = entry.relation ? ` — ${entry.relation}` : ""
      return `- ${role}: ${entry.name}${aliases}${relation}`
    })
    .join("\n")
}

/** Per-entry cap so one verbose playbook can't dominate the stable budget. */
const MAX_PLAYBOOK_ENTRY_LEN = 200
const MAX_DECISION_ENTRY_LEN = 240

/**
 * Render the high-confidence, not-yet-promoted playbooks as terse
 * "When {trigger}: {steps}" lines. Skips playbooks already adopted into a Skill
 * (`promotedToSkillId`), sorts by confidence desc, caps to `maxShown`, and caps
 * each entry's length. Returns `""` when nothing survives filtering.
 */
function formatPlaybooks(playbooks: Playbook[], maxShown: number): string {
  const eligible = playbooks
    .filter((p) => !p.promotedToSkillId)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxShown)
  if (eligible.length === 0) return ""
  return eligible
    .map((p) => {
      const steps = [...p.steps]
        .sort((a, b) => a.order - b.order)
        .map((s) => s.action.trim())
        .filter(Boolean)
        .join(" → ")
      let entry = `When ${p.trigger.trim()}: ${steps}`
      if (entry.length > MAX_PLAYBOOK_ENTRY_LEN) {
        entry = `${entry.slice(0, MAX_PLAYBOOK_ENTRY_LEN).trimEnd()}…`
      }
      return `- ${entry}`
    })
    .join("\n")
}

function formatDecisions(decisions: DecisionRecord[], maxShown: number): string {
  return [...decisions]
    .sort(
      (a, b) =>
        Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
        (b.timestamp ?? 0) - (a.timestamp ?? 0)
    )
    .slice(0, maxShown)
    .map((decision) => {
      let entry = `${decision.context.trim()} → ${decision.choice.trim()}`
      if (decision.rationale.trim()) entry += ` — ${decision.rationale.trim()}`
      if (entry.length > MAX_DECISION_ENTRY_LEN) {
        entry = `${entry.slice(0, MAX_DECISION_ENTRY_LEN).trimEnd()}…`
      }
      return `- ${entry}`
    })
    .join("\n")
}

function formatRetrievedChunks(chunks: ApplyTemplateInput["retrievedChunks"]): string {
  if (chunks.length === 0) return ""
  return chunks
    .map(({ chunk, score, sourceTitle }, i) => {
      const title = sourceTitle ?? "Unknown source"
      const heading = `### Chunk ${i + 1} — ${title} (score ${score.toFixed(2)})`
      return `${heading}\n${chunk.contentRedacted}`
    })
    .join("\n\n")
}

function formatStyleSamples(samples: StyleSample[]): string {
  if (samples.length === 0) return ""
  return samples
    .map((sample, i) => {
      const tone = sample.tone.length > 0 ? ` [${sample.tone.join(", ")}]` : ""
      return `### Sample ${i + 1} — ${sample.contextLabel}${tone}\n${sample.original}`
    })
    .join("\n\n")
}

/**
 * Assemble the four-section system prompt. All sections are optional — a
 * twin with no profile yet still produces a sensible prompt with just the
 * base + twin name. Empty sections are skipped (no empty headings).
 */
export function applySystemPromptTemplate(input: ApplyTemplateInput): AppliedTemplate {
  const sections: string[] = []
  const dynamicSections: string[] = []
  const maxVoice = input.maxVoiceSummary ?? 200
  const maxEntities = input.maxEntitiesShown ?? 20
  const maxPlaybooks = input.maxPlaybooksShown ?? 5
  const maxDecisions = input.maxDecisionsShown ?? 5

  // 1. Original character prompt
  const base = input.baseSystemPrompt?.trim()
  if (base) sections.push(base)

  // 2. Twin identity (stable)
  const identityLines: string[] = [`You are ${input.twinName}.`]
  if (input.voiceSummary) {
    const truncated =
      input.voiceSummary.length > maxVoice
        ? `${input.voiceSummary.slice(0, maxVoice).trimEnd()}…`
        : input.voiceSummary
    identityLines.push("", "Voice and tone:", truncated)
  }
  const dictionary = formatEntityDictionary(input.entities, maxEntities)
  if (dictionary) {
    identityLines.push(
      "",
      "People, teams, and projects you know (do not enumerate proactively — use as context):",
      dictionary
    )
  }
  sections.push(identityLines.join("\n"))

  // 2b. Behavioural playbooks (stable per-profile) — how the user typically
  // handles recurring situations. Distilled, not-yet-promoted entries only;
  // promoted ones already live as accepted Skills. Stays in `sections` so it
  // sits inside the cached prefix.
  const playbooksSection = formatPlaybooks(input.playbooks ?? [], maxPlaybooks)
  if (playbooksSection) {
    sections.push(["## How you typically handle situations", playbooksSection].join("\n"))
  }

  const decisionsSection = formatDecisions(input.decisions ?? [], maxDecisions)
  if (decisionsSection) {
    sections.push(["## Decisions you have made", decisionsSection].join("\n"))
  }

  // 3. Retrieved knowledge (per-turn)
  const retrieved = formatRetrievedChunks(input.retrievedChunks)
  if (retrieved) {
    dynamicSections.push(
      [
        "## Relevant historical material",
        "Use these excerpts when they answer the user's question. Cite sources by their chunk number when you do. If they don't answer the question, say so honestly rather than guessing.",
        "",
        retrieved,
      ].join("\n")
    )
  }

  // 4. Style few-shot
  const styleSection = formatStyleSamples(input.styleSamples)
  if (styleSection) {
    dynamicSections.push(
      [
        "## Style examples",
        "Examples of the user's prior writing in similar contexts. Match the tone and structure; do not copy verbatim.",
        "",
        styleSection,
      ].join("\n")
    )
  }

  const SEP = "\n\n---\n\n"
  return {
    systemPrompt: [...sections, ...dynamicSections].join(SEP),
    cacheSegments: {
      stable: sections.join(SEP),
      dynamic: dynamicSections.join(SEP),
    },
    metadata: {
      twinName: input.twinName,
      retrievedChunkIds: input.retrievedChunks.map((r) => r.chunk.id),
      styleSampleIds: input.styleSamples.map((s) => s.id),
    },
  }
}
