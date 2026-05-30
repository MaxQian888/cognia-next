import { synthesizeNode } from "./synthesize"
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

function makeCtx(params: Record<string, unknown>, upstream: Record<string, unknown> = {}) {
  const addMessage = jest.fn()
  registerTeamRunContext({
    runId: "run1",
    teamId: "team1",
    concurrency: { get: () => 4 },
    storeWriter: { addMessage, setTaskStatus: jest.fn(), updateTeammate: jest.fn() },
  } as unknown as TeamRunContext)
  const ctx = {
    runId: "run1",
    stepId: "syn1",
    params,
    upstream,
    signal: new AbortController().signal,
    log: jest.fn(),
  } as unknown as StepExecutionContext
  return { ctx, addMessage }
}

beforeEach(() => jest.clearAllMocks())
afterEach(() => __resetTeamRunContextForTesting())

describe("pattern.synthesize", () => {
  it("folds findings + winner + gaps into a report and posts it to chat", async () => {
    dispatchStructuredMock.mockResolvedValue({
      value: { report: "Final report.", citations: ["a.ts:1"] },
      teammateId: "tm9",
    })
    const upstream = {
      verify: { findings: [{ title: "Bug", detail: "d", location: "a.ts:1" }] },
      judge: { winner: { attempt: { angle: "mvp", content: "do x" }, avgScore: 9 } },
      critic: { gaps: [{ description: "no perf check" }] },
    }
    const { ctx, addMessage } = makeCtx({ objective: "audit" }, upstream)

    const result = await synthesizeNode.execute(ctx)

    const out = result.output as { report: string; citations: string[]; findingCount: number }
    expect(out.report).toBe("Final report.")
    expect(out.citations).toEqual(["a.ts:1"])
    expect(out.findingCount).toBe(1)
    expect(addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ senderId: "tm9", type: "result_share", content: "Final report." })
    )

    // The prompt should reference the winner + gaps it was given.
    const promptArg = dispatchStructuredMock.mock.calls[0][1] as { prompt: string }
    expect(promptArg.prompt).toContain("Winning approach")
    expect(promptArg.prompt).toContain("open gaps")
  })

  it("works with only findings and no winner/gaps", async () => {
    dispatchStructuredMock.mockResolvedValue({ value: { report: "R" }, teammateId: "tm1" })
    const { ctx } = makeCtx({ objective: "x" }, { v: { findings: [{ title: "A", detail: "d" }] } })
    const result = await synthesizeNode.execute(ctx)
    expect((result.output as { citations: string[] }).citations).toEqual([])
  })

  it("truncates a very long report in the chat message", async () => {
    const long = "x".repeat(5000)
    dispatchStructuredMock.mockResolvedValue({ value: { report: long }, teammateId: "tm1" })
    const { ctx, addMessage } = makeCtx({ objective: "x" })
    await synthesizeNode.execute(ctx)
    const msg = addMessage.mock.calls[0][0] as { content: string }
    expect(msg.content.length).toBeLessThan(long.length)
    expect(msg.content.endsWith("…")).toBe(true)
  })

  it("throws when objective is missing", async () => {
    const { ctx } = makeCtx({})
    await expect(synthesizeNode.execute(ctx)).rejects.toThrow(/objective/)
  })
})
