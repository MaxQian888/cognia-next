/**
 * Prompt Center definitions for the ultracode quality patterns (ADR-0236).
 *
 * The pattern modules register their node executors when imported, so their
 * prompts live here, in a leaf, where the catalog can list them without that
 * side effect. Each pattern resolves its own definitions (see `consumers`).
 *
 * Two families:
 *  - **Instruction wording** (finder, attempt, judge, skeptic, lens, critic,
 *    report) is editable. Live values (objective, finding, attempt) arrive
 *    through placeholders; conditional blocks stay in the pattern and reach
 *    the body pre-rendered.
 *  - **Schema hints** are inspect-only protocol: `dispatchStructured` appends
 *    them under `Schema:` and the reply is validated against the matching Zod
 *    schema, so their keys are not editable.
 *
 * A pattern step resolves against one snapshot it froze when it started
 * ({@link freezePatternPromptScope}), so every fan-out job of the step reads
 * the same revision set.
 */

import { loadPromptOverrideSnapshot, type PromptOverrideSnapshot } from "@/lib/prompts/snapshot"
import {
  definePrompt,
  type PromptDefinitionInput,
  type PromptDefinitionV1,
  type PromptResolutionContext,
} from "@/lib/prompts/types"
import type { VerifierLens } from "@/types/agent/ultracode"
import type { TeamRunContext } from "../team-run-context"
import { teamPromptContext } from "../team-prompts"

/** Live values are clipped to this; far above any objective, finding or attempt. */
const LIVE_VALUE_MAX = 200_000

/** What one pattern step resolves against: the team's project and a frozen snapshot. */
export interface PatternPromptScope {
  context: PromptResolutionContext
  snapshot: PromptOverrideSnapshot | null
}

/** Freeze the override snapshot for one pattern step. */
export async function freezePatternPromptScope(
  teamCtx: Pick<TeamRunContext, "team">
): Promise<PatternPromptScope> {
  return {
    context: teamPromptContext(teamCtx.team),
    snapshot: await loadPromptOverrideSnapshot().catch(() => null),
  }
}

type PatternWordingInput = Pick<
  PromptDefinitionInput,
  "id" | "outputContract" | "consumers" | "defaultBody"
> & { variables?: Array<{ name: string; required: boolean }>; maxChars?: number }

/** An editable pattern instruction: account + project scopes, live values bounded. */
function patternWording(input: PatternWordingInput): PromptDefinitionV1 {
  return definePrompt({
    id: input.id,
    contractVersion: 1,
    kind: "feature-template",
    group: "team",
    operation: "replace-template",
    scopes: ["account", "workspace"],
    activation: "next-operation",
    // The JSON contract is the separate inspect-only schema hint, so an edit
    // here changes what the teammate looks for, never what the parser reads.
    risk: "ordinary",
    hosts: ["app", "cli"],
    maxChars: input.maxChars ?? 8_000,
    variables: (input.variables ?? []).map((v) => ({ ...v, maxChars: LIVE_VALUE_MAX })),
    ...(input.outputContract ? { outputContract: input.outputContract } : {}),
    consumers: input.consumers,
    defaultBody: input.defaultBody,
  })
}

/** An inspect-only schema hint appended by `dispatchStructured`. */
function patternSchemaHint(input: {
  id: string
  consumers: readonly string[]
  defaultBody: string
  outputContract: string
}): PromptDefinitionV1 {
  return definePrompt({
    id: input.id,
    contractVersion: 1,
    kind: "protocol",
    group: "team",
    operation: "inspect-only",
    scopes: [],
    activation: "next-operation",
    risk: "protocol",
    hosts: ["app", "cli"],
    outputContract: input.outputContract,
    consumers: input.consumers,
    defaultBody: input.defaultBody,
  })
}

const SWEEP = "lib/ai/agent/team/patterns/multi-modal-sweep.ts"
const LOOP = "lib/ai/agent/team/patterns/loop-until-dry.ts"
const JUDGE = "lib/ai/agent/team/patterns/judge-panel.ts"
const VERIFY = "lib/ai/agent/team/patterns/adversarial-verify.ts"
const CRITIC = "lib/ai/agent/team/patterns/completeness-critic.ts"
const SYNTH = "lib/ai/agent/team/patterns/synthesize.ts"

// ── Shared ────────────────────────────────────────────────────────────────

/** The findings shape both finder patterns return. */
export const FINDINGS_SCHEMA_HINT_PROMPT = patternSchemaHint({
  id: "team.pattern.shared.findings-schema",
  consumers: [SWEEP, LOOP],
  outputContract: "Validated as a findings list; findings are deduped and fed to verification.",
  defaultBody: '{ "findings": [{ "title", "detail", "location"?, "severity"? }] }',
})

// ── multi-modal-sweep ─────────────────────────────────────────────────────

export const SWEEP_FINDER_PROMPT = patternWording({
  id: "team.pattern.multi-modal-sweep.finder",
  consumers: [SWEEP],
  variables: [
    { name: "objective", required: true },
    { name: "modality", required: true },
  ],
  outputContract:
    "One finder per search approach; each returns findings for its approach only, then all are deduped.",
  defaultBody:
    "Objective: {{objective}}\n\nSearch approach: {{modality}}\n\n" +
    "Find concrete, specific findings using ONLY this approach. " +
    "Each finding needs a title, a detailed explanation, and — when you can pin it — a file:line or area location.",
})

// ── loop-until-dry ────────────────────────────────────────────────────────

export const LOOP_FINDER_PROMPT = patternWording({
  id: "team.pattern.loop-until-dry.finder",
  consumers: [LOOP],
  variables: [
    { name: "objective", required: true },
    { name: "finderPrompt", required: true },
    { name: "knownSummary", required: true },
  ],
  outputContract:
    "Rounds repeat until consecutive rounds return nothing new. {{finderPrompt}} is the step's own finder instruction; {{knownSummary}} lists what earlier rounds found.",
  defaultBody:
    "Objective: {{objective}}\n\n{{finderPrompt}}\n\n{{knownSummary}}\n\n" +
    "Return ONLY findings not already listed above. If you find nothing new, return an empty findings array.",
})

// ── judge-panel ───────────────────────────────────────────────────────────

export const JUDGE_ATTEMPT_PROMPT = patternWording({
  id: "team.pattern.judge-panel.attempt",
  consumers: [JUDGE],
  variables: [
    { name: "objective", required: true },
    { name: "angle", required: true },
  ],
  outputContract: "One attempt per angle; every attempt is then scored by the judges.",
  defaultBody:
    "Objective: {{objective}}\n\nApproach this from the angle: {{angle}}\n\n" +
    "Produce your best concrete attempt at the objective from THIS angle only.",
})

export const JUDGE_SCORE_PROMPT = patternWording({
  id: "team.pattern.judge-panel.judge",
  consumers: [JUDGE],
  variables: [
    { name: "objective", required: true },
    { name: "angle", required: false },
    { name: "content", required: true },
  ],
  outputContract: "Each judge scores one attempt 0–10; the attempt with the best average wins.",
  defaultBody:
    "Objective: {{objective}}\n\nScore this attempt (0–10) on how well it meets the objective. " +
    "Be a demanding, independent judge.\n\nAttempt (angle: {{angle}}):\n{{content}}",
})

export const JUDGE_ATTEMPT_SCHEMA_HINT_PROMPT = patternSchemaHint({
  id: "team.pattern.judge-panel.attempt-schema",
  consumers: [JUDGE],
  outputContract: "Validated as one attempt.",
  defaultBody: '{ "angle": "…", "content": "…" }',
})

export const JUDGE_SCORE_SCHEMA_HINT_PROMPT = patternSchemaHint({
  id: "team.pattern.judge-panel.score-schema",
  consumers: [JUDGE],
  outputContract: "Validated as one judge score.",
  defaultBody: '{ "score": 0-10, "rationale": "…" }',
})

// ── adversarial-verify ────────────────────────────────────────────────────

export const VERIFY_SKEPTIC_PROMPT = patternWording({
  id: "team.pattern.adversarial-verify.skeptic",
  consumers: [VERIFY],
  variables: [
    { name: "objectiveBlock", required: false },
    { name: "finding", required: true },
    { name: "lensNote", required: false },
  ],
  outputContract:
    "Each skeptic votes real or not; a finding survives only with more confirmations than refutals. {{objectiveBlock}} is empty or an objective line plus a blank line; {{lensNote}} is empty or the skeptic's verification lens.",
  defaultBody:
    "{{objectiveBlock}}" +
    "Try to REFUTE this finding. Default to real=false if you are not convinced.\n\n" +
    "Finding:\n{{finding}}{{lensNote}}",
})

/** Per-lens guidance a perspective-diverse skeptic is given. */
export const VERIFY_LENS_PROMPTS: Record<VerifierLens, PromptDefinitionV1> = {
  correctness: patternWording({
    id: "team.pattern.adversarial-verify.lens-correctness",
    consumers: [VERIFY],
    maxChars: 2_000,
    outputContract: "Appended to a correctness-lens skeptic's prompt.",
    defaultBody:
      "Does the finding describe a real logic / behavior defect? Check the claim against how the code actually executes.",
  }),
  security: patternWording({
    id: "team.pattern.adversarial-verify.lens-security",
    consumers: [VERIFY],
    maxChars: 2_000,
    outputContract: "Appended to a security-lens skeptic's prompt.",
    defaultBody:
      "Is this an exploitable security issue? Consider the threat model and whether an attacker can actually trigger it.",
  }),
  perf: patternWording({
    id: "team.pattern.adversarial-verify.lens-perf",
    consumers: [VERIFY],
    maxChars: 2_000,
    outputContract: "Appended to a performance-lens skeptic's prompt.",
    defaultBody:
      "Is the performance impact real and material at realistic scale? Estimate the cost; dismiss micro-claims.",
  }),
  repro: patternWording({
    id: "team.pattern.adversarial-verify.lens-repro",
    consumers: [VERIFY],
    maxChars: 2_000,
    outputContract: "Appended to a reproduction-lens skeptic's prompt.",
    defaultBody:
      "Try to actually reproduce it — read the cited code / run the relevant check. If you cannot reproduce it, it is not real.",
  }),
}

export const VERIFY_VERDICT_SCHEMA_HINT_PROMPT = patternSchemaHint({
  id: "team.pattern.adversarial-verify.verdict-schema",
  consumers: [VERIFY],
  outputContract: "Validated as one skeptic verdict.",
  defaultBody: '{ "real": boolean, "reasoning": "…", "lens"?: "correctness|security|perf|repro" }',
})

// ── completeness-critic ───────────────────────────────────────────────────

export const CRITIC_PROMPT = patternWording({
  id: "team.pattern.completeness-critic.critic",
  consumers: [CRITIC],
  variables: [
    { name: "objective", required: true },
    { name: "findings", required: true },
  ],
  outputContract: "The gaps it names feed the next finder round and the final report.",
  defaultBody:
    "Objective: {{objective}}\n\n" +
    "The work so far produced these findings:\n{{findings}}\n\n" +
    "Acting as a completeness critic, identify what is MISSING — a search angle never run, " +
    "a claim left unverified, a region or source not yet examined. For each gap, optionally " +
    "suggest the concrete next search that would close it. Return an empty list only if you are " +
    "confident the coverage is exhaustive.",
})

export const CRITIC_GAPS_SCHEMA_HINT_PROMPT = patternSchemaHint({
  id: "team.pattern.completeness-critic.gaps-schema",
  consumers: [CRITIC],
  outputContract: "Validated as a gaps list.",
  defaultBody: '{ "gaps": [{ "description": "…", "suggestedSearch"?: "…" }] }',
})

// ── synthesize ────────────────────────────────────────────────────────────

export const SYNTHESIZE_REPORT_PROMPT = patternWording({
  id: "team.pattern.synthesize.report",
  consumers: [SYNTH],
  variables: [
    { name: "objective", required: true },
    { name: "findingsBlock", required: true },
    { name: "winnerBlock", required: false },
    { name: "gapsBlock", required: false },
  ],
  outputContract:
    "The report becomes the run's final result and is posted to the team chat. {{findingsBlock}} lists the verified findings; {{winnerBlock}} and {{gapsBlock}} are empty or start with a blank line.",
  defaultBody:
    "Objective: {{objective}}\n\n{{findingsBlock}}{{winnerBlock}}{{gapsBlock}}\n\n" +
    "Write the final report for the objective. Ground every claim in the verified findings / winning " +
    "approach above; cite locations (file:line or area) where available; and explicitly note the open " +
    "gaps as limitations. Be concrete and well-structured.",
})

export const SYNTHESIZE_REPORT_SCHEMA_HINT_PROMPT = patternSchemaHint({
  id: "team.pattern.synthesize.report-schema",
  consumers: [SYNTH],
  outputContract: "Validated as the final report with optional citations.",
  defaultBody: '{ "report": "markdown…", "citations"?: ["file:line", …] }',
})

/** Every pattern definition, for the catalog. */
export const PATTERN_PROMPTS = [
  FINDINGS_SCHEMA_HINT_PROMPT,
  SWEEP_FINDER_PROMPT,
  LOOP_FINDER_PROMPT,
  JUDGE_ATTEMPT_PROMPT,
  JUDGE_SCORE_PROMPT,
  JUDGE_ATTEMPT_SCHEMA_HINT_PROMPT,
  JUDGE_SCORE_SCHEMA_HINT_PROMPT,
  VERIFY_SKEPTIC_PROMPT,
  ...Object.values(VERIFY_LENS_PROMPTS),
  VERIFY_VERDICT_SCHEMA_HINT_PROMPT,
  CRITIC_PROMPT,
  CRITIC_GAPS_SCHEMA_HINT_PROMPT,
  SYNTHESIZE_REPORT_PROMPT,
  SYNTHESIZE_REPORT_SCHEMA_HINT_PROMPT,
] as const
