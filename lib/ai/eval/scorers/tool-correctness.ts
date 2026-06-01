/**
 * Deterministic tool-use scorers (L1 tier — no LLM).
 *
 * Mirrors the fine-grained tool-use metric family from TRAJECT-Bench / BFCL /
 * DeepEval `ToolCorrectness`: selection accuracy, argument correctness, call
 * order, and redundancy. All four are pure functions over an {@link EvalSample}
 * so they run in the CI deterministic tier every change.
 *
 * Reference-based scorers (selection / args / order) return a Score with
 * `error` set ("not-applicable") when the case carries no matching reference,
 * rather than throwing — the report aggregator excludes errored observations
 * from means and pass-rates.
 */

import type { EvalCase, EvalSample, Score, Scorer } from "@/types/eval/eval"

/** Stable JSON stringify (sorted keys) for deterministic value comparison. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

function uniqueOrdered(names: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of names) {
    if (!seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  return out
}

function notApplicable(scorerId: string, reason: string): Score {
  return {
    scorerId,
    dimension: "tool-use",
    value: 0,
    passed: false,
    error: `not-applicable: ${reason}`,
  }
}

export const toolSelectionScorer: Scorer = {
  id: "tool-selection",
  dimension: "tool-use",
  requiresLlm: false,
  score(sample: EvalSample, evalCase: EvalCase): Score {
    const expected = evalCase.reference?.expectedTools
    if (!expected || expected.length === 0) {
      return notApplicable(this.id, "no expectedTools reference")
    }
    const expectedSet = uniqueOrdered(expected)
    const calledSet = uniqueOrdered(sample.toolCalls.map((t) => t.name))
    const expectedLookup = new Set(expectedSet)
    const calledLookup = new Set(calledSet)
    const tp = calledSet.filter((n) => expectedLookup.has(n)).length
    const precision = calledSet.length > 0 ? tp / calledSet.length : 0
    const recall = expectedSet.length > 0 ? tp / expectedSet.length : 0
    const value = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0
    const missingTools = expectedSet.filter((n) => !calledLookup.has(n))
    const extraTools = calledSet.filter((n) => !expectedLookup.has(n))
    return {
      scorerId: this.id,
      dimension: "tool-use",
      value,
      passed: value >= 1,
      metadata: { precision, recall, missingTools, extraTools },
    }
  },
}

export const toolArgsScorer: Scorer = {
  id: "tool-args",
  dimension: "tool-use",
  requiresLlm: false,
  score(sample: EvalSample, evalCase: EvalCase): Score {
    const expectedArgs = evalCase.reference?.expectedToolArgs
    if (!expectedArgs || Object.keys(expectedArgs).length === 0) {
      return notApplicable(this.id, "no expectedToolArgs reference")
    }
    const toolNames = Object.keys(expectedArgs)
    let argsUnknown = false
    let matched = 0
    for (const toolName of toolNames) {
      const expected = expectedArgs[toolName]
      const callForTool = sample.toolCalls.find((t) => t.name === toolName)
      if (!callForTool) continue // never called → fails this tool
      const expectedKeys = Object.keys(expected)
      // Empty actual args bag (content capture off) but we expected some →
      // we can't verify; count as a miss and flag.
      if (Object.keys(callForTool.args).length === 0 && expectedKeys.length > 0) {
        argsUnknown = true
        continue
      }
      const allMatch = expectedKeys.every((k) => deepEqual(expected[k], callForTool.args[k]))
      if (allMatch) matched += 1
    }
    const value = toolNames.length > 0 ? matched / toolNames.length : 0
    return {
      scorerId: this.id,
      dimension: "tool-use",
      value,
      passed: value >= 1,
      metadata: { matched, total: toolNames.length, argsUnknown },
    }
  },
}

/** Length of the longest common subsequence of two name sequences. */
function lcsLength(a: string[], b: string[]): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[m][n]
}

export const toolOrderScorer: Scorer = {
  id: "tool-order",
  dimension: "tool-use",
  requiresLlm: false,
  score(sample: EvalSample, evalCase: EvalCase): Score {
    const expected = evalCase.reference?.expectedTools
    if (!expected || expected.length === 0) {
      return notApplicable(this.id, "no expectedTools reference")
    }
    const called = [...sample.toolCalls].sort((x, y) => x.index - y.index).map((t) => t.name)
    const lcs = lcsLength(called, expected)
    const value = expected.length > 0 ? lcs / expected.length : 0
    return {
      scorerId: this.id,
      dimension: "tool-use",
      value,
      passed: value >= 1,
      metadata: { lcs, expectedLength: expected.length },
    }
  },
}

export const redundancyScorer: Scorer = {
  id: "tool-redundancy",
  dimension: "tool-use",
  requiresLlm: false,
  score(sample: EvalSample): Score {
    const total = sample.toolCalls.length
    if (total === 0) {
      return {
        scorerId: this.id,
        dimension: "tool-use",
        value: 1,
        passed: true,
        metadata: { redundantCount: 0, totalCalls: 0 },
      }
    }
    const seen = new Set<string>()
    let redundant = 0
    for (const tc of sample.toolCalls) {
      const key = `${tc.name}::${stableStringify(tc.args)}`
      if (seen.has(key)) redundant += 1
      else seen.add(key)
    }
    const value = (total - redundant) / total
    return {
      scorerId: this.id,
      dimension: "tool-use",
      value,
      passed: value >= 1,
      metadata: { redundantCount: redundant, totalCalls: total },
    }
  },
}
