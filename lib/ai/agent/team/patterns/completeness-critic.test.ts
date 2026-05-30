import { completenessCriticNode } from "./completeness-critic"
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
  } as unknown as TeamRunContext)
  return {
    runId: "run1",
    stepId: "critic1",
    params,
    upstream,
    signal: new AbortController().signal,
    log: jest.fn(),
  } as unknown as StepExecutionContext
}

beforeEach(() => jest.clearAllMocks())
afterEach(() => __resetTeamRunContextForTesting())

describe("pattern.completeness-critic", () => {
  it("returns gaps from a single critic dispatch", async () => {
    dispatchStructuredMock.mockResolvedValue({
      value: { gaps: [{ description: "no perf angle", suggestedSearch: "profile" }] },
    })
    const ctx = makeCtx({ objective: "audit" }, { v: { findings: [{ title: "A", detail: "d" }] } })
    const result = await completenessCriticNode.execute(ctx)

    expect(dispatchStructuredMock).toHaveBeenCalledTimes(1)
    expect((result.output as { gaps: unknown[] }).gaps).toHaveLength(1)
  })

  it("handles the empty-findings case", async () => {
    dispatchStructuredMock.mockResolvedValue({ value: { gaps: [] } })
    const ctx = makeCtx({ objective: "audit" })
    const result = await completenessCriticNode.execute(ctx)
    expect((result.output as { gaps: unknown[] }).gaps).toEqual([])
    const promptArg = dispatchStructuredMock.mock.calls[0][1] as { prompt: string }
    expect(promptArg.prompt).toContain("no findings were produced")
  })

  it("uses explicit param findings over the upstream map", async () => {
    dispatchStructuredMock.mockResolvedValue({ value: { gaps: [] } })
    const ctx = makeCtx(
      { objective: "x", findings: [{ title: "P", detail: "d" }] },
      {
        v: { findings: [{ title: "U", detail: "d" }] },
      }
    )
    await completenessCriticNode.execute(ctx)
    const prompt = (dispatchStructuredMock.mock.calls[0][1] as { prompt: string }).prompt
    expect(prompt).toContain("P")
    expect(prompt).not.toContain("- U:")
  })

  it("throws when objective is missing", async () => {
    const ctx = makeCtx({})
    await expect(completenessCriticNode.execute(ctx)).rejects.toThrow(/objective/)
  })
})
