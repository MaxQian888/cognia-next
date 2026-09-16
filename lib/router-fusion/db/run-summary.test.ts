import type { FusionRunEventRow, FusionRunRow } from "./types"
import { fusionRunSummaryOf } from "./run-summary"

function run(overrides: Partial<FusionRunRow> = {}): FusionRunRow {
  return {
    runId: "run-1",
    mode: "cascade",
    actionId: "cascade_schema",
    ruleId: "R1_explicit_mode",
    status: "succeeded",
    roleDeployments: { cheap: "openai::gpt-5-mini", strong: "openai::gpt-5" },
    budget: { capMicrousd: 1_000_000, spentMicrousd: 4_200, modelCalls: 2 },
    costStatus: "actual",
    error: null,
    ...overrides,
  } as FusionRunRow
}

function event(seq: number, type: string, payload: Record<string, unknown>): FusionRunEventRow {
  return { runId: "run-1", seq, type, payload, createdAt: 1_000 + seq }
}

describe("fusionRunSummaryOf", () => {
  it("summarizes the run and its journal without anything a model wrote", () => {
    const summary = fusionRunSummaryOf(run(), [
      event(1, "phase.changed", { phase: "cascade", step: "cheap" }),
      event(2, "phase.changed", { phase: "cascade", step: "escalate", reason: "FORMAT_INVALID" }),
      event(3, "answer.completed", {
        quality_status: "accepted",
        verification_status: "passed",
        verification_level: "tool_verified",
      }),
    ])
    expect(summary).toEqual({
      runId: "run-1",
      mode: "cascade",
      actionId: "cascade_schema",
      ruleId: "R1_explicit_mode",
      status: "succeeded",
      qualityStatus: "accepted",
      roles: { cheap: "openai::gpt-5-mini", strong: "openai::gpt-5" },
      capMicrousd: 1_000_000,
      spentMicrousd: 4_200,
      modelCalls: 2,
      costStatus: "actual",
      errorCode: null,
      timeline: expect.objectContaining({
        escalated: { reason: "FORMAT_INVALID" },
        verification: { status: "passed", level: "tool_verified" },
        phases: [
          { phase: "cascade", step: "cheap", at: 1_001 },
          { phase: "cascade", step: "escalate", at: 1_002 },
        ],
      }),
    })
  })

  it("carries a failed run's code and no quality it never reached", () => {
    const summary = fusionRunSummaryOf(
      run({
        mode: "panel",
        status: "failed",
        error: { code: "FUSION_INSUFFICIENT_CANDIDATES", message: "x" },
      }),
      []
    )
    expect(summary).toMatchObject({
      mode: "panel",
      status: "failed",
      qualityStatus: null,
      errorCode: "FUSION_INSUFFICIENT_CANDIDATES",
    })
  })
})
