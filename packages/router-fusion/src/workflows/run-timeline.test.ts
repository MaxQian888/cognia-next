import {
  emptyRunTimeline,
  MAX_TIMELINE_PHASES,
  runTimelineOf,
  type TimelineEvent,
} from "./run-timeline"

let at = 0
function event(type: string, payload: Record<string, unknown> = {}): TimelineEvent {
  return { type, payload, at: ++at }
}

describe("runTimelineOf", () => {
  it("reads a panel's candidates, evidence and judge out of its journal", () => {
    const timeline = runTimelineOf([
      event("phase.changed", { from: "queued", to: "running" }),
      event("phase.changed", { phase: "prepare", members: 2, member_output_tokens: 1024 }),
      event("call.started", { logical_step_id: "panel:member:panel_a:1" }),
      event("call.started", { logical_step_id: "panel:member:panel_b:1" }),
      event("call.finished", { logical_step_id: "panel:member:panel_a:1", status: "succeeded" }),
      event("call.finished", { logical_step_id: "panel:member:panel_b:1", status: "unknown" }),
      event("phase.changed", { phase: "context", step: "compacted", epoch: 1 }),
      event("candidate.rejected", { role: "panel_a", scope: "evidence", rejected_refs: [] }),
      event("candidate.rejected", { role: "panel_b", scope: "candidate", reason: "CALL_FAILED" }),
      event("phase.changed", { phase: "panel", step: "candidates" }),
      event("phase.changed", { phase: "judge", candidates: 1 }),
      event("phase.changed", {
        phase: "judge",
        step: "reported",
        supported: 3,
        rejected: 1,
        unverified: 2,
        contradictions: 1,
        unresolved: 0,
      }),
      event("run.degraded", { reason: "FUSION_INSUFFICIENT_CANDIDATES" }),
      event("verification.completed", { status: "passed", level: "mixed" }),
    ])
    expect(timeline.phases.map((p) => [p.phase, p.step])).toEqual([
      ["prepare", null],
      ["context", "compacted"],
      ["panel", "candidates"],
      ["judge", null],
      ["judge", "reported"],
    ])
    expect(timeline).toMatchObject({
      calls: { started: 2, finished: 2, unknown: 1 },
      candidates: { members: 2, rejected: 1, evidenceRejected: 1 },
      judge: { supported: 3, rejected: 1, unverified: 2, contradictions: 1, unresolved: 0 },
      degraded: { reason: "FUSION_INSUFFICIENT_CANDIDATES" },
      verification: { status: "passed", level: "mixed" },
      compactions: 1,
      escalated: null,
    })
  })

  it("reads a cascade's escalation and the sealed answer's verification", () => {
    const timeline = runTimelineOf([
      event("phase.changed", { phase: "cascade", step: "cheap" }),
      event("phase.changed", { phase: "verification", stage: "cheap" }),
      event("verification.completed", { stage: "cheap", status: "failed", level: "tool_verified" }),
      event("candidate.rejected", { stage: "cheap", reason: "VERIFICATION_FAILED" }),
      event("phase.changed", { phase: "cascade", step: "escalate", reason: "VERIFICATION_FAILED" }),
      event("phase.changed", { phase: "cascade", step: "strong" }),
      event("answer.completed", {
        verification_status: "passed",
        verification_level: "tool_verified",
      }),
    ])
    expect(timeline.escalated).toEqual({ reason: "VERIFICATION_FAILED" })
    expect(timeline.candidates.rejected).toBe(1)
    expect(timeline.verification).toEqual({ status: "passed", level: "tool_verified" })
    expect(timeline.phases.map((p) => p.step)).toEqual(["cheap", null, "escalate", "strong"])
  })

  it("reads a delegate's attempts, turns, tools, tier, approvals and delivery, idempotently", () => {
    const run = [
      event("phase.changed", { phase: "delegate", step: "plan" }),
      event("phase.changed", { phase: "delegate", step: "planned", subtasks: 2 }),
      event("phase.changed", { phase: "delegate", step: "attempt", attempt: 1, kind: "work" }),
      event("phase.changed", { phase: "delegate", step: "turn", attempt: 1, turn: 1 }),
      event("phase.changed", {
        phase: "delegate",
        step: "tools",
        attempt: 1,
        turn: 1,
        admitted: 2,
      }),
      event("approval.required", {
        approval_id: "ap-1",
        kind: "scope_expansion",
        request_digest: "d1",
      }),
      event("phase.changed", {
        phase: "delegate",
        step: "waiting_for_approval",
        kind: "scope_expansion",
      }),
    ]
    const parked = runTimelineOf(run)
    expect(parked.delegate).toMatchObject({
      subtasks: { planned: 2, completed: 0 },
      attempts: 1,
      workerTurns: 1,
      toolOperations: 2,
      approvals: { requested: 1, pending: { kind: "scope_expansion" } },
      delivery: null,
    })

    // The resumed run replays its graph: the same events again, then the rest.
    const resumed = runTimelineOf([
      ...run,
      ...run.slice(0, 4),
      event("phase.changed", {
        phase: "delegate",
        step: "approval_resolved",
        approval_id: "ap-1",
        status: "approved",
      }),
      event("phase.changed", { phase: "delegate", step: "turn", attempt: 1, turn: 2 }),
      event("phase.changed", { phase: "delegate", step: "staged", attempt: 1, files: 2 }),
      event("phase.changed", { phase: "delegate", step: "subtask_done", subtask: 1 }),
      event("phase.changed", { phase: "delegate", step: "subtask_done", subtask: 1 }),
      event("phase.changed", { phase: "delegate", step: "subtask_done", subtask: 2 }),
      event("verification.completed", { status: "failed", level: "tool_verified", tier: "os" }),
      event("phase.changed", { phase: "delegate", step: "repair", attempt: 2 }),
      event("phase.changed", { phase: "delegate", step: "attempt", attempt: 2, kind: "repair" }),
      event("phase.changed", { phase: "delegate", step: "turn", attempt: 2, turn: 1 }),
      event("phase.changed", { phase: "delegate", step: "attempt", attempt: 3, kind: "takeover" }),
      event("phase.changed", { phase: "delegate", step: "turn", attempt: 3, turn: 1 }),
      event("approval.required", {
        approval_id: "ap-2",
        kind: "workspace_apply",
        request_digest: "d2",
      }),
      event("phase.changed", {
        phase: "delegate",
        step: "delivered",
        delivery: "workspace_updated",
        files: 3,
      }),
    ])
    expect(resumed.delegate).toEqual({
      subtasks: { planned: 2, completed: 2 },
      attempts: 3,
      repairs: 1,
      takeovers: 1,
      workerTurns: 4,
      toolOperations: 2,
      sandboxTier: "os",
      patchFiles: 3,
      delivery: "workspace_updated",
      approvals: { requested: 2, pending: null },
    })
    // Other modes carry no delegate part.
    expect(
      runTimelineOf([event("phase.changed", { phase: "cascade", step: "cheap" })]).delegate
    ).toBeNull()
    // Malformed delegate payloads count nothing.
    expect(
      runTimelineOf([
        event("phase.changed", { phase: "delegate", step: "turn", attempt: 0, turn: "x" }),
        event("phase.changed", { phase: "delegate", step: "attempt", attempt: 1 }),
        event("phase.changed", { phase: "delegate", step: "tools", attempt: 1 }),
        event("approval.required", {}),
      ]).delegate
    ).toMatchObject({
      subtasks: { planned: null, completed: 0 },
      attempts: 0,
      workerTurns: 0,
      toolOperations: 0,
      approvals: { requested: 0, pending: null },
    })
  })

  it("keeps only the newest phases and ignores what it cannot read", () => {
    const many = Array.from({ length: MAX_TIMELINE_PHASES + 6 }, (_, i) =>
      event("phase.changed", { phase: "panel", step: `step-${i}` })
    )
    const timeline = runTimelineOf([
      ...many,
      event("phase.changed", { phase: 42 }),
      event("verification.completed", { status: "passed" }),
      event("phase.changed", { phase: "judge", step: "reported", supported: -1, rejected: "x" }),
    ])
    expect(timeline.phases).toHaveLength(MAX_TIMELINE_PHASES)
    expect(timeline.phases.at(-1)).toMatchObject({ phase: "judge", step: "reported" })
    expect(timeline.verification).toBeNull()
    expect(timeline.judge).toEqual({
      supported: 0,
      rejected: 0,
      unverified: 0,
      contradictions: 0,
      unresolved: 0,
    })
    expect(runTimelineOf([])).toEqual(emptyRunTimeline())
  })
})
