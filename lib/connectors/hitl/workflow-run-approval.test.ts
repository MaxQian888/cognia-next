import type { ConversationReference } from "@/types/connectors/event"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"

import {
  buildWorkflowHoldSummary,
  holdWorkflowDispatchForApproval,
  WORKFLOW_HOLD_SURFACE_PREFIX,
} from "./workflow-run-approval"

const conversationRef: ConversationReference = {
  platform: "lark",
  adapterId: "lark-1",
  channelId: "chat-1",
}

const triggeredFrom: WorkflowTriggeredFrom = {
  source: "im",
  adapterId: "lark-1",
  conversationKey: "lark:lark-1:chat-1",
  sourceMessageId: "m1",
}

function input(over: Partial<Parameters<typeof holdWorkflowDispatchForApproval>[0]> = {}) {
  return {
    workflowId: "wf_1",
    runParams: { message: "ship the release notes" },
    triggeredFrom,
    adapterId: "lark-1",
    conversationKey: "lark:lark-1:chat-1",
    conversationRef,
    initiatorUserId: "ou-user",
    requestText: "ship the release notes",
    now: 1_000,
    enqueue: jest.fn(async () => undefined) as never,
    recordBinding: jest.fn(async () => undefined) as never,
    audit: jest.fn(async () => undefined) as never,
    readWorkflow: jest.fn(async () => ({ name: "Release notes", description: "Publishes notes" })),
    ...over,
  }
}

describe("buildWorkflowHoldSummary", () => {
  it("says why it is asking, not just what would run", () => {
    // A card that only names the workflow makes the reader guess whether
    // something went wrong. Nothing did — the conversation is in suggest mode.
    const summary = buildWorkflowHoldSummary({ requestText: "do the thing" })
    expect(summary).toContain("suggest mode")
    expect(summary).toContain("建议模式")
  })

  it("quotes the triggering message so the ask is reviewable", () => {
    expect(buildWorkflowHoldSummary({ requestText: "deploy prod" })).toContain("deploy prod")
  })

  it("clips a long request instead of pasting a wall of text into a card", () => {
    const long = "x".repeat(2_000)
    const summary = buildWorkflowHoldSummary({ requestText: long })
    expect(summary.length).toBeLessThan(long.length)
    expect(summary).toContain("…")
  })

  it("omits the request line entirely when there is nothing to quote", () => {
    expect(buildWorkflowHoldSummary({})).not.toContain("Request:")
  })
})

describe("holdWorkflowDispatchForApproval", () => {
  it("records an Approve/Cancel pair on one surface and delivers the card", async () => {
    const args = input()
    const result = await holdWorkflowDispatchForApproval(args)

    expect(result).toMatchObject({ held: true, workflowName: "Release notes" })
    const record = args.recordBinding as unknown as jest.Mock
    expect(record).toHaveBeenCalledTimes(2)
    const kinds = record.mock.calls.map((call) => call[0].kind)
    expect(kinds).toEqual(["wf_approve", "wf_cancel"])
    // One surface, two buttons — the dispatcher deletes siblings by surfaceId,
    // so a split surface would leave a live half after the decision.
    const surfaces = new Set(record.mock.calls.map((call) => call[0].surfaceId))
    expect(surfaces.size).toBe(1)
    expect([...surfaces][0]).toContain(WORKFLOW_HOLD_SURFACE_PREFIX)
    expect(args.enqueue).toHaveBeenCalledTimes(1)
  })

  it("starts nothing — the whole point is that the run waits for a person", async () => {
    const args = input()
    await holdWorkflowDispatchForApproval(args)
    // The dispatch lives entirely in the binding payload; the caller must not
    // have anything else to undo if the person says no.
    const record = args.recordBinding as unknown as jest.Mock
    expect(record.mock.calls[0][0].payload).toMatchObject({
      workflowId: "wf_1",
      runParams: { message: "ship the release notes" },
      triggeredFrom,
    })
  })

  it("freezes the permission ceiling onto the binding", async () => {
    // Re-deriving at approval time would let a policy change between the ask
    // and the press silently widen the run that was actually approved.
    const args = input({ permissionCeiling: { allowedTools: ["Read"] } })
    await holdWorkflowDispatchForApproval(args)
    const record = args.recordBinding as unknown as jest.Mock
    expect(record.mock.calls[0][0].payload.permissionCeiling).toEqual({ allowedTools: ["Read"] })
  })

  it("omits the ceiling key when the conversation has none", async () => {
    const args = input()
    await holdWorkflowDispatchForApproval(args)
    const record = args.recordBinding as unknown as jest.Mock
    expect("permissionCeiling" in record.mock.calls[0][0].payload).toBe(false)
  })

  it("scopes the buttons to the person who asked", async () => {
    const args = input()
    await holdWorkflowDispatchForApproval(args)
    const record = args.recordBinding as unknown as jest.Mock
    expect(record.mock.calls[0][0].actorScope).toEqual({
      mode: "initiator",
      allowedUserIds: ["ou-user"],
    })
  })

  it("falls back to operators when the platform gave no stable user id", async () => {
    const args = input({ initiatorUserId: undefined })
    await holdWorkflowDispatchForApproval(args)
    const record = args.recordBinding as unknown as jest.Mock
    expect(record.mock.calls[0][0].actorScope).toEqual({ mode: "operators" })
  })

  it("expires the buttons well before the binding table's 30-day default", async () => {
    const args = input()
    await holdWorkflowDispatchForApproval(args)
    const record = args.recordBinding as unknown as jest.Mock
    expect(record.mock.calls[0][0].expiresAt).toBe(1_000 + 24 * 60 * 60 * 1_000)
  })

  it("falls back to the workflow id when the row is gone", async () => {
    const args = input({ readWorkflow: jest.fn(async () => undefined) })
    const result = await holdWorkflowDispatchForApproval(args)
    expect(result).toMatchObject({ held: true, workflowName: "wf_1" })
  })

  it("fails closed when the card cannot be delivered", async () => {
    // Running the workflow because the question could not be asked is the gap
    // this closes, only louder.
    const args = input({
      enqueue: jest.fn(async () => {
        throw new Error("gateway down")
      }) as never,
    })
    const result = await holdWorkflowDispatchForApproval(args)
    expect(result).toEqual({
      held: false,
      reason: "card_delivery_failed",
      message: "gateway down",
    })
    expect(args.audit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "workflow_hold_card_failed" })
    )
  })
})
