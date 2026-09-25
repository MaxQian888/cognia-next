/**
 * Shape checks for a decision request (ADR-0194), shared by every entry point:
 * `runDecision`, the plugin `ctx.decisions` API, and the settings probe.
 *
 * The wire contract is the TypeSafe decisions protocol; laya enforces the same
 * rules in `plugins/cognia-laya-guard/layaguard/engine.py:validate_questions`.
 * Keep the two rule-for-rule in step — a request one side accepts and the
 * other rejects would fail only for the provider the user happened to pick.
 */

import type { DecisionQuestions, DecisionRequest } from "@/types/decisions"

/** Choice questions accept at most this many options (TypeSafe limit). */
export const MAX_CHOICE_OPTIONS = 255

/** Serialized request ceiling — a decision is a small judgment, not a document. */
export const MAX_DECISION_REQUEST_CHARS = 256 * 1024

export type DecisionValidation =
  { ok: true; request: DecisionRequest } | { ok: false; message: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/** Reason the question map is unusable, or `null` when it is well formed. */
export function validateDecisionQuestions(questions: unknown): string | null {
  if (!isPlainObject(questions) || Object.keys(questions).length === 0) {
    return "questions must be a non-empty object"
  }
  for (const [id, question] of Object.entries(questions)) {
    if (!id) return "question ids must be non-empty strings"
    if (!isPlainObject(question)) return `question "${id}" must be an object`
    const { type, instructions, criteria } = question
    if (type !== "noul" && type !== "choice" && type !== "score") {
      return `question "${id}" has unknown type "${String(type)}"`
    }
    if (!isNonEmptyString(instructions)) return `question "${id}" needs non-empty instructions`
    if (type === "choice") {
      if (!isPlainObject(criteria)) return `choice question "${id}" needs a criteria object`
      const keys = Object.keys(criteria)
      if (keys.length < 2 || keys.length > MAX_CHOICE_OPTIONS) {
        return `choice question "${id}" needs 2-${MAX_CHOICE_OPTIONS} criteria`
      }
      if (keys.some((key) => !key)) return `choice question "${id}" has an empty option key`
      if (Object.values(criteria).some((value) => typeof value !== "string")) {
        return `choice question "${id}" criteria values must be strings`
      }
    } else if (type === "score") {
      if (!Array.isArray(criteria) || criteria.length < 2) {
        return `score question "${id}" needs at least 2 criteria levels`
      }
      if (criteria.some((level) => typeof level !== "string")) {
        return `score question "${id}" criteria levels must be strings`
      }
    } else if (criteria !== undefined) {
      if (!isPlainObject(criteria)) return `noul question "${id}" criteria must be an object`
      for (const [key, value] of Object.entries(criteria)) {
        if (key !== "true" && key !== "false") {
          return `noul question "${id}" criteria may only carry "true"/"false"`
        }
        if (typeof value !== "string")
          return `noul question "${id}" criteria values must be strings`
      }
    }
  }
  return null
}

function validateState(state: unknown): string | null {
  if (typeof state === "string") return state.trim() ? null : "state must be non-empty"
  if (Array.isArray(state)) return state.length ? null : "state must be non-empty"
  if (isPlainObject(state)) return Object.keys(state).length ? null : "state must be non-empty"
  return "state must be an object, array or string"
}

/**
 * Validate an untrusted request (plugin input, settings probe) and return it
 * narrowed. Also refuses requests that cannot be serialized (cycles, BigInt).
 */
export function validateDecisionRequest(input: unknown): DecisionValidation {
  if (!isPlainObject(input)) return { ok: false, message: "request must be an object" }
  const stateProblem = validateState(input.state)
  if (stateProblem) return { ok: false, message: stateProblem }
  const questionProblem = validateDecisionQuestions(input.questions)
  if (questionProblem) return { ok: false, message: questionProblem }
  const { stateTrim } = input
  if (stateTrim !== undefined) {
    if (
      !Array.isArray(stateTrim) ||
      stateTrim.length === 0 ||
      !stateTrim.every((segment) => isNonEmptyString(segment))
    ) {
      return { ok: false, message: "stateTrim must be a non-empty list of keys" }
    }
  }
  let serialized: string
  try {
    serialized = JSON.stringify({ state: input.state, questions: input.questions })
  } catch {
    return { ok: false, message: "request must be JSON-serializable" }
  }
  if (serialized.length > MAX_DECISION_REQUEST_CHARS) {
    return {
      ok: false,
      message: `request exceeds ${MAX_DECISION_REQUEST_CHARS} serialized characters`,
    }
  }
  return {
    ok: true,
    request: {
      state: input.state as DecisionRequest["state"],
      questions: input.questions as DecisionQuestions,
      ...(stateTrim ? { stateTrim: stateTrim as string[] } : {}),
    },
  }
}
