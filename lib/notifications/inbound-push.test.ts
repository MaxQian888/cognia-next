import type { PushDelivery } from "@/lib/push/push-notifications"

jest.mock("./runtime", () => ({ notify: jest.fn().mockResolvedValue("id") }))
jest.mock("@/lib/push/push-notifications", () => ({ subscribeToPushNotifications: jest.fn() }))

import { notify } from "./runtime"
import { subscribeToPushNotifications } from "@/lib/push/push-notifications"
import {
  pushToInput,
  installPushNotificationBridge,
  __uninstallPushNotificationBridge,
} from "./inbound-push"

const mockNotify = notify as jest.Mock
const mockSubscribe = subscribeToPushNotifications as jest.Mock

function delivery(over: Partial<PushDelivery> = {}): PushDelivery {
  return { title: "New message", body: "hi", data: {}, foreground: false, ...over }
}

beforeEach(async () => {
  jest.clearAllMocks()
  mockSubscribe.mockResolvedValue(async () => {})
  await __uninstallPushNotificationBridge()
})

describe("pushToInput", () => {
  it("records background push to the center only", () => {
    const input = pushToInput(delivery({ foreground: false }))
    expect(input?.channels).toEqual(["center"])
  })

  it("foreground push records + toasts", () => {
    const input = pushToInput(delivery({ foreground: true }))
    expect(input?.channels).toEqual(["center", "toast"])
  })

  it("maps deep-link, conversation key, and source from data", () => {
    const input = pushToInput(
      delivery({
        data: { href: "/inbox/c/abc", conversationKey: "tg:1", source: "connector" },
      })
    )
    expect(input?.href).toBe("/inbox/c/abc")
    expect(input?.dedupeKey).toBe("tg:1")
    expect(input?.groupKey).toBe("tg:1")
  })

  it("returns null when there is nothing to show", () => {
    expect(pushToInput(delivery({ title: undefined, body: undefined }))).toBeNull()
  })

  it("falls back to body as the title when title is absent", () => {
    const input = pushToInput(delivery({ title: undefined, body: "just body" }))
    expect(input?.title).toBe("just body")
    expect(input?.body).toBeUndefined()
  })
})

describe("installPushNotificationBridge", () => {
  it("subscribes and routes deliveries to notify()", async () => {
    await installPushNotificationBridge()
    const handler = mockSubscribe.mock.calls[0][0] as (d: PushDelivery) => void
    handler(delivery({ title: "Ping" }))
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ title: "Ping" }))
  })

  it("ignores empty deliveries", async () => {
    await installPushNotificationBridge()
    const handler = mockSubscribe.mock.calls[0][0] as (d: PushDelivery) => void
    handler(delivery({ title: undefined, body: undefined }))
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it("is idempotent — subscribes once", async () => {
    await installPushNotificationBridge()
    await installPushNotificationBridge()
    expect(mockSubscribe).toHaveBeenCalledTimes(1)
  })
})
