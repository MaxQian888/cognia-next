import type { AgentTraceSpan } from "@/types/agent-trace/span"
import { AGENT_TRACE_SPAN_KIND } from "@/types/agent-trace/span"
import type { StructuredLogEntry } from "@/types/logging"
import type { OnlineEvalPolicyV1 } from "@cognia/eval-core"
interface EnqueueInput {
  id: string
  policyId: string
  policyVersionId: string
  traceId: string
  now: number
}

import {
  candidateFromSpan,
  createEvalOnlineTransport,
  isScorableRootSpan,
} from "./eval-online-transport"

function span(overrides: Partial<AgentTraceSpan> = {}): AgentTraceSpan {
  return {
    id: "span-1",
    traceId: "trace-1",
    spanId: "span-1",
    sessionId: "s1",
    surface: "chat",
    operationName: "chat",
    providerName: "anthropic",
    startTime: 0,
    status: "ok",
    ...overrides,
  } as AgentTraceSpan
}

function entry(
  value: AgentTraceSpan | undefined,
  kind: string = AGENT_TRACE_SPAN_KIND
): StructuredLogEntry {
  return {
    level: "info",
    message: "span",
    timestamp: new Date(0).toISOString(),
    data: { kind, span: value },
  } as unknown as StructuredLogEntry
}

function policy(overrides: Partial<OnlineEvalPolicyV1> = {}): OnlineEvalPolicyV1 {
  return {
    schema: "cognia-online-eval-policy/v1",
    id: "p1",
    versionId: "p1@1",
    name: "Chat quality",
    enabled: true,
    shadow: false,
    selector: {},
    deterministicEvaluatorVersionIds: ["det@1"],
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
    ...overrides,
  }
}

function harness(policies: OnlineEvalPolicyV1[] = [policy()]) {
  const enqueue = jest.fn(async (_input: EnqueueInput) => undefined)
  const transport = createEvalOnlineTransport({
    loadPolicies: () => policies,
    enqueue,
    now: () => 1_000,
  })
  return { transport, enqueue }
}

describe("isScorableRootSpan", () => {
  it("takes only the ROOT span, so one trace is not queued once per child", () => {
    expect(isScorableRootSpan(span())).toBe(true)
    expect(isScorableRootSpan(span({ parentSpanId: "parent" }))).toBe(false)
  })

  it("ignores a span that has not settled", () => {
    // `pending` has no verdict yet, and `incomplete` is the stale-span reaper —
    // the turn was abandoned, not answered.
    expect(isScorableRootSpan(span({ status: "pending" }))).toBe(false)
    expect(isScorableRootSpan(span({ status: "incomplete" }))).toBe(false)
    expect(isScorableRootSpan(span({ status: "error" }))).toBe(true)
  })
})

describe("candidateFromSpan", () => {
  it("carries ids, surface, model and operation — and no message content", () => {
    const candidate = candidateFromSpan(
      span({ projectId: "pr1", responseModel: "claude-opus-5", operationName: "chat" })
    )
    expect(candidate).toEqual({
      traceId: "trace-1",
      projectId: "pr1",
      surface: "chat",
      model: "claude-opus-5",
      operation: "chat",
    })
    expect(JSON.stringify(candidate)).not.toContain("Preview")
  })

  it("prefers the response model but falls back to the requested one", () => {
    expect(candidateFromSpan(span({ requestModel: "req-model" })).model).toBe("req-model")
    expect(candidateFromSpan(span({ requestModel: "req", responseModel: "resp" })).model).toBe(
      "resp"
    )
  })

  it("marks an errored turn priority, so it jumps the sampling rate", () => {
    expect(candidateFromSpan(span({ status: "error" })).priority).toBe(true)
    expect(candidateFromSpan(span()).priority).toBeUndefined()
  })
})

describe("EvalOnlineTransport", () => {
  it("enqueues one item per matching policy when a root trace finishes", () => {
    const { transport, enqueue } = harness([
      policy({ id: "a", versionId: "a@1" }),
      policy({ id: "b", versionId: "b@1" }),
    ])
    transport.log(entry(span()))
    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      policyId: "a",
      policyVersionId: "a@1",
      traceId: "trace-1",
      now: 1_000,
    })
  })

  it("ignores child spans, unsettled spans, and non-span entries", () => {
    const { transport, enqueue } = harness()
    transport.log(entry(span({ parentSpanId: "p" })))
    transport.log(entry(span({ status: "pending" })))
    transport.log(entry(undefined))
    transport.log(entry(span(), "some-other-kind"))
    expect(enqueue).not.toHaveBeenCalled()
  })

  it("does nothing at all when no policy is enabled", () => {
    // An unused feature must cost one lookup per finished trace, not a write.
    const { transport, enqueue } = harness([])
    transport.log(entry(span()))
    expect(enqueue).not.toHaveBeenCalled()
  })

  it("skips a policy whose selector does not match", () => {
    const { transport, enqueue } = harness([policy({ selector: { surfaces: ["workflow"] } })])
    transport.log(entry(span({ surface: "chat" })))
    expect(enqueue).not.toHaveBeenCalled()
  })

  it("never lets an enqueue failure escape into the turn that produced the trace", async () => {
    const enqueue = jest.fn(async () => {
      throw new Error("dexie is closed")
    })
    const transport = createEvalOnlineTransport({ loadPolicies: () => [policy()], enqueue })
    expect(() => transport.log(entry(span()))).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    const health = transport.getHealth()
    expect(health.droppedEntries).toBe(1)
    expect(health.droppedByReason).toEqual({ "ship-failed": 1 })
    expect(health.lastError).toContain("dexie is closed")
    expect(health.status).toBe("degraded")
  })

  it("reports a healthy snapshot and a running count once traces land", async () => {
    const { transport } = harness()
    transport.log(entry(span()))
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.getEnqueuedCount()).toBe(1)
    expect(transport.getHealth()).toMatchObject({
      transport: "eval-online",
      status: "healthy",
      droppedEntries: 0,
    })
  })
})
