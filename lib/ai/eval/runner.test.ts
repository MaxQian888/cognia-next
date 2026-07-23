import type { EvalCase, EvalSample, Score, Scorer } from "@/types/eval/eval"
import { runEval, type EvalTarget } from "./runner"

function makeCase(id: string): EvalCase {
  return {
    id,
    datasetId: "d1",
    input: `prompt ${id}`,
    capability: "chat.tool-use",
    source: "handwritten",
    createdAt: 0,
    updatedAt: 0,
  }
}

function makeSample(overrides: Partial<EvalSample> = {}): EvalSample {
  return {
    output: "ok",
    toolCalls: [],
    retrievedChunks: [],
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0.01,
    latencyMs: 100,
    stepCount: 1,
    degraded: false,
    ...overrides,
  }
}

/** A scorer that always returns a fixed pass/value. */
function constScorer(id: string, value: number, passed: boolean): Scorer {
  return {
    id,
    dimension: "response-quality",
    requiresLlm: false,
    gating: true,
    score(): Score {
      return { scorerId: id, dimension: "response-quality", status: "scored", value, passed }
    },
  }
}

describe("runEval", () => {
  it("runs every case once by default and applies every scorer", async () => {
    const target: EvalTarget = { label: "t", run: async () => makeSample() }
    const results = await runEval({
      cases: [makeCase("a"), makeCase("b")],
      scorers: [constScorer("s1", 1, true), constScorer("s2", 0.5, false)],
      target,
    })
    expect(results).toHaveLength(2)
    expect(results[0].repetitions).toHaveLength(1)
    expect(results[0].repetitions[0].scores).toHaveLength(2)
    expect(results[0].repetitions[0].scores.map((s) => s.scorerId)).toEqual(["s1", "s2"])
  })

  it("repeats each case k times for pass^k", async () => {
    let runs = 0
    const target: EvalTarget = {
      label: "t",
      run: async () => {
        runs += 1
        return makeSample()
      },
    }
    const results = await runEval({
      cases: [makeCase("a")],
      scorers: [constScorer("s1", 1, true)],
      target,
      k: 3,
    })
    expect(runs).toBe(3)
    expect(results[0].repetitions).toHaveLength(3)
  })

  it("passes the case to the target so it can drive the right prompt", async () => {
    const seen: string[] = []
    const target: EvalTarget = {
      label: "t",
      run: async (c) => {
        seen.push(c.input)
        return makeSample()
      },
    }
    await runEval({ cases: [makeCase("x")], scorers: [], target })
    expect(seen).toEqual(["prompt x"])
  })

  it("captures a target failure as an errored sample without crashing the run", async () => {
    const target: EvalTarget = {
      label: "t",
      run: async () => {
        throw new Error("sidecar exploded")
      },
    }
    const results = await runEval({
      cases: [makeCase("a")],
      scorers: [constScorer("s1", 1, true)],
      target,
    })
    expect(results[0].repetitions[0].sample.error).toContain("sidecar exploded")
    expect(results[0].repetitions[0].sample.degraded).toBe(true)
    // scorers still ran against the errored sample
    expect(results[0].repetitions[0].scores).toHaveLength(1)
  })

  it("isolates a throwing scorer into an errored Score", async () => {
    const throwing: Scorer = {
      id: "boom",
      dimension: "tool-use",
      requiresLlm: false,
      gating: true,
      score() {
        throw new Error("scorer bug")
      },
    }
    const target: EvalTarget = { label: "t", run: async () => makeSample() }
    const results = await runEval({
      cases: [makeCase("a")],
      scorers: [throwing, constScorer("ok", 1, true)],
      target,
    })
    const boom = results[0].repetitions[0].scores.find((s) => s.scorerId === "boom")
    expect(boom?.error).toContain("scorer bug")
    // the other scorer still produced a clean result
    expect(results[0].repetitions[0].scores.find((s) => s.scorerId === "ok")?.passed).toBe(true)
  })

  it("invokes onCaseComplete with each result and index", async () => {
    const target: EvalTarget = { label: "t", run: async () => makeSample() }
    const seen: number[] = []
    await runEval({
      cases: [makeCase("a"), makeCase("b")],
      scorers: [],
      target,
      onCaseComplete: (_r, i) => seen.push(i),
    })
    expect(seen).toEqual([0, 1])
  })

  it("stops early when the abort signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const target: EvalTarget = { label: "t", run: async () => makeSample() }
    const results = await runEval({
      cases: [makeCase("a")],
      scorers: [],
      target,
      signal: controller.signal,
    })
    expect(results).toHaveLength(0)
  })

  it("drops a case whose repetitions are cut short by an abort mid-run", async () => {
    const controller = new AbortController()
    const target: EvalTarget = {
      label: "t",
      run: async () => {
        controller.abort() // abort after the first repetition starts
        return makeSample()
      },
    }
    const results = await runEval({
      cases: [makeCase("a")],
      scorers: [],
      target,
      k: 3,
      signal: controller.signal,
    })
    // k=3 requested but aborted after rep 0 → incomplete case is dropped
    expect(results).toHaveLength(0)
  })

  it("floors k to at least 1", async () => {
    const target: EvalTarget = { label: "t", run: async () => makeSample() }
    const results = await runEval({ cases: [makeCase("a")], scorers: [], target, k: 0 })
    expect(results[0].repetitions).toHaveLength(1)
  })
})
