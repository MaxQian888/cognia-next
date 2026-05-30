/**
 * Ultracode orchestration — type + Zod schema surface.
 *
 * Ports Claude Code's "ultracode" multi-agent quality patterns onto the
 * Agent Team subsystem (ADR-0022). The patterns (adversarial verify, judge
 * panel, loop-until-dry, multi-modal sweep, completeness critic, synthesize)
 * run as higher-order workflow nodes; each fans out tool-enabled teammate
 * dispatches and exchanges structured data validated by the schemas below.
 *
 * Every schema here is consumed by `structured-dispatch.ts` (which instructs a
 * teammate to emit a fenced JSON block, parses it, and validates with the
 * matching schema, retrying once). Keeping the schemas next to the param types
 * means the synthesizer, the pattern executors, and the structured-dispatch
 * helper all agree on one shape.
 */

import { z } from "zod"

// ─────────────────────────────────────────────────────────────────────────────
// Verification lenses (perspective-diverse verify)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The distinct angles a skeptic verifier can take. `repro` is the only lens
 * that benefits from tool execution (actually reproducing a finding); the
 * others are pure reasoning over the finding text + cited context.
 */
export const VERIFIER_LENSES = ["correctness", "security", "perf", "repro"] as const
export type VerifierLens = (typeof VERIFIER_LENSES)[number]

/** Lenses that require a tool-enabled teammate (Read/Bash) to be meaningful. */
export const TOOL_REQUIRING_LENSES: ReadonlySet<VerifierLens> = new Set<VerifierLens>(["repro"])

// ─────────────────────────────────────────────────────────────────────────────
// Findings — produced by finders / sweeps / loop-until-dry
// ─────────────────────────────────────────────────────────────────────────────

export const findingSeveritySchema = z.enum(["low", "medium", "high", "critical"])
export type FindingSeverity = z.infer<typeof findingSeveritySchema>

export const findingSchema = z.object({
  /** Stable id; the pattern node assigns one when the model omits it. */
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  detail: z.string().min(1),
  /** Optional `file:line` / area pointer used for dedup + citations. */
  location: z.string().optional(),
  severity: findingSeveritySchema.optional(),
})
export type Finding = z.infer<typeof findingSchema>

/** What a finder/sweep teammate returns. */
export const findingsResultSchema = z.object({
  findings: z.array(findingSchema),
})
export type FindingsResult = z.infer<typeof findingsResultSchema>

/**
 * Canonical dedup key for a finding: prefers an explicit location, falls back
 * to a normalized title. Shared by loop-until-dry (all-seen set) and the
 * verify aggregator so a finding is never double-counted across rounds.
 */
export function findingKey(f: Finding): string {
  const loc = f.location?.trim().toLowerCase()
  if (loc) return `loc:${loc}`
  return `title:${f.title.trim().toLowerCase().replace(/\s+/g, " ")}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdicts — produced by adversarial skeptics
// ─────────────────────────────────────────────────────────────────────────────

export const verdictSchema = z.object({
  /** true = the skeptic believes the finding is real after trying to refute it. */
  real: z.boolean(),
  reasoning: z.string().min(1),
  lens: z.enum(VERIFIER_LENSES).optional(),
})
export type Verdict = z.infer<typeof verdictSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Judge panel — attempts + scores
// ─────────────────────────────────────────────────────────────────────────────

export const attemptSchema = z.object({
  angle: z.string().min(1),
  content: z.string().min(1),
})
export type Attempt = z.infer<typeof attemptSchema>

export const judgeScoreSchema = z.object({
  /** 0–10 quality score. */
  score: z.number().min(0).max(10),
  rationale: z.string().min(1),
})
export type JudgeScore = z.infer<typeof judgeScoreSchema>

/**
 * Minimal shape of a judge-panel winner, as consumed by `pattern.synthesize`
 * from the upstream output map (the full `RankedAttempt` lives in the
 * judge-panel executor).
 */
export interface RankedAttemptLike {
  attempt: Attempt
  avgScore: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Completeness critic — gaps
// ─────────────────────────────────────────────────────────────────────────────

export const critiqueGapSchema = z.object({
  description: z.string().min(1),
  /** Optional concrete next search/angle the next finder round should run. */
  suggestedSearch: z.string().optional(),
})
export type CritiqueGap = z.infer<typeof critiqueGapSchema>

export const critiqueResultSchema = z.object({
  gaps: z.array(critiqueGapSchema),
})
export type CritiqueResult = z.infer<typeof critiqueResultSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Synthesis — final cited report
// ─────────────────────────────────────────────────────────────────────────────

export const synthesisReportSchema = z.object({
  report: z.string().min(1),
  citations: z.array(z.string().min(1)).optional(),
})
export type SynthesisReport = z.infer<typeof synthesisReportSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Pattern node param shapes (encoded into the synthesized VisualWorkflow)
// ─────────────────────────────────────────────────────────────────────────────

export interface PatternParamsBase {
  teamId: string
  /** The task / goal text every pattern agent is working toward. */
  objective: string
}

export interface MultiModalSweepParams extends PatternParamsBase {
  /** Each entry is a distinct search instruction run by one finder in parallel. */
  modalities: string[]
}

export interface LoopUntilDryParams extends PatternParamsBase {
  /** Instruction handed to each finder round. */
  finderPrompt: string
  /** Stop after this many consecutive rounds add nothing new. */
  dryRoundsToStop: number
  /** Hard cap on rounds (no-silent-caps: the node logs when it hits this). */
  maxRounds: number
  /** Finders to run in parallel per round. Default 1. */
  findersPerRound?: number
}

export interface AdversarialVerifyParams extends PatternParamsBase {
  /** Independent skeptics per finding. Majority-refute kills the finding. */
  skepticsPerFinding: number
  /**
   * When set, each skeptic gets a distinct lens (perspective-diverse verify);
   * the `repro` lens runs tool-enabled. When omitted, all skeptics use the
   * same refute prompt.
   */
  lenses?: VerifierLens[]
}

export interface JudgePanelParams extends PatternParamsBase {
  /** Each angle produces one independent attempt. */
  angles: string[]
  /** Independent judges scoring every attempt. */
  judgesPerAttempt: number
}

export type CompletenessCriticParams = PatternParamsBase

export type SynthesizeParams = PatternParamsBase

// ─────────────────────────────────────────────────────────────────────────────
// Ultracode plan — what the lead-planning step produces
// ─────────────────────────────────────────────────────────────────────────────

/** The pattern kinds the planner may compose, in their canonical phase order. */
export const ULTRACODE_PATTERN_KINDS = [
  "multi-modal-sweep",
  "loop-until-dry",
  "adversarial-verify",
  "judge-panel",
  "completeness-critic",
  "synthesize",
] as const
export type UltracodePatternKind = (typeof ULTRACODE_PATTERN_KINDS)[number]

/**
 * One stage in the planned ultracode workflow. The synthesizer turns this list
 * into `pattern.*` nodes wired find → verify → synthesize.
 */
export const ultracodeStageSchema = z.object({
  pattern: z.enum(ULTRACODE_PATTERN_KINDS),
  /** Free-text instruction specialising this stage to the task. */
  instruction: z.string().min(1),
  /** Per-stage knob; interpreted per pattern (finders, skeptics, judges…). */
  count: z.number().int().min(1).max(16).optional(),
  /** Distinct modalities / angles / lenses for sweep / judge / verify stages. */
  variants: z.array(z.string().min(1)).optional(),
})
export type UltracodeStage = z.infer<typeof ultracodeStageSchema>

export const ultracodePlanSchema = z.object({
  /** Human-readable one-line summary of the orchestration approach. */
  summary: z.string().min(1),
  stages: z.array(ultracodeStageSchema).min(1),
})
export type UltracodePlan = z.infer<typeof ultracodePlanSchema>
