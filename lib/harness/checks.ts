/**
 * Deterministic task checks (ADR-0237).
 *
 * Every rollout is checked here before any model is asked to judge it. A check
 * that cannot be decided from the evidence is `inconclusive`, and inconclusive
 * never counts as passed: a candidate does not get credit for evidence nobody
 * collected.
 *
 * Acceptance profiles (ADR-0188) run commands in a sandbox, which is runtime
 * work; the probe runner runs them through the acceptance port and hands the
 * outcomes in. This module only reads them.
 */

import type {
  HarnessDeliverable,
  HarnessEvolutionTask,
  HarnessTaskCheck,
  HarnessValidationResult,
} from "@/types/harness/evolution"

export interface AcceptanceCheckOutcome {
  outcome: "passed" | "failed" | "inconclusive"
  detail?: string
}

export interface TaskCheckInput {
  output: string
  deliverables: readonly HarnessDeliverable[]
  toolFailures: number
  /** Outcomes of acceptance profiles the runner ran, by profile id. */
  acceptance?: ReadonlyMap<string, AcceptanceCheckOutcome>
  /** False when the run never reached a working directory (text-only host). */
  filesObservable: boolean
}

/** A short, stable description of a check, used as its result label. */
export function describeCheck(check: HarnessTaskCheck): string {
  switch (check.kind) {
    case "deliverable-file":
      return `deliverable ${check.path}`
    case "output-contains":
      return `output contains "${check.value}"`
    case "output-not-contains":
      return `output does not contain "${check.value}"`
    case "output-json":
      return check.requiredKeys?.length
        ? `output is JSON with ${check.requiredKeys.join(", ")}`
        : "output is JSON"
    case "max-tool-errors":
      return `at most ${check.max} tool errors`
    case "acceptance-profile":
      return `acceptance profile ${check.profileId}`
  }
}

function includes(haystack: string, needle: string, caseSensitive: boolean | undefined): boolean {
  return caseSensitive
    ? haystack.includes(needle)
    : haystack.toLowerCase().includes(needle.toLowerCase())
}

/** The JSON object in an answer: the whole text, or its first fenced ```json block. */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const candidates = [trimmed]
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(trimmed)
  if (fenced) candidates.push(fenced[1].trim())
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // try the next form
    }
  }
  return undefined
}

function result(
  check: HarnessTaskCheck,
  status: HarnessValidationResult["status"],
  detail?: string
): HarnessValidationResult {
  return {
    check: describeCheck(check),
    passed: status === "passed",
    status,
    ...(detail ? { detail } : {}),
  }
}

export function runTaskCheck(
  check: HarnessTaskCheck,
  input: TaskCheckInput
): HarnessValidationResult {
  switch (check.kind) {
    case "deliverable-file": {
      if (!input.filesObservable) {
        return result(check, "inconclusive", "the run had no working directory to inspect")
      }
      const found = input.deliverables.find((d) => d.path === check.path)
      if (!found) return result(check, "failed", `${check.path} was not produced`)
      if (found.bytes === 0) return result(check, "failed", `${check.path} is empty`)
      return result(check, "passed")
    }
    case "output-contains":
      return includes(input.output, check.value, check.caseSensitive)
        ? result(check, "passed")
        : result(check, "failed", "the final answer does not contain it")
    case "output-not-contains":
      return includes(input.output, check.value, check.caseSensitive)
        ? result(check, "failed", "the final answer contains it")
        : result(check, "passed")
    case "output-json": {
      const value = extractJsonObject(input.output)
      if (value === undefined) return result(check, "failed", "the final answer is not JSON")
      const missing = (check.requiredKeys ?? []).filter(
        (key) =>
          typeof value !== "object" || value === null || Array.isArray(value) || !(key in value)
      )
      return missing.length
        ? result(check, "failed", `missing keys: ${missing.join(", ")}`)
        : result(check, "passed")
    }
    case "max-tool-errors":
      return input.toolFailures <= check.max
        ? result(check, "passed")
        : result(check, "failed", `${input.toolFailures} tool calls failed`)
    case "acceptance-profile": {
      const outcome = input.acceptance?.get(check.profileId)
      if (!outcome) return result(check, "inconclusive", "the profile was not run")
      return result(check, outcome.outcome, outcome.detail)
    }
  }
}

export function runTaskChecks(
  checks: readonly HarnessTaskCheck[],
  input: TaskCheckInput
): HarnessValidationResult[] {
  return checks.map((check) => runTaskCheck(check, input))
}

/**
 * Whether a rollout produced what the task asked for: every expected
 * deliverable exists and is non-empty, or, for a task with none, the run gave
 * a non-empty answer. A run that errored never delivered.
 */
export function isDelivered(
  task: Pick<HarnessEvolutionTask, "expectedDeliverables">,
  input: Pick<TaskCheckInput, "output" | "deliverables" | "filesObservable">,
  error: string | undefined
): boolean {
  if (error) return false
  const expected = task.expectedDeliverables ?? []
  if (expected.length === 0) return input.output.trim().length > 0
  if (!input.filesObservable) return false
  return expected.every((path) => input.deliverables.some((d) => d.path === path && d.bytes > 0))
}

/** Passed / failed / inconclusive counts of a set of results. */
export function checkTally(results: readonly HarnessValidationResult[]): {
  passed: number
  failed: number
  inconclusive: number
  total: number
} {
  let passed = 0
  let failed = 0
  let inconclusive = 0
  for (const r of results) {
    if (r.status === "passed") passed += 1
    else if (r.status === "failed") failed += 1
    else inconclusive += 1
  }
  return { passed, failed, inconclusive, total: results.length }
}
