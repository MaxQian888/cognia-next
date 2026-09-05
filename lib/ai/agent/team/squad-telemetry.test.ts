import {
  __resetAgentTraceEmitterForTesting,
  __setAgentTraceNowForTesting,
  setAgentTraceWriter,
} from "@cognia/agent-trace/emitter"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import {
  __resetSquadTelemetryForTesting,
  beginSquadReviewSpan,
  endSquadReviewSpan,
  endSquadRunSpan,
  recordSquadDispatchLatency,
  recordSquadDuplicateControl,
  recordSquadRecoveryOutcome,
  squadDuplicateControlCount,
  squadRunTraceId,
  startSquadRunSpan,
} from "./squad-telemetry"

describe("squad telemetry", () => {
  let written: AgentTraceSpan[]
  let clock: number

  beforeEach(() => {
    written = []
    clock = 10_000
    __resetAgentTraceEmitterForTesting()
    __resetSquadTelemetryForTesting()
    __setAgentTraceNowForTesting(() => clock)
    setAgentTraceWriter((span) => written.push(span as unknown as AgentTraceSpan))
  })

  afterEach(() => {
    setAgentTraceWriter(null)
    __setAgentTraceNowForTesting(null)
  })

  const now = () => clock

  it("opens one root span per run and reuses it", () => {
    const first = startSquadRunSpan({ runId: "r1", teamId: "t1", origin: "chat", now })
    const second = startSquadRunSpan({ runId: "r1", teamId: "t1", now })
    expect(second).toEqual(first)
    expect(squadRunTraceId("r1")).toBe(first.traceId)
    expect(written).toEqual([])
  })

  it("nests a review under the root and records its wait and outcome", () => {
    const root = startSquadRunSpan({ runId: "r1", teamId: "t1", now })
    beginSquadReviewSpan({
      runId: "r1",
      teamId: "t1",
      interruptId: "i1",
      kind: "budget_extension",
      now,
    })
    clock += 4_500
    const wait = endSquadReviewSpan({
      interruptId: "i1",
      outcome: "approve",
      source: "device",
      now,
    })
    expect(wait).toBe(4_500)
    expect(written).toHaveLength(1)
    const span = written[0]!
    expect(span.traceId).toBe(root.traceId)
    expect(span.parentSpanId).toBe(root.spanId)
    expect(span.metadata).toMatchObject({
      role: "squad-review",
      reviewKind: "budget_extension",
      outcome: "approve",
      gateWaitMs: 4_500,
      source: "device",
    })
    // Second settle of the same interrupt is a no-op.
    expect(endSquadReviewSpan({ interruptId: "i1", outcome: "deny", now })).toBeUndefined()
  })

  it("records dispatch latency, recovery and duplicate controls as events on the root", () => {
    startSquadRunSpan({ runId: "r1", teamId: "t1", now })
    expect(
      recordSquadDispatchLatency({
        runId: "r1",
        childRunId: "c1",
        latencyMs: 250,
        hostRef: "h",
        now,
      })
    ).toBe(true)
    expect(
      recordSquadRecoveryOutcome({ runId: "r1", choice: "retry_same_host", applied: true, now })
    ).toBe(true)
    expect(recordSquadDuplicateControl({ runId: "r1", action: "pause", now })).toBe(1)
    expect(recordSquadDuplicateControl({ runId: "r1", action: "pause", now })).toBe(2)
    expect(squadDuplicateControlCount("r1")).toBe(2)

    endSquadRunSpan({
      runId: "r1",
      terminalStatus: "completed",
      usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 },
      duplicateControls: squadDuplicateControlCount("r1"),
    })
    expect(written).toHaveLength(1)
    const root = written[0]!
    expect(root.events?.map((event) => event.name)).toEqual([
      "squad.dispatch",
      "squad.recovery",
      "squad.duplicate_control",
      "squad.duplicate_control",
    ])
    expect(root.events?.[0]?.attributes).toEqual({ childRunId: "c1", latencyMs: 250, hostRef: "h" })
    expect(root.metadata).toMatchObject({ terminalStatus: "completed", duplicateControls: 2 })
    expect(root.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 })
  })

  it("a failed run closes with its reason code as the error type", () => {
    startSquadRunSpan({ runId: "r1", teamId: "t1", now })
    endSquadRunSpan({ runId: "r1", terminalStatus: "failed", terminalReason: "delivery_failed" })
    expect(written[0]?.errorType).toBe("delivery_failed")
    expect(written[0]?.finishReasons).toEqual(["failed"])
    // Closing again is a no-op: the root is gone.
    endSquadRunSpan({ runId: "r1", terminalStatus: "failed" })
    expect(written).toHaveLength(1)
  })

  it("dispatch latency without a root is dropped, recovery without a root emits its own span", () => {
    expect(recordSquadDispatchLatency({ runId: "ghost", childRunId: "c", latencyMs: 1, now })).toBe(
      false
    )
    expect(
      recordSquadRecoveryOutcome({
        runId: "ghost",
        choice: "terminate",
        applied: false,
        reason: "control_refused",
        now,
      })
    ).toBe(true)
    expect(written).toHaveLength(1)
    expect(written[0]?.metadata).toMatchObject({
      role: "squad-recovery",
      choice: "terminate",
      applied: false,
      reason: "control_refused",
    })
  })

  it("carries no free text: every attribute is an id, a code, a count or a duration", () => {
    startSquadRunSpan({ runId: "r1", teamId: "t1", projectId: "p1", origin: "chat", now })
    beginSquadReviewSpan({ runId: "r1", interruptId: "i1", kind: "plan", now })
    endSquadReviewSpan({ interruptId: "i1", outcome: "deny", now })
    endSquadRunSpan({ runId: "r1", terminalStatus: "cancelled", terminalReason: "operator_stop" })
    for (const span of written) {
      expect(span.inputPreview).toBeUndefined()
      expect(span.outputPreview).toBeUndefined()
      for (const value of Object.values(span.metadata ?? {})) {
        expect(["string", "number", "boolean"]).toContain(typeof value)
        if (typeof value === "string") expect(value).not.toMatch(/\s/)
      }
    }
  })
})
