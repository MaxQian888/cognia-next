const waitForDecisionMock = jest.fn()
jest.mock("@/lib/runtime/approval-bus", () => ({
  waitForDecision: (...args: unknown[]) => waitForDecisionMock(...args),
}))

import { awaitReplanApproval } from "./replan-gate"
import { continueDecision, type ReplanDecision } from "./replan-schema"
import type { TeamNotifier } from "./team-notifier"
import type { ApprovalDecision } from "@/lib/runtime/approval-bus"

function makeNotifier() {
  const notify = jest.fn()
  const notifier = { notify, suspend: jest.fn(), resume: jest.fn() } as unknown as TeamNotifier
  return { notifier, notify }
}

const decision: ReplanDecision = {
  action: "inject",
  reasoning: "add a verifier",
  newTasks: [{ title: "Verify", description: "check", dependsOn: [] }],
  cancelTaskIds: [],
  reorderTaskIds: [],
}

describe("awaitReplanApproval", () => {
  it("opens a replan gate and returns approved with the original decision", async () => {
    const { notifier, notify } = makeNotifier()
    const out = await awaitReplanApproval({
      notifier,
      runId: "run1",
      teamId: "team1",
      decision,
      waitFn: async () => ({ outcome: "approve" }) as ApprovalDecision,
    })

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "critical",
        openApproval: { scope: "agent-team-replan", id: "run1" },
      })
    )
    expect(out.approved).toBe(true)
    expect(out.decision).toEqual(decision)
  })

  it("prefers a valid edited decision payload from the operator", async () => {
    const { notifier } = makeNotifier()
    const edited = continueDecision("operator overruled")
    const out = await awaitReplanApproval({
      notifier,
      runId: "run1",
      teamId: "team1",
      decision,
      waitFn: async () => ({ outcome: "approve", plan: edited }) as ApprovalDecision,
    })
    expect(out.approved).toBe(true)
    expect(out.decision.action).toBe("continue")
    expect(out.decision.reasoning).toBe("operator overruled")
  })

  it("ignores a malformed edited payload and keeps the lead decision", async () => {
    const { notifier } = makeNotifier()
    const out = await awaitReplanApproval({
      notifier,
      runId: "run1",
      teamId: "team1",
      decision,
      waitFn: async () => ({ outcome: "approve", plan: { bogus: true } }) as ApprovalDecision,
    })
    expect(out.decision).toEqual(decision)
  })

  it("skips the gate on a headless behavior — info notify, no modal, original plan", async () => {
    const { notifier, notify } = makeNotifier()
    const waitFn = jest.fn(async () => ({ outcome: "approve" }) as ApprovalDecision)
    const out = await awaitReplanApproval({
      notifier,
      runId: "run1",
      teamId: "team1",
      decision,
      behavior: "auto-reject",
      waitFn,
    })
    expect(waitFn).not.toHaveBeenCalled()
    expect(out.approved).toBe(false)
    expect(out.decision).toEqual(decision)
    const payload = notify.mock.calls[0][0] as { level: string; openApproval?: unknown }
    expect(payload.level).toBe("info")
    expect(payload.openApproval).toBeUndefined()
  })

  it("returns not-approved on reject (proceed with original plan)", async () => {
    const { notifier } = makeNotifier()
    const out = await awaitReplanApproval({
      notifier,
      runId: "run1",
      teamId: "team1",
      decision,
      waitFn: async () => ({ outcome: "reject", feedback: "no" }) as ApprovalDecision,
    })
    expect(out.approved).toBe(false)
    expect(out.decision).toEqual(decision)
  })

  it("falls back to the approval-bus waiter when no waitFn is injected", async () => {
    const { notifier } = makeNotifier()
    waitForDecisionMock.mockResolvedValueOnce({ outcome: "approve" })
    const out = await awaitReplanApproval({
      notifier,
      runId: "run1",
      teamId: "team1",
      decision,
    })
    expect(waitForDecisionMock).toHaveBeenCalledWith(
      { scope: "agent-team-replan", id: "run1" },
      undefined
    )
    expect(out.approved).toBe(true)
  })

  it("propagates an abort from the waiter", async () => {
    const { notifier } = makeNotifier()
    await expect(
      awaitReplanApproval({
        notifier,
        runId: "run1",
        teamId: "team1",
        decision,
        waitFn: async () => {
          throw new Error("Aborted")
        },
      })
    ).rejects.toThrow("Aborted")
  })
})
