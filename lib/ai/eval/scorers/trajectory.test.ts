import type { EvalCase, EvalSample, EvalToolCall } from "@/types/eval/eval"
import { makeTrajectoryScorer, trajectoryScorer } from "./trajectory"

function call(name: string, index: number, args: Record<string, unknown> = {}): EvalToolCall {
  return { name, index, args }
}

function sample(toolCalls: EvalToolCall[]): EvalSample {
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

function makeCase(reference?: EvalCase["reference"]): EvalCase {
  return {
    id: "c1",
    datasetId: "d1",
    input: "x",
    capability: "chat.tool-use",
    source: "handwritten",
    createdAt: 0,
    updatedAt: 0,
    ...(reference ? { reference } : {}),
  }
}

describe("makeTrajectoryScorer", () => {
  it("errors when no expectedTools reference is present", async () => {
    const score = await trajectoryScorer.score(sample([call("Read", 0)]), makeCase())
    expect(score.error).toBeDefined()
  })

  describe("strict mode", () => {
    const scorer = makeTrajectoryScorer({ mode: "strict" })
    it("matches an identical ordered sequence", async () => {
      const c = makeCase({ expectedTools: ["Read", "Edit"] })
      expect((await scorer.score(sample([call("Read", 0), call("Edit", 1)]), c)).value).toBe(1)
    })
    it("rejects a reordered sequence", async () => {
      const c = makeCase({ expectedTools: ["Read", "Edit"] })
      expect((await scorer.score(sample([call("Edit", 0), call("Read", 1)]), c)).value).toBe(0)
    })
  })

  describe("unordered mode (default)", () => {
    it("matches the same set in any order", async () => {
      const c = makeCase({ expectedTools: ["Read", "Edit"] })
      const score = await trajectoryScorer.score(sample([call("Edit", 0), call("Read", 1)]), c)
      expect(score.value).toBe(1)
      expect(score.passed).toBe(true)
    })
    it("rejects when a tool is missing", async () => {
      const c = makeCase({ expectedTools: ["Read", "Edit"] })
      expect((await trajectoryScorer.score(sample([call("Read", 0)]), c)).value).toBe(0)
    })
    it("rejects when an extra tool is present", async () => {
      const c = makeCase({ expectedTools: ["Read"] })
      expect(
        (await trajectoryScorer.score(sample([call("Read", 0), call("Bash", 1)]), c)).value
      ).toBe(0)
    })
  })

  describe("superset mode", () => {
    const scorer = makeTrajectoryScorer({ mode: "superset" })
    it("matches when the agent called at least the expected tools", async () => {
      const c = makeCase({ expectedTools: ["Read"] })
      expect((await scorer.score(sample([call("Read", 0), call("Bash", 1)]), c)).value).toBe(1)
    })
    it("rejects when an expected tool is missing", async () => {
      const c = makeCase({ expectedTools: ["Read", "Edit"] })
      expect((await scorer.score(sample([call("Read", 0)]), c)).value).toBe(0)
    })
  })

  describe("subset mode", () => {
    const scorer = makeTrajectoryScorer({ mode: "subset" })
    it("matches when the agent called only expected tools (missing allowed)", async () => {
      const c = makeCase({ expectedTools: ["Read", "Edit"] })
      expect((await scorer.score(sample([call("Read", 0)]), c)).value).toBe(1)
    })
    it("rejects when the agent called an unexpected tool", async () => {
      const c = makeCase({ expectedTools: ["Read"] })
      expect((await scorer.score(sample([call("Read", 0), call("Bash", 1)]), c)).value).toBe(0)
    })
  })

  describe("argMatch", () => {
    const scorer = makeTrajectoryScorer({ mode: "unordered", argMatch: true })
    it("rejects a set-match when an expected tool's args mismatch", async () => {
      const c = makeCase({
        expectedTools: ["Read"],
        expectedToolArgs: { Read: { path: "/a" } },
      })
      expect((await scorer.score(sample([call("Read", 0, { path: "/WRONG" })]), c)).value).toBe(0)
    })
    it("accepts when args also match", async () => {
      const c = makeCase({
        expectedTools: ["Read"],
        expectedToolArgs: { Read: { path: "/a" } },
      })
      expect(
        (await scorer.score(sample([call("Read", 0, { path: "/a", extra: 1 })]), c)).value
      ).toBe(1)
    })

    it("deep-compares nested array/object args via stable stringify", async () => {
      const c = makeCase({
        expectedTools: ["Run"],
        expectedToolArgs: { Run: { cmd: ["a", "b"], opts: { x: 1 } } },
      })
      // same nested values, keys in a different order → still matches
      expect(
        (await scorer.score(sample([call("Run", 0, { opts: { x: 1 }, cmd: ["a", "b"] })]), c)).value
      ).toBe(1)
      // changed nested value → no match
      expect(
        (await scorer.score(sample([call("Run", 0, { cmd: ["a", "c"], opts: { x: 1 } })]), c)).value
      ).toBe(0)
    })
  })
})
