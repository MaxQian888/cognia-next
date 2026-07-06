import { buildJudgePrompt, matchKey, selectWinnerByJudge } from "./judge"
import type { ReconcileCandidate } from "./reconciler"

function cand(key: string, ok: boolean, output = ""): ReconcileCandidate {
  return {
    ok,
    output,
    handle: {
      key,
      runId: "r",
      teammateName: "A",
      taskId: key,
      branch: `agent/r/A/${key}`,
      path: `/wt/${key}`,
    },
  }
}

describe("buildJudgePrompt", () => {
  it("lists each candidate key, branch, and truncated output", () => {
    const prompt = buildJudgePrompt([cand("t1", true, "hello"), cand("t2", true, "world")])
    expect(prompt).toContain("key=t1")
    expect(prompt).toContain("branch=agent/r/A/t2")
    expect(prompt).toContain("hello")
    expect(prompt).toMatch(/reply with only its key/i)
  })
})

describe("matchKey", () => {
  it("prefers an exact key match", () => {
    expect(matchKey("t2", [cand("t1", true), cand("t2", true)])).toBe("t2")
  })
  it("falls back to a substring match, longest key first", () => {
    const cands = [cand("t1", true), cand("t1-extended", true)]
    expect(matchKey("the winner is t1-extended, clearly", cands)).toBe("t1-extended")
  })
  it("returns null when nothing matches", () => {
    expect(matchKey("none of these", [cand("t1", true)])).toBeNull()
  })
})

describe("selectWinnerByJudge", () => {
  it("returns null when no candidate succeeded", async () => {
    const winner = await selectWinnerByJudge([cand("t1", false)], { run: async () => "t1" })
    expect(winner).toBeNull()
  })

  it("short-circuits a single successful candidate without calling the model", async () => {
    const run = jest.fn(async () => "ignored")
    const winner = await selectWinnerByJudge([cand("t1", true), cand("t2", false)], { run })
    expect(winner).toBe("t1")
    expect(run).not.toHaveBeenCalled()
  })

  it("uses the model's choice among multiple successes", async () => {
    const winner = await selectWinnerByJudge([cand("t1", true), cand("t2", true)], {
      run: async () => "I pick t2",
    })
    expect(winner).toBe("t2")
  })

  it("falls back to the first success when the model fails", async () => {
    const winner = await selectWinnerByJudge([cand("t1", true), cand("t2", true)], {
      run: async () => {
        throw new Error("model down")
      },
    })
    expect(winner).toBe("t1")
  })

  it("falls back to the first success when the reply matches no key", async () => {
    const winner = await selectWinnerByJudge([cand("t1", true), cand("t2", true)], {
      run: async () => "gibberish",
    })
    expect(winner).toBe("t1")
  })
})
