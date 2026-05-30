import { multiModalSweepNode } from "./multi-modal-sweep"
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
  registerTeamRunContext({
    runId: "run1",
    teamId: "team1",
    concurrency: { get: () => 4 },
    storeWriter: { addMessage: jest.fn(), setTaskStatus: jest.fn(), updateTeammate: jest.fn() },
  } as unknown as TeamRunContext)
  return {
    runId: "run1",
    stepId: "sweep1",
    workflowId: "wf1",
    params,
    upstream,
    signal: new AbortController().signal,
    log: jest.fn(),
    resolveSecret: jest.fn(),
    trigger: {},
  } as unknown as StepExecutionContext
}

beforeEach(() => jest.clearAllMocks())
afterEach(() => __resetTeamRunContextForTesting())

describe("pattern.multi-modal-sweep", () => {
  it("runs one finder per modality and returns the deduped union", async () => {
    dispatchStructuredMock
      .mockResolvedValueOnce({
        value: { findings: [{ title: "A", detail: "d", location: "x:1" }] },
      })
      .mockResolvedValueOnce({
        value: {
          findings: [
            { title: "A2", detail: "d", location: "x:1" }, // dup location → collapsed
            { title: "B", detail: "e", location: "y:2" },
          ],
        },
      })

    const ctx = makeCtx({
      teamId: "team1",
      objective: "find bugs",
      modalities: ["by-file", "by-call"],
    })
    const result = await multiModalSweepNode.execute(ctx)

    expect(dispatchStructuredMock).toHaveBeenCalledTimes(2)
    const findings = (result.output as { findings: unknown[] }).findings
    expect(findings).toHaveLength(2) // A + B, A2 deduped against A by location
    expect((result.output as { finderCount: number }).finderCount).toBe(2)
  })

  it("tolerates a finder failure and keeps the rest", async () => {
    dispatchStructuredMock
      .mockRejectedValueOnce(new Error("finder boom"))
      .mockResolvedValueOnce({ value: { findings: [{ title: "B", detail: "e" }] } })

    const ctx = makeCtx({ objective: "x", modalities: ["m1", "m2"] })
    const result = await multiModalSweepNode.execute(ctx)
    expect((result.output as { findings: unknown[] }).findings).toHaveLength(1)
    expect(ctx.log).toHaveBeenCalledWith("warn", expect.stringContaining("failed"))
  })

  it("throws when objective is missing", async () => {
    const ctx = makeCtx({ modalities: ["m1"] })
    await expect(multiModalSweepNode.execute(ctx)).rejects.toThrow(/objective/)
  })

  it("throws when no modalities are provided", async () => {
    const ctx = makeCtx({ objective: "x", modalities: [] })
    await expect(multiModalSweepNode.execute(ctx)).rejects.toThrow(/modalities/)
  })
})
