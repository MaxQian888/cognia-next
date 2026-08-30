/**
 * A versioned, immutable evaluator definition.
 *
 * Runs reference a `versionId`, never a bare evaluator id. That is what makes
 * "this score came from that rule" answerable months later: editing an
 * evaluator mints a new version rather than silently changing what every
 * historical score meant. `configDigest` is the proof — same version, same
 * config, same verdict.
 *
 * `built-in` deliberately points at the existing {@link SCORER_CATALOG} rather
 * than re-implementing those 18 scorers behind a second interface.
 */

import type { EvalDimension } from "./domain/eval"
import type { GradingSpec } from "./domain/grading"
import { ALL_SCORER_IDS } from "./scorers/catalog"

export const EVALUATOR_SCHEMA = "cognia-evaluator/v1" as const

export type EvaluatorKind = "built-in" | "rule" | "llm-rubric"

/** Wraps one catalog scorer. `scorerId` must be a real catalog entry. */
export interface BuiltInEvaluatorConfig {
  kind: "built-in"
  scorerId: string
}

/**
 * Deterministic rules. The first six modes delegate to the existing match
 * scorers via {@link GradingSpec}; `json-pointer`, `tool-args`, `tool-order`,
 * and `cost-budget` name the other deterministic checks the catalog already
 * implements. Only `json-pointer` has no catalog equivalent today.
 */
export type RuleEvaluatorMode =
  | "exact"
  | "contains-any"
  | "regex"
  | "numeric"
  | "choice"
  | "json-pointer"
  | "tool-args"
  | "tool-order"
  | "cost-budget"

export interface RuleEvaluatorConfig {
  kind: "rule"
  mode: RuleEvaluatorMode
  /** How the answer is compared, for the modes that delegate to match scorers. */
  grading?: GradingSpec
  /** `json-pointer`: RFC 6901 pointer into the structured answer. */
  pointer?: string
  /** `json-pointer`: the value the pointer must resolve to. */
  expected?: unknown
  /** `cost-budget`: the USD ceiling that turns cost from measurement into a gate. */
  maxCostUsd?: number
}

export interface LlmRubricEvaluatorConfig {
  kind: "llm-rubric"
  criterion: string
  rubric: string
  labels?: string[]
  /** Verdict threshold in [0,1]. */
  threshold?: number
  judge: { providerId?: string; modelId?: string; temperature?: number }
  /** Digest over the rendered prompt, so a prompt edit cannot pass as the same version. */
  promptDigest: string
  /**
   * The calibration that justified trusting this judge. Absent means the judge
   * is uncalibrated — callers decide whether that may gate, per ADR-0101's
   * κ ≥ 0.6 / accuracy ≥ 0.8 bar.
   */
  calibrationRef?: { runId: string; kappa: number; accuracy: number }
}

export type EvaluatorConfig =
  BuiltInEvaluatorConfig | RuleEvaluatorConfig | LlmRubricEvaluatorConfig

export interface EvaluatorSpecV1 {
  schema: typeof EVALUATOR_SCHEMA
  id: string
  /** Immutable. Editing an evaluator mints a new one. */
  versionId: string
  kind: EvaluatorKind
  dimension: EvalDimension
  /** Whether this evaluator's verdict can decide pass/fail. Mirrors `Scorer.gating`. */
  gating: boolean
  /** SHA-256 over {@link normalizeEvaluatorConfig}. */
  configDigest: string
  config: EvaluatorConfig
  createdAt: number
}

/**
 * Key-sorted JSON so two configs that differ only in property order digest
 * identically. Without this an evaluator "changes" every time an editor
 * reserializes it, and every historical score looks stale.
 */
export function normalizeEvaluatorConfig(config: EvaluatorConfig): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort)
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => [key, sort((value as Record<string, unknown>)[key])])
      )
    }
    return value
  }
  return JSON.stringify(sort(config))
}

/** SHA-256 of the normalized config, prefixed like every other digest here. */
export async function evaluatorConfigDigest(config: EvaluatorConfig): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeEvaluatorConfig(config))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
  return `sha256:${hex}`
}

/**
 * Structural problems, as messages. Empty means usable.
 *
 * Deliberately NOT a boolean: "invalid" without a reason is what makes a
 * rejected evaluator impossible to fix from the UI.
 */
export function validateEvaluatorSpec(spec: EvaluatorSpecV1): string[] {
  const problems: string[] = []
  if (spec.schema !== EVALUATOR_SCHEMA) problems.push(`unknown schema "${spec.schema}"`)
  if (!spec.id.trim()) problems.push("id is required")
  if (!spec.versionId.trim()) problems.push("versionId is required")
  if (!spec.configDigest.startsWith("sha256:"))
    problems.push("configDigest must be a sha256 digest")
  if (spec.kind !== spec.config.kind) {
    problems.push(`kind "${spec.kind}" does not match config kind "${spec.config.kind}"`)
  }
  switch (spec.config.kind) {
    case "built-in":
      if (!ALL_SCORER_IDS.includes(spec.config.scorerId)) {
        problems.push(`unknown built-in scorer "${spec.config.scorerId}"`)
      }
      break
    case "rule":
      if (spec.config.mode === "json-pointer" && !spec.config.pointer?.startsWith("/")) {
        problems.push("json-pointer rules need an RFC 6901 pointer starting with /")
      }
      if (spec.config.mode === "cost-budget" && !(Number(spec.config.maxCostUsd) > 0)) {
        problems.push("cost-budget rules need a positive maxCostUsd")
      }
      if (spec.config.mode === "regex" && !spec.config.grading?.pattern) {
        problems.push("regex rules need a grading pattern")
      }
      break
    case "llm-rubric":
      if (!spec.config.criterion.trim()) problems.push("llm-rubric needs a criterion")
      if (!spec.config.rubric.trim()) problems.push("llm-rubric needs a rubric")
      if (!spec.config.promptDigest.startsWith("sha256:")) {
        problems.push("llm-rubric needs a sha256 promptDigest")
      }
      if (spec.config.threshold !== undefined) {
        const threshold = spec.config.threshold
        if (!(threshold >= 0 && threshold <= 1)) problems.push("threshold must be within [0,1]")
      }
      break
  }
  return problems
}

/** True when an `llm-rubric` evaluator meets ADR-0101's calibration bar. */
export function isCalibratedJudge(spec: EvaluatorSpecV1): boolean {
  if (spec.config.kind !== "llm-rubric") return true
  const reference = spec.config.calibrationRef
  if (!reference) return false
  return reference.kappa >= 0.6 && reference.accuracy >= 0.8
}
