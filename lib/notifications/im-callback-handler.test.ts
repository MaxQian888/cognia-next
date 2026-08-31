const mockGetNotification = jest.fn()
jest.mock("@/lib/db/notifications", () => ({
  getNotification: (...a: unknown[]) => mockGetNotification(...a),
}))

const mockDispatch = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/notifications/action-registry", () => ({
  dispatchNotificationCommand: (...a: unknown[]) => mockDispatch(...a),
}))

const mockAudit = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/connectors/audit", () => ({
  appendAudit: (...a: unknown[]) => mockAudit(...a),
}))

import { handleNotificationActionCallback } from "./im-callback-handler"

const record = {
  id: "n1",
  actions: [
    { id: "approve", label: "Approve", command: "plan.approval.respond", args: { planId: "p1" } },
  ],
}

const press = (bindingPayload: unknown) =>
  handleNotificationActionCallback({
    binding: { bindingPayload },
    adapterId: "tg-1",
    conversationKey: "telegram:tg-1:9",
  })

beforeEach(() => {
  mockGetNotification.mockReset().mockResolvedValue(record)
  mockDispatch.mockReset().mockResolvedValue(undefined)
  mockAudit.mockReset().mockResolvedValue(undefined)
})

it("runs the command the record holds, not one the card carried", async () => {
  await expect(press({ notificationId: "n1", actionId: "approve" })).resolves.toBe(true)
  expect(mockDispatch).toHaveBeenCalledWith({
    notificationId: "n1",
    command: "plan.approval.respond",
    args: { planId: "p1" },
  })
})

// A card is pressable long after it was sent, so an action the record no
// longer offers has to be refused and recorded, not guessed at.
it("refuses and audits an action the record no longer offers", async () => {
  await expect(press({ notificationId: "n1", actionId: "gone" })).resolves.toBe(false)
  expect(mockDispatch).not.toHaveBeenCalled()
  expect(mockAudit).toHaveBeenCalledWith(
    expect.objectContaining({ reason: "notification_action_missing" })
  )
})

it("refuses and audits a card whose record was deleted", async () => {
  mockGetNotification.mockResolvedValue(undefined)
  await expect(press({ notificationId: "gone", actionId: "approve" })).resolves.toBe(false)
  expect(mockAudit).toHaveBeenCalledWith(
    expect.objectContaining({ reason: "notification_missing" })
  )
})

it.each([undefined, null, "n1", {}, { notificationId: "n1" }])(
  "refuses a malformed payload (%p) without reaching the database",
  async (payload) => {
    await expect(press(payload)).resolves.toBe(false)
    expect(mockGetNotification).not.toHaveBeenCalled()
  }
)

// A chat button must not surface a stack trace, and the record stays in the
// centre for the operator to answer in the app.
it("does not throw when the database read rejects", async () => {
  mockGetNotification.mockRejectedValue(new Error("dexie down"))
  await expect(press({ notificationId: "n1", actionId: "approve" })).resolves.toBe(false)
})
