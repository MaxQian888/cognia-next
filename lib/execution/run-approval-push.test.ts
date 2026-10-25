import {
  RUN_APPROVAL_PENDING_CHANNEL,
  RUN_APPROVAL_RESOLVED_CHANNEL,
  announceRunApproval,
  announceRunApprovalResolved,
  isRunApprovalType,
  runApprovalHref,
} from "./run-approval-push"

jest.mock("@/lib/companion/host-event-publisher", () => ({ publishHostEvent: jest.fn() }))

describe("run approval push", () => {
  it("announces ids, the kind, the class and a deep link, never the title", async () => {
    const publish = jest.fn().mockResolvedValue(undefined)
    await announceRunApproval(
      { id: "i1", runId: "r1", type: "tool_approval", expiresAt: 99 },
      { origin: "scheduler", permissionClass: "outbound" },
      publish
    )
    expect(publish).toHaveBeenCalledWith(RUN_APPROVAL_PENDING_CHANNEL, {
      interruptId: "i1",
      runId: "r1",
      type: "tool_approval",
      permissionClass: "outbound",
      expiresAt: 99,
      href: "/scheduler",
      dedupeKey: "run-approval:i1",
    })
  })

  it("links bot and plugin approvals to the Bots page", () => {
    expect(runApprovalHref("bot")).toBe("/bots")
    expect(runApprovalHref("plugin")).toBe("/bots")
  })

  it("links an Agent Team's held publish to its runs", () => {
    expect(runApprovalHref("agent-team")).toBe("/agent-runs")
  })

  it("ignores interrupt kinds the approvals card does not answer", async () => {
    const publish = jest.fn().mockResolvedValue(undefined)
    await announceRunApproval(
      { id: "i1", runId: "r1", type: "workflow_approval", expiresAt: 1 },
      { origin: "bot" },
      publish
    )
    expect(publish).not.toHaveBeenCalled()
    expect(isRunApprovalType("bot_approval")).toBe(true)
    expect(isRunApprovalType("squad_budget")).toBe(false)
  })

  it("never lets a failed publish reach the run", async () => {
    const publish = jest.fn().mockRejectedValue(new Error("bus down"))
    await expect(
      announceRunApproval(
        { id: "i1", runId: "r1", type: "bot_approval", expiresAt: 1 },
        { origin: "bot" },
        publish
      )
    ).resolves.toBeUndefined()
    await expect(
      announceRunApprovalResolved({ interruptId: "i1", runId: "r1", status: "expired" }, publish)
    ).resolves.toBeUndefined()
    expect(publish).toHaveBeenLastCalledWith(RUN_APPROVAL_RESOLVED_CHANNEL, {
      interruptId: "i1",
      runId: "r1",
      status: "expired",
    })
  })
})
