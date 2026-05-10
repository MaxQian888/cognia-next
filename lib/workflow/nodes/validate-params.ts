/**
 * Convert a node's `params` into a stable, UI-friendly validation result.
 *
 * Each field maps to a single i18n key (the *first* failure wins — the
 * inspector form shows one error message per field at a time). The summary
 * list is the flat error sentence you'd toast or list in a banner.
 */

import type { z, ZodError, ZodIssue } from "zod"
import { paramsSchemaFor } from "./params-schemas"
import type { WorkflowNodeKind } from "@/types/workflow/visual"

/**
 * Heuristic: a `message` string returned by a custom `.regex(_, key)`,
 * `.min(_, key)`, or `.refine(_, { message: key })` is treated as an i18n
 * key. Zod's default messages start with a capital letter and contain spaces
 * ("Too small", "Invalid input") — those are not keys.
 */
function looksLikeI18nKey(s: string | undefined): boolean {
  if (!s) return false
  return /^[a-z][A-Za-z0-9]*$/.test(s)
}

/**
 * Per-field failure. The `key` is an i18n message key under
 * `workflows.validation.*`. The `params` carries any interpolation values
 * (e.g., `{ min: 1 }`) the message needs.
 */
export interface FieldError {
  key: string
  params?: Record<string, string | number>
}

export interface NodeValidationResult {
  /** Per-field errors, keyed by the dotted JSON path (e.g., `"cron"`). */
  fields: Record<string, FieldError>
  /** Flat list, useful for toast / save-blocked banner. */
  summary: string[]
  /** Convenience flag — `true` iff `fields` has any entry. */
  hasErrors: boolean
}

/**
 * Map a zod error code + path to a stable i18n key. We never echo a raw
 * english string back; the inspector renders messages from i18n.
 */
function mapIssueToFieldError(issue: ZodIssue): FieldError {
  // First, compute structural params (min / max / expected) so an i18n-keyed
  // message can interpolate `{min}` / `{max}` even when zod's default text
  // would have included them inline.
  const params = extractIssueParams(issue)

  // 1. Trust an i18n-key-shaped message regardless of code. Schemas pass
  //    `"required" / "cronExpr" / "maxValue"` etc. as the message argument
  //    to .regex / .min / .refine — that key wins over heuristics below.
  if (looksLikeI18nKey(issue.message)) {
    return params ? { key: issue.message, params } : { key: issue.message }
  }
  // 2. zod 4: missing required field → `invalid_type` with `expected:
  //    "<type>"` and a message mentioning `"received undefined"` (the
  //    `received` property was removed in v4). Treat that as `required`.
  if (issue.code === "invalid_type") {
    if (typeof issue.message === "string" && issue.message.includes("received undefined")) {
      return { key: "required" }
    }
    const expected = (issue as ZodIssue & { expected?: string }).expected
    return { key: "invalidType", params: { expected: String(expected ?? "") } }
  }
  // 3. Numeric / string / array bounds.
  if (issue.code === "too_small") {
    const origin = (issue as ZodIssue & { origin?: string }).origin
    if (origin === "string") return { key: "required" }
    if (origin === "array") return { key: "minItems", params: params ?? {} }
    return { key: "minValue", params: params ?? {} }
  }
  if (issue.code === "too_big") {
    return { key: "maxValue", params: params ?? {} }
  }
  if (issue.code === "invalid_format") {
    return { key: "invalidFormat" }
  }
  return { key: "invalid" }
}

/** Pull `{ min }` / `{ max }` / `{ expected }` interpolation params off an issue. */
function extractIssueParams(issue: ZodIssue): Record<string, string | number> | undefined {
  const out: Record<string, string | number> = {}
  const min = (issue as ZodIssue & { minimum?: number | bigint }).minimum
  const max = (issue as ZodIssue & { maximum?: number | bigint }).maximum
  const expected = (issue as ZodIssue & { expected?: string }).expected
  if (min !== undefined) out.min = Number(min)
  if (max !== undefined) out.max = Number(max)
  if (expected !== undefined) out.expected = String(expected)
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Validate a single node's params. Plugin / unknown kinds return an empty
 * result (their JSON Schema-driven Schema Form does its own validation).
 */
export function validateNodeParams(
  kind: WorkflowNodeKind,
  params: Record<string, unknown> | undefined
): NodeValidationResult {
  const schema = paramsSchemaFor(kind)
  const parsed = schema.safeParse(params ?? {})
  if (parsed.success) {
    return { fields: {}, summary: [], hasErrors: false }
  }
  return zodErrorToResult(parsed.error)
}

/** Internal: collapse a ZodError into a `NodeValidationResult`. */
function zodErrorToResult(err: ZodError): NodeValidationResult {
  const fields: Record<string, FieldError> = {}
  const summary: string[] = []
  for (const issue of err.issues) {
    // Path is e.g. `["cron"]` or `["cases", 0, "label"]`. We collapse to a
    // dotted string keyed by the *top-level* form field so the inspector's
    // per-field renderer can find the right error. Issues with an empty
    // path (object-level refines) land under `"_root"`.
    const top = issue.path.length > 0 ? String(issue.path[0]) : "_root"
    if (!fields[top]) {
      fields[top] = mapIssueToFieldError(issue)
    }
    summary.push(`${top}: ${issue.message}`)
  }
  return { fields, summary, hasErrors: Object.keys(fields).length > 0 }
}

/**
 * Validate every node in a workflow. Returns a `Record<stepId, …>` ready to
 * push into the editor store's `validationByStepId` slice. Disabled nodes
 * are still validated (so the user knows to fix them before re-enabling).
 */
export function validateAllNodes(
  nodes: ReadonlyArray<{
    id: string
    data: { kind: string; params?: Record<string, unknown> }
  }>
): Record<string, NodeValidationResult> {
  const out: Record<string, NodeValidationResult> = {}
  for (const node of nodes) {
    const result = validateNodeParams(node.data.kind as WorkflowNodeKind, node.data.params)
    if (result.hasErrors) out[node.id] = result
  }
  return out
}

/**
 * Aggregate per-node summaries into a single ordered list. Used by the
 * canvas's "block run" toast.
 */
export function flattenSummary(byStep: Record<string, NodeValidationResult>): string[] {
  const out: string[] = []
  for (const [stepId, result] of Object.entries(byStep)) {
    for (const entry of result.summary) {
      out.push(`${stepId} → ${entry}`)
    }
  }
  return out
}

/** Re-export so consumers don't need to import `z` to get the schema type. */
export type ParamsSchema = z.ZodTypeAny
