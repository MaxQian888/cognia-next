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
  await __uninstallPushNotificationBridge()
  jest.clearAllMocks()
  mockSubscribe.mockResolvedValue(async () => {})
})

describe("pushToInput", () => {
  it("records background push to the center only", () => {
    const input = pushToInput(delivery({ foreground: false }))
    expect(input?.channels).toEqual(["center"])
  })

  it("records foreground push while the native shell owns presentation", () => {
    const input = pushToInput(delivery({ foreground: true }))
    expect(input?.channels).toEqual(["center"])
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

  it("restores metadata-only Notification Center pushes without private text", () => {
    const input = pushToInput(
      delivery({
        title: "Cognia",
        body: "Open Cognia to view new activity",
        data: {
          notificationId: "notification-1",
          source: "scheduler",
          level: "error",
          href: "/inbox",
        },
      })
    )

    expect(input).toEqual(
      expect.objectContaining({
        source: "scheduler",
        level: "error",
        href: "/inbox",
        dedupeKey: "notification-1",
        groupKey: "notification-1",
      })
    )
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
  it("subscribes once, exposes deliveries, routes them to notify(), and tears down", async () => {
    const unsubscribe = jest.fn().mockResolvedValue(undefined)
    const observer = jest.fn()
    mockSubscribe.mockResolvedValueOnce(unsubscribe)

    const cleanup = await installPushNotificationBridge(observer)
    const handler = mockSubscribe.mock.calls[0][0] as (d: PushDelivery) => void
    handler(delivery({ title: "Ping" }))

    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ title: "Ping" }))
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ title: "Ping" }))

    await cleanup()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("ignores empty deliveries", async () => {
    await installPushNotificationBridge()
    const handler = mockSubscribe.mock.calls[0][0] as (d: PushDelivery) => void
    handler(delivery({ title: undefined, body: undefined }))
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it("is idempotent — subscribes once", async () => {
    const firstCleanup = await installPushNotificationBridge()
    const duplicateCleanup = await installPushNotificationBridge()

    await duplicateCleanup()
    expect(mockSubscribe).toHaveBeenCalledTimes(1)

    await firstCleanup()
  })

  it("makes a stale cleanup harmless after the bridge was reset", async () => {
    const unsubscribe = jest.fn().mockResolvedValue(undefined)
    mockSubscribe.mockResolvedValueOnce(unsubscribe)

    const cleanup = await installPushNotificationBridge()
    await __uninstallPushNotificationBridge()
    await cleanup()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
