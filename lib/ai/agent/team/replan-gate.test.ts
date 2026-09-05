const openSquadReviewMock = jest.fn()
jest.mock("./squad-review-gate", () => ({
  openSquadReview: (...args: unknown[]) => openSquadReviewMock(...args),
}))

import { awaitReplanApproval } from "./replan-gate"
import { continueDecision, type ReplanDecision } from "./replan-schema"
import type { TeamNotifier } from "./team-notifier"
import type { SquadReviewOutcome } from "./squad-review-gate"

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
  newMembers: [],
}

const approve = async (): Promise<SquadReviewOutcome> => ({ kind: "replan", outcome: "approve" })

describe("awaitReplanApproval", () => {
  beforeEach(() => openSquadReviewMock.mockReset())

  it("opens a durable replan review and returns approved with the original decision", async () => {
    const { notifier, notify } = makeNotifier()
    const openReview = jest.fn(approve)
    const out = await awaitReplanApproval({
      notifier,
      runId: "run1",
      teamId: "team1",
      projectId: "ws1",
      instance: "after-t1",
      decision,
      openReview,
    })

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "critical" }))
    expect(openReview).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run1",
        teamId: "team1",
        projectId: "ws1",
        instance: "after-t1",
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
      openReview: async () => ({
        kind: "replan",
        outcome: "approve",
        edited: edited as unknown as Record<string, unknown>,
      }),
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
      openReview: async () => ({ kind: "replan", outcome: "approve", edited: { bogus: true } }),
    })
    expect(out.decision).toEqual(decision)
  })

  it("skips the review on a headless behavior: info notify, no interrupt, original plan", async () => {
    const { notifier, notify } = makeNotifier()
    const openReview = jest.fn(approve)
    const out = await awaitReplanApproval({
      notifier,
      runId: "run1",
      teamId: "team1",
      decision,
      behavior: "auto-reject",
      openReview,
    })
    expect(openReview).not.toHaveBeenCalled()
    expect(out.approved).toBe(false)
    expect(out.decision).toEqual(decision)
    const payload = notify.mock.calls[0][0] as { level: string }
    expect(payload.level).toBe("info")
  })

  it("returns not-approved on deny (proceed with original plan)", async () => {
    const { notifier } = makeNotifier()
    const out = await awaitReplanApproval({
      notifier,
      runId: "run1",
      teamId: "team1",
      decision,
      openReview: async () => ({ kind: "replan", outcome: "deny" }),
    })
    expect(out.approved).toBe(false)
    expect(out.decision).toEqual(decision)
  })

  it("falls back to the durable Squad review when no opener is injected", async () => {
    const { notifier } = makeNotifier()
    openSquadReviewMock.mockResolvedValueOnce({ kind: "replan", outcome: "approve" })
    const out = await awaitReplanApproval({
      notifier,
      runId: "run1",
      teamId: "team1",
      instance: "after-t2",
      decision,
    })
    expect(openSquadReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run1",
        teamId: "team1",
        kind: "replan",
        instance: "after-t2",
        subject: { action: "inject", newTasks: 1, newMembers: 0 },
      })
    )
    expect(out.approved).toBe(true)
  })

  it("propagates an abort from the review", async () => {
    const { notifier } = makeNotifier()
    await expect(
      awaitReplanApproval({
        notifier,
        runId: "run1",
        teamId: "team1",
        decision,
        openReview: async () => {
          throw new Error("Aborted")
        },
      })
    ).rejects.toThrow("Aborted")
  })
})
