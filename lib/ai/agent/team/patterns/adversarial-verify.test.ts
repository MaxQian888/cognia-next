import { adversarialVerifyNode, type VerifiedFinding } from "./adversarial-verify"
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
    concurrency: { get: () => 8 },
  } as unknown as TeamRunContext)
  return {
    runId: "run1",
    stepId: "verify1",
    params,
    upstream,
    signal: new AbortController().signal,
    log: jest.fn(),
  } as unknown as StepExecutionContext
}

beforeEach(() => jest.clearAllMocks())
afterEach(() => __resetTeamRunContextForTesting())

describe("pattern.adversarial-verify", () => {
  it("kills a finding on majority refute and keeps one with majority confirm", async () => {
    // finding 0: 3 skeptics → real, real, refute → survives (2>1)
    // finding 1: 3 skeptics → refute, refute, real → killed (1<2)
    dispatchStructuredMock
      .mockResolvedValueOnce({ value: { real: true, reasoning: "x" } })
      .mockResolvedValueOnce({ value: { real: true, reasoning: "x" } })
      .mockResolvedValueOnce({ value: { real: false, reasoning: "x" } })
      .mockResolvedValueOnce({ value: { real: false, reasoning: "x" } })
      .mockResolvedValueOnce({ value: { real: false, reasoning: "x" } })
      .mockResolvedValueOnce({ value: { real: true, reasoning: "x" } })

    const ctx = makeCtx({
      objective: "audit",
      skepticsPerFinding: 3,
      findings: [
        { id: "f0", title: "Real bug", detail: "d" },
        { id: "f1", title: "False alarm", detail: "d" },
      ],
    })
    const result = await adversarialVerifyNode.execute(ctx)

    expect(dispatchStructuredMock).toHaveBeenCalledTimes(6)
    const out = result.output as { findings: { id: string }[]; killed: { id: string }[] }
    expect(out.findings.map((f) => f.id)).toEqual(["f0"])
    expect(out.killed.map((f) => f.id)).toEqual(["f1"])
  })

  it("reads findings from upstream when no param findings", async () => {
    dispatchStructuredMock.mockResolvedValue({ value: { real: true, reasoning: "x" } })
    const ctx = makeCtx(
      { objective: "x", skepticsPerFinding: 1 },
      { sweep: { findings: [{ title: "U", detail: "d" }] } }
    )
    const result = await adversarialVerifyNode.execute(ctx)
    expect((result.output as { findings: unknown[] }).findings).toHaveLength(1)
  })

  it("assigns one skeptic per lens when lenses are set", async () => {
    dispatchStructuredMock.mockResolvedValue({ value: { real: true, reasoning: "x" } })
    const ctx = makeCtx({
      objective: "x",
      lenses: ["correctness", "security", "repro"],
      findings: [{ id: "f0", title: "B", detail: "d" }],
    })
    await adversarialVerifyNode.execute(ctx)
    // 1 finding × 3 lenses = 3 skeptics
    expect(dispatchStructuredMock).toHaveBeenCalledTimes(3)
  })

  it("kills a finding whose skeptics all errored (tie at 0)", async () => {
    dispatchStructuredMock.mockRejectedValue(new Error("verifier boom"))
    const ctx = makeCtx({
      objective: "x",
      skepticsPerFinding: 2,
      findings: [{ id: "f0", title: "B", detail: "d" }],
    })
    const result = await adversarialVerifyNode.execute(ctx)
    const out = result.output as {
      findings: unknown[]
      killed: unknown[]
      verified: VerifiedFinding[]
    }
    expect(out.findings).toHaveLength(0)
    expect(out.killed).toHaveLength(1)
    expect(out.verified[0].survives).toBe(false)
  })

  it("returns empty when there are no findings", async () => {
    const ctx = makeCtx({ objective: "x", skepticsPerFinding: 3 })
    const result = await adversarialVerifyNode.execute(ctx)
    expect((result.output as { findings: unknown[] }).findings).toHaveLength(0)
    expect(dispatchStructuredMock).not.toHaveBeenCalled()
  })
})
