jest.mock("@/lib/accounts/active-account-id", () => ({ DEFAULT_LOCAL_ACCOUNT_ID: "local" }))
jest.mock("@/lib/companion/credential-book", () => ({ companionCredentialBook: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn(), subscribe: jest.fn() } }))
jest.mock("@/lib/tauri/transport-companion", () => ({ hydrateCompanionConfig: jest.fn() }))

import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import { GLANCE_SNAPSHOT_VERSION, type GlanceSnapshotV1 } from "@/lib/glance/snapshot"

import {
  GLANCE_PHONE_RENEW_MS,
  GLANCE_PHONE_RETRY_MS,
  glancePhoneErrorKey,
  GlancePhoneStore,
  glancePhoneStore,
  type GlancePhoneDeps,
} from "./phone-store"
import type { GlanceRemoteDemand } from "./types"

const CONSUMER = "phone-test"
const T0 = 5_000_000

const DEMAND: GlanceRemoteDemand = {
  modules: ["fleet", "usage"],
  scope: "all",
  workspaceId: null,
  usage: { scope: "cognia", showSpend: false },
  activity: { range: "3m" },
}

function snap(revision: number, epoch = 1): GlanceSnapshotV1 {
  return {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch,
    revision,
    generatedAt: T0,
    config: DEFAULT_GLANCE_PANEL_SETTINGS,
    workspace: null,
    when: {} as GlanceSnapshotV1["when"],
    actions: [],
    fleet: null,
    usage: null,
    quota: null,
    agenda: null,
    activity: null,
    recents: null,
    pet: null,
  }
}

const ok = (snapshot: unknown = null, ttlMs = 60_000) => ({ ok: true, snapshot, ttlMs })

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe("glancePhoneErrorKey", () => {
  it.each([
    [null, "errors.hostUnreachable"],
    ["errors.quotaRefresh", "errors.quotaRefresh"],
    ["headless_host", "errors.hostUnavailable"],
    ["glance_unavailable", "errors.hostUnavailable"],
    ["glance_invalid_request", "errors.requestFailed"],
    ["weird", "errors.requestFailed"],
  ])("maps %j to %s", (code, key) => {
    expect(glancePhoneErrorKey(code)).toBe(key)
  })
})

describe("GlancePhoneStore", () => {
  let call: jest.Mock
  let subscribe: jest.Mock
  let detach: jest.Mock
  let hydrate: jest.Mock
  let hostLabel: jest.Mock
  let now: number
  let push: (payload: unknown) => void
  let makeDeps: jest.Mock
  let store: GlancePhoneStore

  beforeEach(() => {
    jest.useFakeTimers()
    now = T0
    detach = jest.fn()
    push = () => {
      throw new Error("not subscribed")
    }
    call = jest.fn(async () => ok())
    subscribe = jest.fn((_event: string, handler: (payload: unknown) => void) => {
      push = handler
      return detach
    })
    hydrate = jest.fn(async () => undefined)
    hostLabel = jest.fn(async () => "Studio Mac")
    makeDeps = jest.fn((): GlancePhoneDeps => ({
      call: call as unknown as GlancePhoneDeps["call"],
      subscribe: subscribe as unknown as GlancePhoneDeps["subscribe"],
      hydrate,
      hostLabel,
      now: () => now,
      consumer: CONSUMER,
    }))
    store = new GlancePhoneStore(makeDeps)
  })

  afterEach(() => {
    store.reset()
    jest.useRealTimers()
  })

  const subscribeCalls = () => call.mock.calls.filter(([command]) => command === "glance_subscribe")
  const visibleAnnouncements = () =>
    subscribeCalls().filter(([, payload]) => (payload as { visible: boolean }).visible)

  async function holdLive(demand = DEMAND) {
    const release = store.hold(demand)
    await flush()
    return release
  }

  it("starts idle with nothing kept", () => {
    expect(store.getState()).toEqual({
      status: "idle",
      snapshot: null,
      receivedAt: null,
      hostLabel: null,
    })
    expect(makeDeps).not.toHaveBeenCalled()
  })

  describe("hold", () => {
    it("hydrates, subscribes to glance://update, then announces", async () => {
      const order: string[] = []
      hydrate.mockImplementation(async () => {
        order.push("hydrate")
      })
      subscribe.mockImplementation((event: string, handler: (p: unknown) => void) => {
        order.push(`subscribe:${event}`)
        push = handler
        return detach
      })
      call.mockImplementation(async (command: string) => {
        order.push(`call:${command}`)
        return ok()
      })
      store.hold(DEMAND)
      expect(store.getState().status).toBe("connecting")
      await flush()
      expect(order).toEqual(["hydrate", "subscribe:glance://update", "call:glance_subscribe"])
      expect(call).toHaveBeenCalledWith("glance_subscribe", {
        consumer: CONSUMER,
        visible: true,
        demand: DEMAND,
      })
    })

    it("still subscribes and announces when hydrate fails", async () => {
      hydrate.mockRejectedValue(new Error("no config"))
      await holdLive()
      expect(subscribe).toHaveBeenCalledTimes(1)
      expect(visibleAnnouncements()).toHaveLength(1)
    })

    it("patches in the host label", async () => {
      await holdLive()
      expect(store.getState().hostLabel).toBe("Studio Mac")
    })

    it("tolerates a failing host label read", async () => {
      hostLabel.mockRejectedValue(new Error("vault"))
      await holdLive()
      expect(store.getState().hostLabel).toBeNull()
      expect(store.getState().status).toBe("connecting")
    })

    it("starts once for several holders and for a setDemand while starting", async () => {
      let finish!: () => void
      hydrate.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)))
      store.hold(DEMAND)
      store.setDemand(DEMAND)
      store.hold(DEMAND)
      store.setDemand({ ...DEMAND, modules: ["pet"] })
      finish()
      await flush()
      expect(hydrate).toHaveBeenCalledTimes(1)
      expect(subscribe).toHaveBeenCalledTimes(1)
      // One announcement, carrying the newest demand.
      expect(visibleAnnouncements()).toHaveLength(1)
      expect(visibleAnnouncements()[0][1]).toMatchObject({ demand: { modules: ["pet"] } })
    })

    it("does nothing when released before hydrate finishes", async () => {
      let finish!: () => void
      hydrate.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)))
      const release = store.hold(DEMAND)
      release()
      expect(store.getState().status).toBe("idle")
      finish()
      await flush()
      expect(subscribe).not.toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()
    })

    it("a re-hold during an abandoned start starts cleanly", async () => {
      const finishes: Array<() => void> = []
      hydrate.mockImplementation(() => new Promise<void>((resolve) => finishes.push(resolve)))
      const release = store.hold(DEMAND)
      release()
      store.hold(DEMAND)
      expect(hydrate).toHaveBeenCalledTimes(2)
      finishes[0]()
      await flush()
      expect(subscribe).not.toHaveBeenCalled()
      finishes[1]()
      await flush()
      expect(subscribe).toHaveBeenCalledTimes(1)
      expect(visibleAnnouncements()).toHaveLength(1)
    })
  })

  describe("snapshots", () => {
    it("accepts the snapshot from the subscribe response and goes live", async () => {
      call.mockResolvedValue(ok(snap(3)))
      now = T0 + 7
      await holdLive()
      expect(store.getState()).toMatchObject({
        status: "live",
        snapshot: snap(3),
        receivedAt: T0 + 7,
      })
    })

    it("stays connecting on a null snapshot until a push arrives", async () => {
      await holdLive()
      expect(store.getState().status).toBe("connecting")
      now = T0 + 50
      push(snap(1))
      expect(store.getState()).toMatchObject({ status: "live", receivedAt: T0 + 50 })
      expect(store.getState().snapshot?.revision).toBe(1)
    })

    it("takes only newer pushes, but goes live on an older one", async () => {
      await holdLive()
      push(snap(5))
      const first = store.getState().snapshot
      push(snap(4))
      push(snap(5))
      expect(store.getState().snapshot).toBe(first)
      push(snap(6))
      expect(store.getState().snapshot?.revision).toBe(6)
      push(snap(1, 2))
      expect(store.getState().snapshot).toMatchObject({ epoch: 2, revision: 1 })
    })

    it.each([
      ["null", null],
      ["a string", "snapshot"],
      ["a wrong version", { ...snap(9), version: 2 }],
      ["no actions", { ...snap(9), actions: undefined }],
      ["no config", { ...snap(9), config: null }],
    ])("ignores a pushed payload that is %s", async (_name, payload) => {
      await holdLive()
      push(payload)
      expect(store.getState()).toMatchObject({ status: "connecting", snapshot: null })
    })

    it("ignores a malformed snapshot in the subscribe response", async () => {
      call.mockResolvedValue(ok({ version: 1 }))
      await holdLive()
      expect(store.getState()).toMatchObject({ status: "connecting", snapshot: null })
    })

    it("keeps live on a renewal answering null after a snapshot arrived", async () => {
      call.mockResolvedValueOnce(ok(snap(1)))
      await holdLive()
      call.mockResolvedValue(ok(null))
      await jest.advanceTimersByTimeAsync(GLANCE_PHONE_RENEW_MS)
      expect(visibleAnnouncements()).toHaveLength(2)
      expect(store.getState().status).toBe("live")
    })

    it("notifies listeners on each change and stops after unsubscribe", async () => {
      const listener = jest.fn()
      const off = store.subscribe(listener)
      await holdLive()
      const calls = listener.mock.calls.length
      expect(calls).toBeGreaterThan(0)
      push(snap(1))
      expect(listener.mock.calls.length).toBe(calls + 1)
      off()
      push(snap(2))
      expect(listener.mock.calls.length).toBe(calls + 1)
    })
  })

  describe("status and renewal", () => {
    it("renews every 20 s with the default 60 s ttl", async () => {
      await holdLive()
      await jest.advanceTimersByTimeAsync(GLANCE_PHONE_RENEW_MS - 1)
      expect(visibleAnnouncements()).toHaveLength(1)
      await jest.advanceTimersByTimeAsync(1)
      expect(visibleAnnouncements()).toHaveLength(2)
      await jest.advanceTimersByTimeAsync(GLANCE_PHONE_RENEW_MS)
      expect(visibleAnnouncements()).toHaveLength(3)
    })

    it("renews at a third of a short ttl, never more often than once a second", async () => {
      call.mockResolvedValue(ok(null, 9_000))
      await holdLive()
      await jest.advanceTimersByTimeAsync(2_999)
      expect(visibleAnnouncements()).toHaveLength(1)
      await jest.advanceTimersByTimeAsync(1)
      expect(visibleAnnouncements()).toHaveLength(2)

      call.mockResolvedValue(ok(null, 900))
      await jest.advanceTimersByTimeAsync(3_000)
      expect(visibleAnnouncements()).toHaveLength(3)
      await jest.advanceTimersByTimeAsync(999)
      expect(visibleAnnouncements()).toHaveLength(3)
      await jest.advanceTimersByTimeAsync(1)
      expect(visibleAnnouncements()).toHaveLength(4)
    })

    it("goes offline when the call rejects, and retries", async () => {
      call.mockRejectedValueOnce(new Error("no route"))
      await holdLive()
      expect(store.getState().status).toBe("offline")
      call.mockResolvedValue(ok(snap(1)))
      await jest.advanceTimersByTimeAsync(GLANCE_PHONE_RETRY_MS)
      expect(visibleAnnouncements()).toHaveLength(2)
      expect(store.getState().status).toBe("live")
    })

    it("keeps the last snapshot when going offline", async () => {
      call.mockResolvedValueOnce(ok(snap(2)))
      await holdLive()
      call.mockRejectedValue(new Error("gone"))
      await jest.advanceTimersByTimeAsync(GLANCE_PHONE_RENEW_MS)
      expect(store.getState()).toMatchObject({ status: "offline", snapshot: snap(2) })
    })

    it("is unavailable on glance_unavailable and retries after GLANCE_PHONE_RETRY_MS", async () => {
      call.mockResolvedValueOnce({ ok: false, code: "glance_unavailable" })
      await holdLive()
      expect(store.getState().status).toBe("unavailable")
      await jest.advanceTimersByTimeAsync(GLANCE_PHONE_RETRY_MS - 1)
      expect(visibleAnnouncements()).toHaveLength(1)
      await jest.advanceTimersByTimeAsync(1)
      expect(visibleAnnouncements()).toHaveLength(2)
      expect(store.getState().status).toBe("connecting")
    })

    it("is unavailable on a malformed response and retries", async () => {
      call.mockResolvedValueOnce({ nope: true })
      await holdLive()
      expect(store.getState().status).toBe("unavailable")
      await jest.advanceTimersByTimeAsync(GLANCE_PHONE_RETRY_MS)
      expect(visibleAnnouncements()).toHaveLength(2)
    })

    it("is unsupported on headless_host and stops renewing", async () => {
      call.mockResolvedValue({ ok: false, code: "headless_host" })
      await holdLive()
      expect(store.getState().status).toBe("unsupported")
      await jest.advanceTimersByTimeAsync(GLANCE_PHONE_RENEW_MS * 5)
      expect(visibleAnnouncements()).toHaveLength(1)
    })

    it("does not renew after the last holder released", async () => {
      const release = await holdLive()
      release()
      await jest.advanceTimersByTimeAsync(GLANCE_PHONE_RENEW_MS * 3)
      expect(visibleAnnouncements()).toHaveLength(1)
    })
  })

  describe("setDemand", () => {
    it("re-announces at once when the demand changes", async () => {
      await holdLive()
      const changed = {
        ...DEMAND,
        modules: ["fleet", "usage", "quota"] as GlanceRemoteDemand["modules"],
      }
      store.setDemand(changed)
      await flush()
      expect(visibleAnnouncements()).toHaveLength(2)
      expect(visibleAnnouncements()[1][1]).toMatchObject({ demand: changed })
      // The renewal clock restarts from the new announcement.
      await jest.advanceTimersByTimeAsync(GLANCE_PHONE_RENEW_MS - 1)
      expect(visibleAnnouncements()).toHaveLength(2)
    })

    it("does not re-announce an unchanged demand", async () => {
      await holdLive()
      store.setDemand({ ...DEMAND })
      await flush()
      expect(visibleAnnouncements()).toHaveLength(1)
    })

    it("does nothing without a holder", async () => {
      store.setDemand(DEMAND)
      await flush()
      expect(call).not.toHaveBeenCalled()
      expect(store.getState().status).toBe("idle")
    })

    it("re-announces from unsupported when the demand changes", async () => {
      call.mockResolvedValueOnce({ ok: false, code: "headless_host" })
      await holdLive()
      store.setDemand({ ...DEMAND, modules: ["pet"] })
      await flush()
      expect(visibleAnnouncements()).toHaveLength(2)
    })
  })

  describe("release", () => {
    it("ends the lease, detaches the event and goes idle, keeping the snapshot", async () => {
      call.mockResolvedValueOnce(ok(snap(4)))
      const release = await holdLive()
      release()
      expect(detach).toHaveBeenCalledTimes(1)
      expect(call).toHaveBeenLastCalledWith("glance_subscribe", {
        consumer: CONSUMER,
        visible: false,
        demand: DEMAND,
      })
      expect(store.getState()).toMatchObject({
        status: "idle",
        snapshot: snap(4),
        hostLabel: "Studio Mac",
      })
    })

    it("only ends the lease when the last holder releases", async () => {
      const a = await holdLive()
      const b = store.hold(DEMAND)
      a()
      expect(detach).not.toHaveBeenCalled()
      expect(store.getState().status).not.toBe("idle")
      b()
      expect(detach).toHaveBeenCalledTimes(1)
    })

    it("is idempotent per holder", async () => {
      const a = await holdLive()
      const b = store.hold(DEMAND)
      a()
      a()
      expect(detach).not.toHaveBeenCalled()
      b()
      expect(detach).toHaveBeenCalledTimes(1)
    })

    it("ignores a failing end-of-lease call", async () => {
      const release = await holdLive()
      call.mockRejectedValue(new Error("gone"))
      expect(() => release()).not.toThrow()
      await flush()
      expect(store.getState().status).toBe("idle")
    })

    it("ignores a response that arrives after release", async () => {
      let answer!: (value: unknown) => void
      call.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
      const release = await holdLive()
      release()
      answer(ok(snap(7)))
      await flush()
      expect(store.getState()).toMatchObject({ status: "idle", snapshot: null })
      await jest.advanceTimersByTimeAsync(GLANCE_PHONE_RENEW_MS * 2)
      expect(visibleAnnouncements()).toHaveLength(1)
    })

    it("ignores a failure that arrives after release", async () => {
      let fail!: (error: unknown) => void
      call.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
      const release = await holdLive()
      release()
      fail(new Error("late"))
      await flush()
      expect(store.getState().status).toBe("idle")
    })

    it("ignores a push from the old subscription after release", async () => {
      const release = await holdLive()
      const oldPush = push
      release()
      oldPush(snap(9))
      expect(store.getState()).toMatchObject({ status: "idle", snapshot: null })
    })

    it("a fresh hold after release subscribes again", async () => {
      const release = await holdLive()
      release()
      await holdLive()
      expect(subscribe).toHaveBeenCalledTimes(2)
      expect(visibleAnnouncements()).toHaveLength(2)
    })
  })

  describe("request", () => {
    it("sends refresh with the consumer id", async () => {
      call.mockResolvedValue({ ok: true })
      await expect(store.request({ kind: "refresh" })).resolves.toBeNull()
      expect(call).toHaveBeenCalledWith("glance_request", { consumer: CONSUMER, kind: "refresh" })
    })

    it("sends quota-refresh with its key", async () => {
      call.mockResolvedValue({ ok: true })
      await expect(store.request({ kind: "quota-refresh", key: "anthropic:a" })).resolves.toBeNull()
      expect(call).toHaveBeenCalledWith("glance_request", {
        consumer: CONSUMER,
        kind: "quota-refresh",
        key: "anthropic:a",
      })
    })

    it("sends quota-enable as its own command, without the consumer", async () => {
      call.mockResolvedValue({ ok: true })
      await expect(
        store.request({ kind: "quota-enable", provider: "anthropic", accountId: "acc" })
      ).resolves.toBeNull()
      expect(call).toHaveBeenCalledWith("glance_quota_enable", {
        provider: "anthropic",
        accountId: "acc",
      })
    })

    it.each([
      [{ ok: false, code: "errors.quotaRefresh" }, "errors.quotaRefresh"],
      [{ ok: false, code: "glance_unavailable" }, "errors.hostUnavailable"],
      [{ ok: false, code: "headless_host" }, "errors.hostUnavailable"],
      [{ ok: false, code: "glance_invalid_request" }, "errors.requestFailed"],
      [{ weird: true }, "errors.requestFailed"],
      [null, "errors.requestFailed"],
    ])("maps the answer %j to %s", async (answer, key) => {
      call.mockResolvedValue(answer)
      await expect(store.request({ kind: "refresh" })).resolves.toBe(key)
    })

    it("maps a failed call to errors.hostUnreachable", async () => {
      call.mockRejectedValue(new Error("offline"))
      await expect(store.request({ kind: "refresh" })).resolves.toBe("errors.hostUnreachable")
      await expect(
        store.request({ kind: "quota-enable", provider: "p", accountId: "a" })
      ).resolves.toBe("errors.hostUnreachable")
    })
  })

  describe("reset", () => {
    it("drops everything, including the kept snapshot, and rebuilds deps next time", async () => {
      call.mockResolvedValueOnce(ok(snap(1)))
      await holdLive()
      store.reset()
      expect(store.getState()).toEqual({
        status: "idle",
        snapshot: null,
        receivedAt: null,
        hostLabel: null,
      })
      expect(makeDeps).toHaveBeenCalledTimes(1)
      await holdLive()
      expect(makeDeps).toHaveBeenCalledTimes(2)
    })
  })
})

describe("glancePhoneStore", () => {
  it("is one shared idle store", () => {
    expect(glancePhoneStore).toBeInstanceOf(GlancePhoneStore)
    expect(glancePhoneStore.getState().status).toBe("idle")
  })
})
