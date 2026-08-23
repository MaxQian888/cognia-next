import { currentTurnContext, runInTurnContext } from "./session-context"

const first = { sessionId: "s1", runId: "r1", attemptId: "a1" }
const second = { sessionId: "s2", runId: "r2", attemptId: "a2" }

describe("RPC turn context", () => {
  it("is undefined outside any turn", () => {
    expect(currentTurnContext()).toBeUndefined()
  })

  it("is visible synchronously inside the turn", () => {
    runInTurnContext(first, () => {
      expect(currentTurnContext()).toEqual(first)
    })
    expect(currentTurnContext()).toBeUndefined()
  })

  it("propagates across awaits", async () => {
    await runInTurnContext(first, async () => {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 1))
      expect(currentTurnContext()).toEqual(first)
    })
  })

  it("keeps two interleaved turns apart", async () => {
    const seen: string[] = []
    const turn = (context: typeof first, delay: number) =>
      runInTurnContext(context, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay))
        seen.push(currentTurnContext()?.sessionId ?? "none")
        await new Promise((resolve) => setTimeout(resolve, delay))
        seen.push(currentTurnContext()?.sessionId ?? "none")
      })

    await Promise.all([turn(first, 4), turn(second, 1)])
    // Interleaved by construction, yet each observation names its own session.
    expect(seen.filter((value) => value === "s1")).toHaveLength(2)
    expect(seen.filter((value) => value === "s2")).toHaveLength(2)
    expect(seen).not.toContain("none")
  })

  it("does not leak a nested turn's identity to its caller", () => {
    runInTurnContext(first, () => {
      runInTurnContext(second, () => {
        expect(currentTurnContext()).toEqual(second)
      })
      expect(currentTurnContext()).toEqual(first)
    })
  })

  it("returns the callback's value unchanged", () => {
    expect(runInTurnContext(first, () => 42)).toBe(42)
  })
})
