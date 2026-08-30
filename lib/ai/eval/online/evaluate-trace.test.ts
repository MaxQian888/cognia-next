import { builtInEvaluatorVersionId, type OnlineEvalPolicyV1 } from "@cognia/eval-core"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import {
  evaluateTraceDeterministically,
  resolveDeterministicScorers,
  traceToEvalInput,
} from "./evaluate-trace"

function span(overrides: Partial<AgentTraceSpan> = {}): AgentTraceSpan {
  return {
    id: "root",
    traceId: "t1",
    spanId: "root",
    sessionId: "s1",
    surface: "chat",
    operationName: "chat",
    providerName: "anthropic",
    startTime: 100,
    endTime: 400,
    status: "ok",
    ...overrides,
  } as AgentTraceSpan
}

function toolSpan(name: string, index: number): AgentTraceSpan {
  return span({
    id: `tool-${index}`,
    spanId: `tool-${index}`,
    parentSpanId: "root",
    operationName: "execute_tool",
    toolName: name,
    startTime: 200 + index,
  })
}

function policy(ids: string[]): OnlineEvalPolicyV1 {
  return {
    schema: "cognia-online-eval-policy/v1",
    id: "p1",
    versionId: "p1@1",
    name: "n",
    enabled: true,
    shadow: false,
    selector: {},
    deterministicEvaluatorVersionIds: ids,
    judgeEvaluatorVersionIds: [],
    sampling: { judgeRate: 0.05, judgeDailyMax: 200 },
    budget: { dailyUsdCap: 5 },
    escalation: {
      thresholdBand: 0.1,
      onEvaluatorConflict: true,
      onJudgeParseFailure: true,
      onNegativeFeedback: true,
    },
    createdAt: 0,
    updatedAt: 0,
  }
}

describe("traceToEvalInput", () => {
  it("returns undefined for an empty trace rather than an empty case", () => {
    expect(traceToEvalInput([], "t1")).toBeUndefined()
  })

  it("labels the case `real-trace` and keeps the originating trace id", () => {
    // The promotion path has to be able to tell a captured trace from a
    // handwritten case; guessing later is not possible.
    const prepared = traceToEvalInput([span()], "t1")
    expect(prepared?.evalCase).toMatchObject({
      id: "trace:t1",
      source: "real-trace",
      sourceTraceId: "t1",
      capability: "chat",
    })
  })

  it("reads an empty answer when content capture is off, without inventing one", () => {
    expect(traceToEvalInput([span()], "t1")?.sample.output).toBe("")
    expect(traceToEvalInput([span({ outputPreview: "hello" })], "t1")?.sample.output).toBe("hello")
  })

  it("recovers the tool trajectory from child spans, which content capture does not gate", () => {
    const prepared = traceToEvalInput([span(), toolSpan("Read", 0), toolSpan("Write", 1)], "t1")
    expect(prepared?.sample.toolCalls.map((call) => call.name)).toEqual(["Read", "Write"])
  })
})

describe("resolveDeterministicScorers", () => {
  it("resolves built-in version ids to catalog scorers", () => {
    const scorers = resolveDeterministicScorers(
      policy([builtInEvaluatorVersionId("tool-selection"), builtInEvaluatorVersionId("tool-order")])
    )
    expect(scorers.map((scorer) => scorer.id).sort()).toEqual(["tool-order", "tool-selection"])
  })

  it("evaluates LESS on an unknown id, never silently more", () => {
    // `selectScorers` treats an empty id list as "all", so dropping unknowns
    // without this guard would turn one bad id into the full scorer suite.
    expect(resolveDeterministicScorers(policy(["builtin:not-a-scorer@1"]))).toEqual([])
    expect(resolveDeterministicScorers(policy([]))).toEqual([])
  })
})

describe("evaluateTraceDeterministically", () => {
  const run = (spans: AgentTraceSpan[], ids: string[]) =>
    evaluateTraceDeterministically({
      policy: policy(ids),
      traceId: "t1",
      spans,
      now: 500,
      newId: (evaluatorId) => `obs_${evaluatorId}`,
    })

  it("reports a reference-less trace as UNGRADED rather than passing it", async () => {
    // A production trace carries no golden answer, so every reference-based
    // scorer is `not-applicable`. Counting that as a pass is exactly the bug
    // `ScoreStatus` exists to prevent.
    const result = await run(
      [span(), toolSpan("Read", 0)],
      [builtInEvaluatorVersionId("tool-selection")]
    )
    expect(result.observations).toHaveLength(1)
    expect(result.observations[0].score.status).toBe("not-applicable")
    expect(result.graded).toBe(false)
  })

  it("stamps every observation as online and scoped to the trace", async () => {
    const result = await run([span()], [builtInEvaluatorVersionId("tool-redundancy")])
    expect(result.observations[0]).toMatchObject({
      schema: "cognia-observation/v1",
      origin: "online",
      evaluatorVersionId: "builtin:tool-redundancy@1",
      scope: { traceId: "t1", caseId: "trace:t1" },
      createdAt: 500,
    })
  })

  it("produces nothing for an empty trace", async () => {
    const result = await run([], [builtInEvaluatorVersionId("tool-selection")])
    expect(result).toEqual({ observations: [], graded: false })
  })

  it("grades when a scorer can actually decide", async () => {
    // `tool-redundancy` needs no reference — it reads the trajectory alone —
    // so this is the shape of a real online verdict.
    const result = await run(
      [span(), toolSpan("Read", 0), toolSpan("Read", 1)],
      [builtInEvaluatorVersionId("tool-redundancy")]
    )
    expect(["scored", "measurement"]).toContain(result.observations[0].score.status)
  })
})
