/** @jest-environment jsdom */

const notifyMock = jest.fn(async (..._a: unknown[]) => "rec-1")
jest.mock("./runtime", () => ({ notify: (...a: unknown[]) => notifyMock(...a) }))

const profileState = { value: "cloud-companion" as string }
jest.mock("@/lib/platform/capabilities", () => ({
  ...jest.requireActual("@/lib/platform/capabilities"),
  detectHostProfile: () => profileState.value,
}))

const defaultSubscribe = jest.fn()
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { subscribe: (...a: unknown[]) => defaultSubscribe(...a) },
}))

const routingState: { active: unknown; listeners: Array<(t: unknown) => void> } = {
  active: null,
  listeners: [],
}
jest.mock("@/lib/tauri/transport-routing", () => ({
  getActiveRemoteTransport: () => routingState.active,
  subscribeActiveRemoteTransport: (listener: (t: unknown) => void) => {
    routingState.listeners.push(listener)
    return () => {
      routingState.listeners = routingState.listeners.filter((l) => l !== listener)
    }
  },
}))

import {
  REMOTE_NOTIFICATION_CHANNEL,
  ingestRemoteNotification,
  installRemoteNotificationListener,
  parseRemoteNotificationFrame,
  subscribeRemoteNotifications,
} from "./remote-subscription"

beforeEach(() => {
  notifyMock.mockClear()
  defaultSubscribe.mockReset().mockReturnValue(() => undefined)
  routingState.active = null
  routingState.listeners = []
  profileState.value = "cloud-companion"
})

describe("parseRemoteNotificationFrame", () => {
  it("accepts well-formed frames and rejects junk", () => {
    expect(parseRemoteNotificationFrame(null)).toBeNull()
    expect(parseRemoteNotificationFrame("x")).toBeNull()
    expect(parseRemoteNotificationFrame({ id: "", title: "t" })).toBeNull()
    expect(parseRemoteNotificationFrame({ id: "1", title: "  " })).toBeNull()
    expect(
      parseRemoteNotificationFrame({
        id: "1",
        title: "T",
        body: 5,
        level: "error",
        href: 3,
        source: "scheduler",
        createdAt: "x",
      })
    ).toEqual({
      id: "1",
      title: "T",
      body: undefined,
      level: "error",
      href: null,
      source: "scheduler",
      createdAt: undefined,
    })
  })
})

describe("ingestRemoteNotification", () => {
  it("files the frame into the local center with a host-scoped dedupe key", async () => {
    const id = await ingestRemoteNotification(
      {
        id: "n1",
        title: "Nightly report",
        body: "3 rows",
        level: "success",
        href: "/scheduler",
        source: "scheduler",
      },
      { hostKey: "cloud" }
    )
    expect(id).toBe("rec-1")
    expect(notifyMock).toHaveBeenCalledWith({
      source: "scheduler",
      level: "success",
      title: "Nightly report",
      body: "3 rows",
      href: "/scheduler",
      dedupeKey: "remote:cloud:n1",
      groupKey: "remote:cloud",
      channels: ["center", "toast", "os"],
    })
  })

  it("falls back to system/info, drops unsafe hrefs and a body equal to the title", async () => {
    await ingestRemoteNotification(
      { id: "n2", title: "T", body: "T", level: "loud", href: "//evil", source: "nope" },
      { hostKey: "h" }
    )
    expect(notifyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: "system", level: "info", body: undefined, href: undefined })
    )
    expect(await ingestRemoteNotification({ nope: true }, { hostKey: "h" })).toBeNull()
  })

  it("uses an injected notify function", async () => {
    const custom = jest.fn(async () => "x")
    await ingestRemoteNotification({ id: "n3", title: "T" }, { hostKey: "h", notifyFn: custom })
    expect(custom).toHaveBeenCalled()
    expect(notifyMock).not.toHaveBeenCalled()
  })
})

describe("subscribeRemoteNotifications", () => {
  it("subscribes the channel and ingests frames", async () => {
    let handler: ((p: unknown) => void) | null = null
    const unsubscribe = jest.fn()
    const transport = {
      subscribe: jest.fn((channel: string, h: (p: unknown) => void) => {
        expect(channel).toBe(REMOTE_NOTIFICATION_CHANNEL)
        handler = h
        return unsubscribe
      }),
    }
    const stop = subscribeRemoteNotifications({ transport, hostKey: "k" })
    handler!({ id: "n1", title: "T" })
    await Promise.resolve()
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: "remote:k:n1" }))
    stop()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it("is a no-op on transports without an events plane or when subscribe throws", () => {
    expect(subscribeRemoteNotifications({ transport: {} as never })()).toBeUndefined()
    const throwing = {
      subscribe: () => {
        throw new Error("no ws")
      },
    }
    expect(subscribeRemoteNotifications({ transport: throwing })()).toBeUndefined()
  })

  it("swallows ingest failures", async () => {
    notifyMock.mockRejectedValueOnce(new Error("db"))
    let handler: ((p: unknown) => void) | null = null
    subscribeRemoteNotifications({
      transport: {
        subscribe: ((_c: string, h: (p: unknown) => void) => {
          handler = h
          return () => {}
        }) as unknown as Pick<
          import("@/lib/tauri/transport-types").Transport,
          "subscribe"
        >["subscribe"],
      },
    })
    expect(() => handler!({ id: "n", title: "T" })).not.toThrow()
    await Promise.resolve()
  })
})

describe("installRemoteNotificationListener", () => {
  it("subscribes the process transport on companion profiles", () => {
    profileState.value = "mobile-companion"
    const dispose = installRemoteNotificationListener()
    expect(defaultSubscribe).toHaveBeenCalledWith(REMOTE_NOTIFICATION_CHANNEL, expect.any(Function))
    dispose()
  })

  it("is a no-op on web-standalone and headless", () => {
    profileState.value = "web-standalone"
    installRemoteNotificationListener()()
    profileState.value = "headless"
    installRemoteNotificationListener()()
    expect(defaultSubscribe).not.toHaveBeenCalled()
  })

  it("follows the active remote host on the desktop", () => {
    profileState.value = "desktop"
    const unsubA = jest.fn()
    const remoteA = { subscribe: jest.fn(() => unsubA) }
    routingState.active = remoteA
    const dispose = installRemoteNotificationListener()
    expect(remoteA.subscribe).toHaveBeenCalledWith(
      REMOTE_NOTIFICATION_CHANNEL,
      expect.any(Function)
    )

    const unsubB = jest.fn()
    const remoteB = { subscribe: jest.fn(() => unsubB) }
    routingState.listeners.forEach((l) => l(remoteB))
    expect(unsubA).toHaveBeenCalledTimes(1)
    expect(remoteB.subscribe).toHaveBeenCalled()

    routingState.listeners.forEach((l) => l(null))
    expect(unsubB).toHaveBeenCalledTimes(1)
    dispose()
    expect(routingState.listeners).toEqual([])
    expect(defaultSubscribe).not.toHaveBeenCalled()
  })
})
