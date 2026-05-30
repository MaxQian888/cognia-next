import { judgePanelNode } from "./judge-panel"
import {
  registerTeamRunContext,
  __resetTeamRunContextForTesting,
  type TeamRunContext,
} from "../team-run-context"
import type { StepExecutionContext } from "@/types/workflow/visual"

const dispatchStructuredMock = jest.fn()
jest.mock("../structured-dispatch", () => ({
  dispatchStructured: (...a: unknown[]) => dispatchStructuredMock(...a),
}))

function makeCtx(params: Record<string, unknown>) {
  registerTeamRunContext({
    runId: "run1",
    teamId: "team1",
    concurrency: { get: () => 8 },
  } as unknown as TeamRunContext)
  return {
    runId: "run1",
    stepId: "judge1",
    params,
    upstream: {},
    signal: new AbortController().signal,
    log: jest.fn(),
  } as unknown as StepExecutionContext
}

beforeEach(() => jest.clearAllMocks())
afterEach(() => __resetTeamRunContextForTesting())

describe("pattern.judge-panel", () => {
  it("scores every attempt and picks the highest average as winner", async () => {
    // 2 attempts × 2 judges. Attempt 0 → [4,6]=5, Attempt 1 → [9,9]=9 → winner.
    dispatchStructuredMock
      .mockResolvedValueOnce({ value: { angle: "mvp", content: "a0" } }) // attempt 0
      .mockResolvedValueOnce({ value: { angle: "risk", content: "a1" } }) // attempt 1
      .mockResolvedValueOnce({ value: { score: 4, rationale: "r" } }) // judge a0
      .mockResolvedValueOnce({ value: { score: 6, rationale: "r" } }) // judge a0
      .mockResolvedValueOnce({ value: { score: 9, rationale: "r" } }) // judge a1
      .mockResolvedValueOnce({ value: { score: 9, rationale: "r" } }) // judge a1

    const ctx = makeCtx({ objective: "design", angles: ["mvp", "risk"], judgesPerAttempt: 2 })
    const result = await judgePanelNode.execute(ctx)

    const out = result.output as {
      winner: { attempt: { angle: string }; avgScore: number }
      ranked: { avgScore: number }[]
    }
    expect(out.winner.attempt.angle).toBe("risk")
    expect(out.winner.avgScore).toBe(9)
    expect(out.ranked[0].avgScore).toBeGreaterThanOrEqual(out.ranked[1].avgScore)
  })

  it("survives a failed attempt and still judges the rest", async () => {
    dispatchStructuredMock
      .mockRejectedValueOnce(new Error("attempt boom")) // attempt 0 fails
      .mockResolvedValueOnce({ value: { angle: "b", content: "a1" } }) // attempt 1 ok
      .mockResolvedValueOnce({ value: { score: 7, rationale: "r" } }) // judge a1

    const ctx = makeCtx({ objective: "x", angles: ["a", "b"], judgesPerAttempt: 1 })
    const result = await judgePanelNode.execute(ctx)
    const out = result.output as { winner: { attempt: { angle: string } } }
    expect(out.winner.attempt.angle).toBe("b")
  })

  it("throws when every attempt fails", async () => {
    dispatchStructuredMock.mockRejectedValue(new Error("all boom"))
    const ctx = makeCtx({ objective: "x", angles: ["a"], judgesPerAttempt: 1 })
    await expect(judgePanelNode.execute(ctx)).rejects.toThrow(/every attempt failed/)
  })

  it("defaults judgesPerAttempt to 3 when omitted", async () => {
    dispatchStructuredMock
      .mockResolvedValueOnce({ value: { angle: "a", content: "c" } }) // attempt
      .mockResolvedValue({ value: { score: 8, rationale: "r" } }) // 3 judges
    const ctx = makeCtx({ objective: "x", angles: ["a"] })
    await judgePanelNode.execute(ctx)
    // 1 attempt + 3 default judges = 4 dispatches.
    expect(dispatchStructuredMock).toHaveBeenCalledTimes(4)
  })

  it("throws when objective is missing", async () => {
    const ctx = makeCtx({ angles: ["a"] })
    await expect(judgePanelNode.execute(ctx)).rejects.toThrow(/objective/)
  })

  it("throws when angles are missing", async () => {
    const ctx = makeCtx({ objective: "x", angles: [] })
    await expect(judgePanelNode.execute(ctx)).rejects.toThrow(/angles/)
  })
})
