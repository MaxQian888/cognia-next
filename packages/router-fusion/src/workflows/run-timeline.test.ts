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
