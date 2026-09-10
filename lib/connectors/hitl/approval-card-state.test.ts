import { approvalStateSegment, settleApprovalCard } from "./approval-card-state"
import { enqueueGoverned } from "@/lib/connectors/delivery-gateway"
import { waitForOutboundTerminal } from "@/lib/db/outbound-jobs"
import { appendAudit } from "@/lib/connectors/audit"
jest.mock("@/lib/connectors/delivery-gateway", () => ({ enqueueGoverned: jest.fn() }))
jest.mock("@/lib/db/outbound-jobs", () => ({ waitForOutboundTerminal: jest.fn() }))
jest.mock("@/lib/connectors/audit", () => ({ appendAudit: jest.fn(async () => undefined) }))
const input = {
  adapterId: "lark-1",
  conversationKey: "chat",
  conversationRef: { platform: "lark" as const, adapterId: "lark-1" },
  surfaceId: "approval-1",
  state: "approved" as const,
}
beforeEach(() => jest.clearAllMocks())
it.each(["approved", "denied", "expired", "processed", "failed"] as const)(
  "removes every action in a %s card",
  (state) => {
    const segment = approvalStateSegment(state)
    expect(JSON.stringify(segment)).not.toContain('"button"')
    expect(JSON.stringify(segment)).toContain('"schema":"2.0"')
  }
)
it("edits the original delivered message through the durable queue", async () => {
  jest.mocked(waitForOutboundTerminal).mockResolvedValue({
    adapterId: "lark-1",
    conversationKey: "chat",
    platformMessageId: "om-1",
    request: { conversationRef: input.conversationRef },
  } as never)
  await settleApprovalCard({ ...input, jobId: "job" })
  expect(enqueueGoverned).toHaveBeenCalledWith(
    expect.objectContaining({
      request: expect.objectContaining({
        editTargetMessageId: "om-1",
        segments: [approvalStateSegment("approved")],
      }),
    })
  )
})
it("uses callback message identity without waiting for delivery", async () => {
  await settleApprovalCard({ ...input, messageId: "om-2" })
  expect(waitForOutboundTerminal).not.toHaveBeenCalled()
  expect(enqueueGoverned).toHaveBeenCalledWith(
    expect.objectContaining({ request: expect.objectContaining({ editTargetMessageId: "om-2" }) })
  )
})
it("does not send a duplicate card when the message is unknown or the platform differs", async () => {
  await settleApprovalCard(input)
  await settleApprovalCard({
    ...input,
    conversationRef: { platform: "telegram", adapterId: "tg" },
    messageId: "m",
  })
  expect(enqueueGoverned).not.toHaveBeenCalled()
})
it("audits a queue failure without reversing the approval", async () => {
  jest.mocked(enqueueGoverned).mockRejectedValueOnce(new Error("offline"))
  await expect(settleApprovalCard({ ...input, messageId: "om" })).resolves.toBeUndefined()
  expect(appendAudit).toHaveBeenCalledWith(
    expect.objectContaining({ reason: "approval_card_update_failed" })
  )
})
