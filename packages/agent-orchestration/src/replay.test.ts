import { contractChild, contractRun } from "./store-contract"
import type { AgentTeamCheckpoint, AgentTeamTrajectoryEvent } from "./records"
import {
  CHILD_ADMISSION_WAITING_REASON,
  isChildReplaySafe,
  ownsDispatchAttempt,
  planDispatchAttempt,
} from "./replay"

function checkpoint(overrides: Partial<AgentTeamCheckpoint> = {}): AgentTeamCheckpoint {
  return {
    id: "cp",
    runId: "run-1",
    childRunId: "child-1",
    trajectorySequence: 3,
    decisionVersion: 0,
    replay: "safe",
    sideEffects: [],
    createdAt: 1,
    ...overrides,
  }
}

function event(sequence: number, kind: AgentTeamTrajectoryEvent["kind"], childRunId = "child-1") {
  return {
    id: `run-1:${sequence}`,
    runId: "run-1",
    childRunId,
    sequence,
    kind,
    correlationId: "c",
    createdAt: sequence,
  }
}

describe("isChildReplaySafe", () => {
  it("allows replay from a safe checkpoint with no later remote work", () => {
    expect(
      isChildReplaySafe("child-1", checkpoint(), [
        event(2, "remote_event"),
        event(4, "tool_result"),
      ])
    ).toBe(true)
  })

  it("refuses without a checkpoint, for another child, or when not marked safe", () => {
    expect(isChildReplaySafe("child-1", undefined, [])).toBe(false)
    expect(isChildReplaySafe("child-1", checkpoint({ childRunId: "child-2" }), [])).toBe(false)
    expect(isChildReplaySafe("child-1", checkpoint({ replay: "needs_input" }), [])).toBe(false)
  })

  it("refuses when a side effect has an unknown outcome or an unsafe intent", () => {
    const unknown = checkpoint({
      sideEffects: [{ id: "s", kind: "push", state: "unknown", replay: "safe" }],
    })
    const unsafeIntent = checkpoint({
      sideEffects: [{ id: "s", kind: "push", state: "intent", replay: "unsafe" }],
    })
    const safeIntent = checkpoint({
      sideEffects: [{ id: "s", kind: "read", state: "intent", replay: "safe" }],
    })
    expect(isChildReplaySafe("child-1", unknown, [])).toBe(false)
    expect(isChildReplaySafe("child-1", unsafeIntent, [])).toBe(false)
    expect(isChildReplaySafe("child-1", safeIntent, [])).toBe(true)
  })

  it("refuses when this child recorded remote work after the checkpoint", () => {
    expect(isChildReplaySafe("child-1", checkpoint(), [event(5, "remote_event")])).toBe(false)
    // Another child's remote work does not count.
    expect(isChildReplaySafe("child-1", checkpoint(), [event(5, "remote_event", "child-2")])).toBe(
      true
    )
  })
})

describe("planDispatchAttempt", () => {
  it("refuses a parked child", () => {
    for (const status of ["pausing", "paused", "sleeping", "needs_input"] as const) {
      expect(planDispatchAttempt(contractChild({ status }), contractRun())).toEqual({
        kind: "conflict",
        reason: `Child is not accepting dispatch while ${status}`,
      })
    }
  })

  it("refuses a child that is running or waiting for admission", () => {
    expect(planDispatchAttempt(contractChild({ status: "running" }), contractRun())).toMatchObject({
      kind: "conflict",
      reason: "Child already has an active dispatch",
    })
    expect(
      planDispatchAttempt(
        contractChild({ status: "queued", waitingReason: CHILD_ADMISSION_WAITING_REASON }),
        contractRun()
      )
    ).toMatchObject({ kind: "conflict" })
  })

  it("refuses when the run is not accepting dispatch", () => {
    expect(planDispatchAttempt(undefined, undefined)).toEqual({
      kind: "conflict",
      reason: "Run is not accepting dispatch",
    })
    expect(planDispatchAttempt(undefined, contractRun({ status: "paused" }))).toMatchObject({
      kind: "conflict",
    })
  })

  it("resumes an unfinished child under the next attempt, keeping failures and the retry host", () => {
    const failed = contractChild({
      status: "failed",
      attempt: 2,
      waitingReason: "retry_host:host-b",
      resourceUsage: { ...contractChild().resourceUsage, failures: 2 },
    })
    expect(planDispatchAttempt(failed, contractRun({ status: "recovering" }))).toEqual({
      kind: "resume",
      child: failed,
      attempt: 3,
      previousFailures: 2,
      retryTargetHostRef: "host-b",
    })
  })

  it("starts fresh at attempt 1 when there is no child or the last one finished", () => {
    expect(planDispatchAttempt(undefined, contractRun())).toEqual({ kind: "fresh", attempt: 1 })
    expect(planDispatchAttempt(contractChild({ status: "completed" }), contractRun())).toEqual({
      kind: "fresh",
      attempt: 1,
    })
  })
})

describe("ownsDispatchAttempt", () => {
  it("fences out every attempt but the current one", () => {
    expect(ownsDispatchAttempt(contractChild({ attempt: 3 }), 3)).toBe(true)
    expect(ownsDispatchAttempt(contractChild({ attempt: 4 }), 3)).toBe(false)
    expect(ownsDispatchAttempt(undefined, 1)).toBe(false)
  })
})
