jest.mock("@/lib/notifications/runtime", () => ({ notify: jest.fn(async () => "notif-1") }))
jest.mock("@/lib/db/notifications", () => ({ findByDedupeKey: jest.fn() }))
jest.mock("@/stores/notifications/notification-store", () => {
  const markDone = jest.fn(async () => {})
  return { useNotificationStore: { getState: () => ({ markDone }) } }
})
jest.mock("@/lib/notifications/api", () => ({ emitNotification: jest.fn() }))

import { findByDedupeKey } from "@/lib/db/notifications"
import { emitNotification } from "@/lib/notifications/api"
import { notify } from "@/lib/notifications/runtime"
import { useNotificationStore } from "@/stores/notifications/notification-store"

import {
  APPROVAL_CHANNELS,
  OPEN_APPROVAL_COMMAND,
  clearRequestNotification,
  notifyIncomingRequest,
  requestNotificationKey,
} from "./approval-notifications"

const TEXT = { title: "A new device wants to join", body: "Pixel 9 · mobile", open: "Review" }

describe("approval notifications", () => {
  it("prompts on this device only, until the request expires", async () => {
    expect(await notifyIncomingRequest({ requestId: "req_1", expiresAt: 123 }, TEXT)).toBe(
      "notif-1"
    )
    const input = jest.mocked(notify).mock.calls[0]![0]
    expect(input).toMatchObject({
      source: "system",
      title: TEXT.title,
      body: TEXT.body,
      dedupeKey: requestNotificationKey("req_1"),
      directed: true,
      validUntil: 123,
      actions: [{ label: "Review", command: OPEN_APPROVAL_COMMAND, args: { requestId: "req_1" } }],
    })
    expect(input.channels).toEqual(["center", "toast", "os"])
  })

  it("never routes to IM, companion push or webhooks", async () => {
    await notifyIncomingRequest({ requestId: "req_2", expiresAt: 1 }, TEXT)
    for (const [input] of jest.mocked(notify).mock.calls) {
      expect(input.channels).not.toContain("im")
      expect(input.channels).not.toContain("push")
    }
    expect(APPROVAL_CHANNELS).not.toContain("im")
    expect(APPROVAL_CHANNELS).not.toContain("push")
    expect(emitNotification).not.toHaveBeenCalled()
  })

  it("archives the prompt when the request ends", async () => {
    jest.mocked(findByDedupeKey).mockResolvedValueOnce({ id: "notif-9" } as never)
    await clearRequestNotification("req_1")
    expect(findByDedupeKey).toHaveBeenCalledWith(requestNotificationKey("req_1"), 0)
    expect(useNotificationStore.getState().markDone).toHaveBeenCalledWith("notif-9")
    jest.mocked(findByDedupeKey).mockResolvedValueOnce(undefined)
    await clearRequestNotification("req_gone")
    expect(useNotificationStore.getState().markDone).toHaveBeenCalledTimes(1)
  })
})
