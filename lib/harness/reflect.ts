/**
 * Harnessing-level reflection (ADR-0237).
 *
 * After a run's decision, the reflector reads the base rollouts, every
 * candidate's diff and rollout, and the decision, and returns:
 *
 * - an attribution row per edit (Harness²'s edits table: helped, hurt, no
 *   observed effect, confounded);
 * - a verdict for each lesson the editors were given from the library, which
 *   is how retrieved experiences gain or lose standing;
 * - at most one new lesson.
 *
 * Parsing is strict and deterministic on top of the model: a lesson with no
 * edit that observably helped or hurt is dropped (the run did not separate an
 * effect, so there is nothing to learn), and every stored string is redacted
 * and capped, because lessons are served to later editors.
 */

import type {
  HarnessEvolutionTask,
  HarnessExecutionEvidence,
  HarnessRunDecision,
  HarnessStageDimension,
} from "@/types/harness/evolution"
import {
  HARNESS_EDIT_VERDICTS,
  type HarnessEditAttribution,
  type HarnessEditVerdict,
  type HarnessExperience,
  type HarnessExperienceConfidence,
} from "@/types/harness/experience"
import type { HarnessComponentName } from "@/types/harness/snapshot"
import { HARNESS_COMPONENT_NAMES } from "@/types/harness/snapshot"
import { extractEmbeddedJsonObject } from "./checks"
import { redactEvidenceText, renderRolloutMarkdown } from "./evidence"
import { componentOfPath } from "./tree"

/** Characters of evidence the reflector is given. */
export const REFLECTOR_MAX_CHARS = 160_000
/** Cap on any one stored reflection string. */
export const REFLECTION_FIELD_MAX_CHARS = 2_000
const MAX_EDIT_ROWS = 40
const MAX_LIST_ITEMS = 8

export interface ReflectionCandidate {
  label: string
  dim?: HarnessStageDimension
  round?: number
  notes: string
  /** Unified diff of this candidate against the base harness. */
  diff: string
  /** The candidate's rollout, when it was rolled. */
  evidence?: HarnessExecutionEvidence
  keptBase?: boolean
  fellBack?: boolean
}

export interface ReflectionInput {
  task: HarnessEvolutionTask
  base: readonly { label: string; evidence: HarnessExecutionEvidence }[]
  candidates: readonly ReflectionCandidate[]
  decision: HarnessRunDecision
  /** Lessons the editors were given. */
  retrieved: readonly HarnessExperience[]
  maxChars?: number
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.7)
  return `${text.slice(0, head)}\n…[${text.length - max} chars omitted]…\n${text.slice(text.length - (max - head))}`
}

export function reflectorUserPrompt(input: ReflectionInput): string {
  const maxChars = input.maxChars ?? REFLECTOR_MAX_CHARS
  const items = input.base.length + input.candidates.length
  const perItem = Math.max(2_000, Math.floor((maxChars * 0.85) / Math.max(1, items)))
  const lines: string[] = [
    "## Task",
    "",
    redactEvidenceText(input.task.title),
    "",
    redactEvidenceText(input.task.prompt),
    "",
    "## Decision",
    "",
    `- outcome: ${input.decision.outcome}${input.decision.chosenLabel ? ` (${input.decision.chosenLabel})` : ""}`,
    `- reason: ${input.decision.reason}`,
    "",
    "## Base rollouts",
  ]
  for (const b of input.base) {
    lines.push("", cap(renderRolloutMarkdown(b.label, b.evidence), perItem))
  }
  lines.push("", "## Candidates")
  for (const c of input.candidates) {
    const head = [
      `### ${c.label}${c.dim ? ` (${c.dim}${c.round ? `, round ${c.round}` : ""})` : ""}`,
      c.fellBack
        ? "The editor's proposal was invalid twice; this stage kept its input."
        : c.keptBase
          ? "The editor kept its input unchanged."
          : "",
      "",
      "Editor notes:",
      c.notes || "(none)",
      "",
      "Diff against the base harness:",
      c.diff || "(no change)",
    ]
    const rollout = c.evidence
      ? ["", renderRolloutMarkdown(c.label, c.evidence)]
      : ["", "(this candidate was not rolled)"]
    lines.push("", cap([...head, ...rollout].join("\n"), perItem))
  }
  if (input.retrieved.length) {
    lines.push("", "## Lessons the editors were given", "")
    for (const e of input.retrieved) {
      lines.push(`- ${e.id}: when ${e.problemPattern} → ${e.lesson}`)
    }
  }
  return cap(lines.join("\n"), maxChars)
}

export interface ProposedExperience {
  cue: string
  lesson: string
  evidence: string
  confidence: HarnessExperienceConfidence
  appliesWhen: string[]
  notWhen: string[]
  tags: string[]
}

export interface RetrievedVerdict {
  id: string
  verdict: Extract<HarnessEditVerdict, "helped" | "hurt" | "no observed effect">
}

export interface ParsedReflection {
  edits: HarnessEditAttribution[]
  retrieved: RetrievedVerdict[]
  experience: ProposedExperience | null
  /** Why a lesson the model offered was not kept. */
  droppedExperience?: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function text(v: unknown, max = REFLECTION_FIELD_MAX_CHARS): string {
  return typeof v === "string" ? redactEvidenceText(v.trim()).slice(0, max) : ""
}

function list(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => text(x, 300))
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS)
}

/** Components an attribution row names, by path or by component name. */
export function componentsOfEdit(component: string): HarnessComponentName[] {
  const byPath = componentOfPath(component.replace(/^harness\//, ""))
  if (byPath) return [byPath]
  const lower = component.toLowerCase()
  return HARNESS_COMPONENT_NAMES.filter((name) => lower.includes(name.toLowerCase()))
}

/** Read the reflector's JSON answer. `null` when it is not a usable reflection at all. */
export function parseReflection(
  answer: string,
  known: { labels: readonly string[]; retrievedIds: readonly string[] }
): ParsedReflection | null {
  const value = extractEmbeddedJsonObject(answer)
  if (!isRecord(value)) return null
  const labels = new Set(known.labels)
  const edits: HarnessEditAttribution[] = []
  for (const raw of Array.isArray(value.edits) ? value.edits.slice(0, MAX_EDIT_ROWS) : []) {
    if (!isRecord(raw)) continue
    const verdict = raw.verdict
    if (!HARNESS_EDIT_VERDICTS.includes(verdict as HarnessEditVerdict)) continue
    const component = text(raw.component, 200)
    if (!component) continue
    edits.push({
      component,
      candidates: Array.isArray(raw.candidates)
        ? raw.candidates.filter((c): c is string => typeof c === "string" && labels.has(c))
        : [],
      change: text(raw.change),
      observed: text(raw.observed),
      verdict: verdict as HarnessEditVerdict,
    })
  }
  const retrievedIds = new Set(known.retrievedIds)
  const retrieved: RetrievedVerdict[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(value.retrieved) ? value.retrieved : []) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !retrievedIds.has(raw.id)) continue
    if (seen.has(raw.id)) continue
    if (raw.verdict !== "helped" && raw.verdict !== "hurt" && raw.verdict !== "no observed effect")
      continue
    seen.add(raw.id)
    retrieved.push({ id: raw.id, verdict: raw.verdict })
  }

  let experience: ProposedExperience | null = null
  let droppedExperience: string | undefined
  if (isRecord(value.experience)) {
    const e = value.experience
    const proposed: ProposedExperience = {
      cue: text(e.cue),
      lesson: text(e.lesson),
      evidence: text(e.evidence),
      confidence: e.confidence === "high" || e.confidence === "medium" ? e.confidence : "low",
      appliesWhen: list(e.applies_when),
      notWhen: list(e.not_when),
      tags: list(e.tags).map((t) => t.toLowerCase()),
    }
    if (!proposed.cue || !proposed.lesson || !proposed.evidence) {
      droppedExperience = "The lesson was missing its situation, operation or evidence."
    } else if (!edits.some((row) => row.verdict === "helped" || row.verdict === "hurt")) {
      droppedExperience =
        "No edit had an observable effect in this run, so the lesson rests on nothing it can show."
    } else {
      experience = proposed
    }
  }
  return { edits, retrieved, experience, ...(droppedExperience ? { droppedExperience } : {}) }
}
