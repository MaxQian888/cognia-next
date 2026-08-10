/**
 * Reasoning-effort virtual models (W3.3, borrowed from newapi's reasoning
 * suffix).
 *
 * A virtual model id of the form `<base>-<effort>` — e.g. `gpt-5-high`,
 * `o3-low`, `claude-opus-thinking-max` — selects a concrete base model plus a
 * reasoning-effort tier. This module is the single parser; the model-pricing
 * resolver falls through it so a virtual id inherits its base model's pricing
 * (which the user can still override independently via custom model metadata,
 * exactly like any other model id).
 *
 * The effort token must be the FINAL hyphen segment and an exact tier name, so
 * ordinary ids (`gpt-5`, `claude-3-5-sonnet`, `llama-3.3-70b`) are never
 * misread as carrying an effort suffix.
 */
/** Reasoning-effort tiers, mirroring the app's `effort` union. */
type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
interface ParsedReasoningModel {
  /** The concrete model id the virtual id maps onto. */
  baseModel: string
  /** The requested effort tier. */
  effort: ReasoningEffort
}
/**
 * Parse a reasoning-effort virtual model id into `{ baseModel, effort }`, or
 * `null` when the id carries no recognised effort suffix (an ordinary id).
 */
declare function parseReasoningSuffix(modelId: string): ParsedReasoningModel | null
/** The effort tier a (possibly virtual) model id requests, or `null`. */
declare function effortForModel(modelId: string): ReasoningEffort | null
/** The concrete base model a (possibly virtual) model id resolves to. */
declare function baseModelId(modelId: string): string

export {
  type ParsedReasoningModel,
  type ReasoningEffort,
  baseModelId,
  effortForModel,
  parseReasoningSuffix,
}
