/**
 * Trajectory scorer (L2 tier — no LLM).
 *
 * Ports the agentevals trajectory-match semantics over the captured tool-call
 * sequence: four modes describe how the agent's actual tool trajectory must
 * relate to the expected one.
 *
 *  - `strict`    — identical tools in identical order.
 *  - `unordered` — same set of tools, order ignored (default).
 *  - `superset`  — agent called AT LEAST the expected tools (extras allowed).
 *  - `subset`    — agent called ONLY expected tools (missing allowed).
 *
 * `argMatch` additionally requires that, for every tool with an entry in
 * `reference.expectedToolArgs`, at least one matching call passed those args
 * (subset deep-equality). Value is binary (1 match / 0 no-match) — agentevals
 * treats a trajectory as either matching or not.
 */

import type { EvalCase, EvalSample, Score, Scorer } from "@/types/eval/eval"

export type TrajectoryMode = "strict" | "unordered" | "superset" | "subset"

export interface TrajectoryScorerOptions {
  mode?: TrajectoryMode
  /** Also require expected tool args (when the case provides them) to match. */
  argMatch?: boolean
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`
}

function sequenceEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function setEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

function isSuperset(actual: Set<string>, expected: Set<string>): boolean {
  for (const x of expected) if (!actual.has(x)) return false
  return true
}

function isSubset(actual: Set<string>, expected: Set<string>): boolean {
  for (const x of actual) if (!expected.has(x)) return false
  return true
}

export function makeTrajectoryScorer(options: TrajectoryScorerOptions = {}): Scorer {
  const mode: TrajectoryMode = options.mode ?? "unordered"
  const argMatch = options.argMatch ?? false
  return {
    id: `trajectory-${mode}`,
    dimension: "tool-use",
    requiresLlm: false,
    gating: true,
    score(sample: EvalSample, evalCase: EvalCase): Score {
      const expected = evalCase.reference?.expectedTools
      if (!expected || expected.length === 0) {
        return {
          scorerId: `trajectory-${mode}`,
          dimension: "tool-use",
          status: "not-applicable",
          value: 0,
          passed: false,
          error: "not-applicable: no expectedTools reference",
        }
      }
      const calledSeq = [...sample.toolCalls].sort((a, b) => a.index - b.index).map((t) => t.name)
      const calledSet = new Set(calledSeq)
      const expectedSet = new Set(expected)

      let namesMatch: boolean
      switch (mode) {
        case "strict":
          namesMatch = sequenceEqual(calledSeq, expected)
          break
        case "superset":
          namesMatch = isSuperset(calledSet, expectedSet)
          break
        case "subset":
          namesMatch = isSubset(calledSet, expectedSet)
          break
        case "unordered":
        default:
          namesMatch = setEqual(calledSet, expectedSet)
          break
      }

      let argsMatch = true
      if (argMatch && namesMatch) {
        const expectedArgs = evalCase.reference?.expectedToolArgs ?? {}
        for (const toolName of Object.keys(expectedArgs)) {
          const want = expectedArgs[toolName]
          const wantKeys = Object.keys(want)
          const ok = sample.toolCalls.some(
            (c) =>
              c.name === toolName &&
              wantKeys.every((k) => stableStringify(want[k]) === stableStringify(c.args[k]))
          )
          if (!ok) {
            argsMatch = false
            break
          }
        }
      }

      const value = namesMatch && argsMatch ? 1 : 0
      return {
        scorerId: `trajectory-${mode}`,
        dimension: "tool-use",
        status: "scored",
        value,
        passed: value === 1,
        metadata: { mode, namesMatch, argsMatch },
      }
    },
  }
}

/** Default unordered set-match trajectory scorer. */
export const trajectoryScorer: Scorer = makeTrajectoryScorer({ mode: "unordered" })
