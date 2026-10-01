import type { PlatformWebSocketHandlers } from "@/lib/network/platform-websocket"

import { CollabError, type CollabClient } from "./client"
import {
  FEED_COALESCE_MS,
  FEED_RECONNECT_MAX_MS,
  feedReconnectDelay,
  installCollabFeed,
  legsForFrame,
  parseFeedFrame,
  publishCollabNotificationSignal,
  subscribeCollabNotificationSignals,
  type CollabNotificationSignal,
} from "./feed"
import { isCollabFeedLive, requestCollabRefresh } from "./refresh-scheduler"

jest.mock("@cognia/logging", () => ({
  loggers: { shell: { info: jest.fn(), warn: jest.fn() } },
}))

const ORG = "org_acme"

describe("parseFeedFrame / legsForFrame", () => {
  it("maps each entity to the leg that owns it", () => {
    const leg = (entity: string) =>
      legsForFrame(parseFeedFrame(JSON.stringify({ kind: "invalidate", entity, id: "x" }))!)
    expect(leg("issue")).toEqual(["issues"])
    expect(leg("issue_event")).toEqual(["issues"])
    expect(leg("plan")).toEqual(["activity"])
    expect(leg("run")).toEqual(["activity"])
    expect(leg("workspace")).toEqual(["workspaces"])
    // A membership change can reveal or hide rows everywhere.
    expect(leg("membership")).toEqual(["workspaces", "issues", "activity"])
  })

  it("treats resync as a full refresh and refreshes no mirror leg for a notification", () => {
    expect(legsForFrame({ kind: "resync" })).toEqual(["workspaces", "issues", "activity"])
    // A notification frame goes to the notification sync, not to a mirror.
    expect(legsForFrame({ kind: "notification", recipientUserId: "u", seq: 1 })).toBeNull()
  })

  it("parses a notification frame and refuses one without a recipient or seq", () => {
    expect(
      parseFeedFrame(JSON.stringify({ kind: "notification", recipientUserId: "usr_a", seq: 7 }))
    ).toEqual({ kind: "notification", recipientUserId: "usr_a", seq: 7 })
    expect(parseFeedFrame(JSON.stringify({ kind: "notification", seq: 7 }))).toBeNull()
    expect(
      parseFeedFrame(JSON.stringify({ kind: "notification", recipientUserId: "usr_a" }))
    ).toBeNull()
  })

  it("refuses malformed and unknown frames", () => {
    expect(parseFeedFrame("not json")).toBeNull()
    expect(parseFeedFrame(JSON.stringify({ kind: "surprise" }))).toBeNull()
    expect(parseFeedFrame(JSON.stringify({ kind: "invalidate", id: 1 }))).toBeNull()
    expect(parseFeedFrame(JSON.stringify(null))).toBeNull()
  })

  it("backs reconnects off exponentially up to a minute", () => {
    expect(feedReconnectDelay(0)).toBe(1_000)
    expect(feedReconnectDelay(3)).toBe(8_000)
    expect(feedReconnectDelay(30)).toBe(FEED_RECONNECT_MAX_MS)
  })
})

describe("installCollabFeed", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  function harness(
    openImpl?: () => Promise<never>,
    onNotification?: (signal: CollabNotificationSignal) => void
  ) {
    const handlers: PlatformWebSocketHandlers[] = []
    const closed = jest.fn(async () => undefined)
    const client = {
      openWorkspaceFeed: jest.fn(async (_org: string, h: PlatformWebSocketHandlers) => {
        if (openImpl) return openImpl()
        handlers.push(h)
        return { id: "s", kind: "browser" as const, send: async () => undefined, close: closed }
      }),
    } as unknown as CollabClient
    const refreshLegs = jest.fn(
      async (_id: string, legs: readonly string[]) => ({ status: "refreshed", legs }) as never
    )
    return {
      client,
      handlers,
      closed,
      refreshLegs,
      install: (account: string) =>
        installCollabFeed(account, {
          resolve: async () => ({ client, orgId: ORG }),
          refreshLegs,
          ...(onNotification ? { onNotification } : {}),
        }),
    }
  }

  const frame = (entity: string) => JSON.stringify({ kind: "invalidate", entity, id: "x" })

  it("goes live, coalesces a burst into one refresh of the union of legs, and stops cleanly", async () => {
    const h = harness()
    const stop = h.install("acct-burst")
    await jest.advanceTimersByTimeAsync(0)
    expect(isCollabFeedLive("acct-burst")).toBe(true)

    h.handlers[0]!.onMessage!(frame("issue"))
    h.handlers[0]!.onMessage!(frame("plan"))
    h.handlers[0]!.onMessage!(frame("issue_event"))
    await jest.advanceTimersByTimeAsync(FEED_COALESCE_MS)
    expect(h.refreshLegs).toHaveBeenCalledTimes(1)
    expect([...h.refreshLegs.mock.calls[0]![1]].sort()).toEqual(["activity", "issues"])

    stop()
    expect(isCollabFeedLive("acct-burst")).toBe(false)
    expect(h.closed).toHaveBeenCalled()
  })

  it("waits out a refresh already running before it starts its own", async () => {
    const h = harness()
    const stop = h.install("acct-wait")
    await jest.advanceTimersByTimeAsync(0)
    let finishOlder!: (value: never) => void
    const older = requestCollabRefresh(
      "acct-wait",
      () =>
        new Promise((done) => {
          finishOlder = done
        })
    )
    h.handlers[0]!.onMessage!(frame("run"))
    await jest.advanceTimersByTimeAsync(FEED_COALESCE_MS)
    expect(h.refreshLegs).not.toHaveBeenCalled()
    finishOlder({ status: "skipped", reason: "no-org" } as never)
    await older
    await jest.advanceTimersByTimeAsync(0)
    expect(h.refreshLegs).toHaveBeenCalledWith("acct-wait", ["activity"])
    stop()
  })

  it("on close: stops being live, refreshes everything, and reconnects", async () => {
    const h = harness()
    const stop = h.install("acct-close")
    await jest.advanceTimersByTimeAsync(0)
    h.handlers[0]!.onClose!({ code: 1006, reason: null })
    expect(isCollabFeedLive("acct-close")).toBe(false)
    await jest.advanceTimersByTimeAsync(FEED_COALESCE_MS)
    expect(h.refreshLegs).toHaveBeenCalledWith("acct-close", ["workspaces", "issues", "activity"])
    await jest.advanceTimersByTimeAsync(feedReconnectDelay(0))
    expect(h.client.openWorkspaceFeed).toHaveBeenCalledTimes(2)
    expect(isCollabFeedLive("acct-close")).toBe(true)
    stop()
  })

  it("hands a notification frame to the notification sync without refreshing a leg", async () => {
    const signals: CollabNotificationSignal[] = []
    const h = harness(undefined, (signal) => signals.push(signal))
    const stop = h.install("acct-notify")
    await jest.advanceTimersByTimeAsync(0)
    // Connecting is itself a signal: frames sent while the socket was down reached nobody.
    expect(signals).toEqual([{ reason: "connected" }])

    h.handlers[0]!.onMessage!(
      JSON.stringify({ kind: "notification", recipientUserId: "usr_ada", seq: 9 })
    )
    await jest.advanceTimersByTimeAsync(FEED_COALESCE_MS)
    expect(signals.at(-1)).toEqual({ reason: "frame", recipientUserId: "usr_ada", seq: 9 })
    expect(h.refreshLegs).not.toHaveBeenCalled()
    stop()
  })

  it("signals again after a reconnect", async () => {
    const signals: CollabNotificationSignal[] = []
    const h = harness(undefined, (signal) => signals.push(signal))
    const stop = h.install("acct-notify-reconnect")
    await jest.advanceTimersByTimeAsync(0)
    h.handlers[0]!.onClose!({ code: 1006, reason: null })
    await jest.advanceTimersByTimeAsync(feedReconnectDelay(0) + FEED_COALESCE_MS)
    expect(signals.filter((signal) => signal.reason === "connected")).toHaveLength(2)
    stop()
  })

  it("publishes to this profile's subscribers by default", async () => {
    const heard: CollabNotificationSignal[] = []
    const other: CollabNotificationSignal[] = []
    const unsubscribe = subscribeCollabNotificationSignals("acct-default", (s) => heard.push(s))
    const unsubscribeOther = subscribeCollabNotificationSignals("acct-other", (s) => other.push(s))
    const h = harness()
    const stop = h.install("acct-default")
    await jest.advanceTimersByTimeAsync(0)
    h.handlers[0]!.onMessage!(
      JSON.stringify({ kind: "notification", recipientUserId: "usr_ada", seq: 2 })
    )
    expect(heard).toEqual([
      { reason: "connected" },
      { reason: "frame", recipientUserId: "usr_ada", seq: 2 },
    ])
    expect(other).toEqual([])
    unsubscribe()
    unsubscribeOther()
    stop()
  })

  it("stops asking a server that has no feed", async () => {
    const h = harness(async () => {
      throw new CollabError(404, "not found")
    })
    const stop = h.install("acct-nofeed")
    await jest.advanceTimersByTimeAsync(FEED_RECONNECT_MAX_MS * 2)
    expect(h.client.openWorkspaceFeed).toHaveBeenCalledTimes(1)
    expect(isCollabFeedLive("acct-nofeed")).toBe(false)
    stop()
  })

  it("retries a transient failure with backoff", async () => {
    const h = harness(async () => {
      throw new CollabError(503, "busy")
    })
    const stop = h.install("acct-retry")
    await jest.advanceTimersByTimeAsync(0)
    await jest.advanceTimersByTimeAsync(feedReconnectDelay(0))
    expect(h.client.openWorkspaceFeed).toHaveBeenCalledTimes(2)
    stop()
  })

  it("does nothing when collaboration is not configured", async () => {
    const refreshLegs = jest.fn()
    const stop = installCollabFeed("acct-none", { resolve: async () => null, refreshLegs })
    await jest.advanceTimersByTimeAsync(FEED_RECONNECT_MAX_MS)
    expect(isCollabFeedLive("acct-none")).toBe(false)
    expect(refreshLegs).not.toHaveBeenCalled()
    stop()
  })
})

describe("notification signal registry", () => {
  it("delivers to every subscriber, survives a throwing one, and stops after unsubscribe", () => {
    const heard: CollabNotificationSignal[] = []
    const unsubscribeThrower = subscribeCollabNotificationSignals("acct-registry", () => {
      throw new Error("boom")
    })
    const unsubscribe = subscribeCollabNotificationSignals("acct-registry", (s) => heard.push(s))
    publishCollabNotificationSignal("acct-registry", { reason: "connected" })
    expect(heard).toEqual([{ reason: "connected" }])

    unsubscribe()
    unsubscribeThrower()
    publishCollabNotificationSignal("acct-registry", { reason: "connected" })
    expect(heard).toHaveLength(1)
  })
})
