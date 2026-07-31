import type { EvalCase, EvalSample, EvalToolCall } from "@/types/eval/eval"
import {
  toolSelectionScorer,
  toolArgsScorer,
  toolOrderScorer,
  redundancyScorer,
} from "./tool-correctness"

function call(name: string, index: number, args: Record<string, unknown> = {}): EvalToolCall {
  return { name, index, args }
}

function sample(toolCalls: EvalToolCall[] = []): EvalSample {
  return {
    output: "",
    toolCalls,
    retrievedChunks: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0,
    latencyMs: 0,
    stepCount: toolCalls.length,
    degraded: false,
  }
}

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "c1",
    datasetId: "d1",
    input: "do the thing",
    capability: "chat.tool-use",
    source: "handwritten",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe("toolSelectionScorer", () => {
  it("errors (not-applicable) when the case has no expectedTools reference", async () => {
    const score = await toolSelectionScorer.score(sample([call("Read", 0)]), makeCase())
    expect(score.error).toBeDefined()
    expect(score.passed).toBe(false)
  })

  it("scores 1 and passes when the called set exactly matches the expected set", async () => {
    const c = makeCase({ reference: { expectedTools: ["Read", "Edit"] } })
    const score = await toolSelectionScorer.score(sample([call("Read", 0), call("Edit", 1)]), c)
    expect(score.value).toBe(1)
    expect(score.passed).toBe(true)
  })

  it("ignores order and duplicates when matching the set", async () => {
    const c = makeCase({ reference: { expectedTools: ["Read", "Edit"] } })
    const score = await toolSelectionScorer.score(
      sample([call("Edit", 0), call("Read", 1), call("Read", 2)]),
      c
    )
    expect(score.value).toBe(1)
    expect(score.passed).toBe(true)
  })

  it("drops below 1 and fails when an expected tool is missing", async () => {
    const c = makeCase({ reference: { expectedTools: ["Read", "Edit", "Bash"] } })
    const score = await toolSelectionScorer.score(sample([call("Read", 0)]), c)
    expect(score.value).toBeLessThan(1)
    expect(score.passed).toBe(false)
    expect(score.metadata?.missingTools).toEqual(["Edit", "Bash"])
  })

  it("penalizes extra (unexpected) tools via F1", async () => {
    const c = makeCase({ reference: { expectedTools: ["Read"] } })
    const score = await toolSelectionScorer.score(
      sample([call("Read", 0), call("Bash", 1), call("Edit", 2)]),
      c
    )
    expect(score.value).toBeLessThan(1)
    expect(score.metadata?.extraTools).toEqual(["Bash", "Edit"])
  })
})

describe("toolArgsScorer", () => {
  it("errors when the case has no expectedToolArgs reference", async () => {
    const score = await toolArgsScorer.score(sample([call("Read", 0)]), makeCase())
    expect(score.error).toBeDefined()
  })

  it("errors when expectedToolArgs is an empty object", async () => {
    const c = makeCase({ reference: { expectedToolArgs: {} } })
    expect((await toolArgsScorer.score(sample([call("Read", 0)]), c)).error).toBeDefined()
  })

  it("deep-compares nested array/object arg values", async () => {
    const c = makeCase({ reference: { expectedToolArgs: { Run: { cmd: ["a", "b"] } } } })
    const ok = await toolArgsScorer.score(sample([call("Run", 0, { cmd: ["a", "b"] })]), c)
    expect(ok.value).toBe(1)
    const bad = await toolArgsScorer.score(sample([call("Run", 0, { cmd: ["a", "x"] })]), c)
    expect(bad.value).toBe(0)
  })

  it("passes when expected args are a subset of the actual call args", async () => {
    const c = makeCase({ reference: { expectedToolArgs: { Read: { path: "/a.txt" } } } })
    const s = sample([call("Read", 0, { path: "/a.txt", offset: 0 })])
    const score = await toolArgsScorer.score(s, c)
    expect(score.value).toBe(1)
    expect(score.passed).toBe(true)
  })

  it("fails the tool when an expected arg value mismatches", async () => {
    const c = makeCase({ reference: { expectedToolArgs: { Read: { path: "/a.txt" } } } })
    const s = sample([call("Read", 0, { path: "/b.txt" })])
    const score = await toolArgsScorer.score(s, c)
    expect(score.value).toBe(0)
    expect(score.passed).toBe(false)
  })

  it("fails the tool when it was never called", async () => {
    const c = makeCase({ reference: { expectedToolArgs: { Edit: { path: "/a" } } } })
    const score = await toolArgsScorer.score(sample([call("Read", 0)]), c)
    expect(score.value).toBe(0)
  })

  it("flags args-unknown when the actual call args are an empty bag", async () => {
    const c = makeCase({ reference: { expectedToolArgs: { Read: { path: "/a" } } } })
    const score = await toolArgsScorer.score(sample([call("Read", 0, {})]), c)
    expect(score.value).toBe(0)
    expect(score.metadata?.argsUnknown).toBe(true)
  })

  it("averages across multiple expected tools", async () => {
    const c = makeCase({
      reference: { expectedToolArgs: { Read: { path: "/a" }, Edit: { path: "/b" } } },
    })
    const s = sample([call("Read", 0, { path: "/a" }), call("Edit", 1, { path: "/WRONG" })])
    const score = await toolArgsScorer.score(s, c)
    expect(score.value).toBe(0.5)
  })
})

describe("toolOrderScorer", () => {
  it("errors when no expectedTools reference is present", async () => {
    const score = await toolOrderScorer.score(sample([call("Read", 0)]), makeCase())
    expect(score.error).toBeDefined()
  })

  it("scores 1 when called tools follow the expected order as a subsequence", async () => {
    const c = makeCase({ reference: { expectedTools: ["Read", "Edit", "Bash"] } })
    // extra Grep interleaved but the Read→Edit→Bash order holds
    const s = sample([call("Read", 0), call("Grep", 1), call("Edit", 2), call("Bash", 3)])
    const score = await toolOrderScorer.score(s, c)
    expect(score.value).toBe(1)
    expect(score.passed).toBe(true)
  })

  it("drops below 1 when the order is violated", async () => {
    const c = makeCase({ reference: { expectedTools: ["Read", "Edit", "Bash"] } })
    const s = sample([call("Edit", 0), call("Read", 1), call("Bash", 2)])
    const score = await toolOrderScorer.score(s, c)
    expect(score.value).toBeLessThan(1)
    expect(score.passed).toBe(false)
  })
})

describe("redundancyScorer", () => {
  it("reports measurement for an empty trajectory — nothing was called, nothing passed", async () => {
    // Regression guard: this used to return `passed: true`, so a dataset with
    // no tool expectations at all got a free passing verdict on every case.
    const score = await redundancyScorer.score(sample([]), makeCase())
    expect(score.status).toBe("measurement")
    expect(score.value).toBe(1)
    expect(score.passed).toBe(false)
  })

  it("scores 1 when every call is distinct", async () => {
    const s = sample([call("Read", 0, { path: "/a" }), call("Read", 1, { path: "/b" })])
    const score = await redundancyScorer.score(s, makeCase())
    expect(score.value).toBe(1)
  })

  it("penalizes duplicate identical calls (same name + args)", async () => {
    const s = sample([
      call("Read", 0, { path: "/a" }),
      call("Read", 1, { path: "/a" }),
      call("Read", 2, { path: "/a" }),
    ])
    const score = await redundancyScorer.score(s, makeCase())
    // 2 of 3 calls are redundant repeats
    expect(score.value).toBeCloseTo(1 / 3, 5)
    expect(score.passed).toBe(false)
    expect(score.metadata?.redundantCount).toBe(2)
  })
})
