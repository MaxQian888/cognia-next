import type { GlanceSnapshotV1 } from "@/lib/glance/snapshot"

jest.mock("@/lib/platform/detect", () => ({ detectPlatform: jest.fn(() => "web") }))

import { detectPlatform } from "@/lib/platform/detect"

import { dispatchGlanceHostCommand, type GlanceHostDispatchDeps } from "./host-dispatch"
import { GlanceRemoteHub, glanceRemoteHub, type GlanceRemoteExecutor } from "./host-hub"
import type { GlanceRemoteDemand } from "./types"

const detectMock = detectPlatform as jest.Mock

const TTL = 60_000
const T0 = 2_000_000

const DEMAND: GlanceRemoteDemand = {
  modules: ["fleet", "quota"],
  catalog: false,
  scope: "all",
  workspaceId: null,
  usage: { scope: "cognia", showSpend: false },
  activity: { range: "3m" },
}

function subscribePayload(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { consumer: "phone-1", visible: true, demand: DEMAND, callerDeviceId: "dev-A", ...patch }
}

describe("dispatchGlanceHostCommand", () => {
  let hub: GlanceRemoteHub
  let now: number
  let ex: { [K in keyof GlanceRemoteExecutor]: jest.Mock }

  function deps(patch: Partial<GlanceHostDispatchDeps> = {}): GlanceHostDispatchDeps {
    return { platform: "tauri", hub, now: () => now, ...patch }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    hub = new GlanceRemoteHub(TTL)
    now = T0
    ex = {
      refresh: jest.fn(async () => null),
      quotaRefresh: jest.fn(async () => null),
      quotaEnable: jest.fn(async () => null),
    }
    hub.setExecutor(ex)
  })

  it("throws for a command outside the glance family", async () => {
    await expect(dispatchGlanceHostCommand("pet_act", {}, deps())).rejects.toThrow(
      "unsupported glance command: pet_act"
    )
  })

  it.each(["glance_subscribe", "glance_request", "glance_quota_enable"])(
    "%s answers headless_host off Tauri without touching the hub",
    async (command) => {
      const announce = jest.spyOn(hub, "announce")
      await expect(
        dispatchGlanceHostCommand(command, subscribePayload(), deps({ platform: "web" }))
      ).resolves.toEqual({ ok: false, code: "headless_host" })
      expect(announce).not.toHaveBeenCalled()
      expect(ex.refresh).not.toHaveBeenCalled()
    }
  )

  it("detects the platform when none is injected", async () => {
    detectMock.mockReturnValue("web")
    await expect(
      dispatchGlanceHostCommand("glance_subscribe", subscribePayload(), { hub, now: () => now })
    ).resolves.toEqual({ ok: false, code: "headless_host" })
    expect(detectMock).toHaveBeenCalled()
  })

  describe("glance_subscribe", () => {
    it("records a lease keyed on the device and consumer and answers the ttl", async () => {
      const out = await dispatchGlanceHostCommand("glance_subscribe", subscribePayload(), deps())
      expect(out).toEqual({ ok: true, snapshot: null, ttlMs: TTL })
      expect(hub.hasLive(T0)).toBe(true)
      expect(hub.demand(T0)).toEqual(DEMAND)
    })

    it("answers the newest snapshot the publisher built", async () => {
      await dispatchGlanceHostCommand("glance_subscribe", subscribePayload(), deps())
      const snap = { marker: "latest" } as unknown as GlanceSnapshotV1
      hub.setLatest(snap)
      now = T0 + 20_000
      await expect(
        dispatchGlanceHostCommand("glance_subscribe", subscribePayload(), deps())
      ).resolves.toEqual({ ok: true, snapshot: snap, ttlMs: TTL })
    })

    it("answers a null snapshot when ending the lease, and ends it", async () => {
      await dispatchGlanceHostCommand("glance_subscribe", subscribePayload(), deps())
      hub.setLatest({ marker: "latest" } as unknown as GlanceSnapshotV1)
      await expect(
        dispatchGlanceHostCommand("glance_subscribe", subscribePayload({ visible: false }), deps())
      ).resolves.toEqual({ ok: true, snapshot: null, ttlMs: TTL })
      expect(hub.hasLive(T0)).toBe(false)
    })

    it("keeps two devices with the same consumer id as separate leases", async () => {
      await dispatchGlanceHostCommand(
        "glance_subscribe",
        subscribePayload({ callerDeviceId: "dev-A", demand: { ...DEMAND, modules: ["usage"] } }),
        deps()
      )
      await dispatchGlanceHostCommand(
        "glance_subscribe",
        subscribePayload({ callerDeviceId: "dev-B", demand: { ...DEMAND, modules: ["pet"] } }),
        deps()
      )
      expect(hub.demand(T0)?.modules).toEqual(["usage", "pet"])
    })

    it("does not let one device end another's lease with the same consumer id", async () => {
      await dispatchGlanceHostCommand("glance_subscribe", subscribePayload(), deps())
      await dispatchGlanceHostCommand(
        "glance_subscribe",
        subscribePayload({ callerDeviceId: "dev-B", visible: false }),
        deps()
      )
      expect(hub.hasLive(T0)).toBe(true)
      expect(hub.demand(T0)).toEqual(DEMAND)
    })

    it("uses the injected clock for the lease", async () => {
      await dispatchGlanceHostCommand("glance_subscribe", subscribePayload(), deps())
      expect(hub.hasLive(T0 + TTL - 1)).toBe(true)
      expect(hub.hasLive(T0 + TTL)).toBe(false)
    })

    it.each([
      ["no callerDeviceId", { callerDeviceId: undefined }],
      ["an empty callerDeviceId", { callerDeviceId: "" }],
      ["a numeric callerDeviceId", { callerDeviceId: 7 }],
      ["a bad demand", { demand: { ...DEMAND, modules: ["recents"] } }],
      ["no consumer", { consumer: undefined }],
      ["a string visible", { visible: "yes" }],
    ])("refuses %s as invalid without recording a lease", async (_name, patch) => {
      await expect(
        dispatchGlanceHostCommand("glance_subscribe", subscribePayload(patch), deps())
      ).resolves.toEqual({ ok: false, code: "glance_invalid_request" })
      expect(hub.hasLive(T0)).toBe(false)
    })

    it("answers glance_unavailable and records nothing with no executor", async () => {
      hub.setExecutor(null)
      await expect(
        dispatchGlanceHostCommand("glance_subscribe", subscribePayload(), deps())
      ).resolves.toEqual({ ok: false, code: "glance_unavailable" })
      expect(hub.hasLive(T0)).toBe(false)
    })

    it("still ends a lease when the publisher has gone away", async () => {
      await dispatchGlanceHostCommand("glance_subscribe", subscribePayload(), deps())
      hub.setExecutor(null)
      await expect(
        dispatchGlanceHostCommand("glance_subscribe", subscribePayload({ visible: false }), deps())
      ).resolves.toEqual({ ok: true, snapshot: null, ttlMs: TTL })
      expect(hub.hasLive(T0)).toBe(false)
    })
  })

  describe("glance_request", () => {
    it("runs a refresh through the executor", async () => {
      await expect(
        dispatchGlanceHostCommand("glance_request", { consumer: "c", kind: "refresh" }, deps())
      ).resolves.toEqual({ ok: true })
      expect(ex.refresh).toHaveBeenCalledTimes(1)
      expect(ex.quotaRefresh).not.toHaveBeenCalled()
    })

    it("runs a quota refresh for one key", async () => {
      await expect(
        dispatchGlanceHostCommand(
          "glance_request",
          { consumer: "c", kind: "quota-refresh", key: "anthropic:a" },
          deps()
        )
      ).resolves.toEqual({ ok: true })
      expect(ex.quotaRefresh).toHaveBeenCalledWith("anthropic:a")
      expect(ex.refresh).not.toHaveBeenCalled()
    })

    it("maps an error key to a refusal", async () => {
      ex.quotaRefresh.mockResolvedValue("errors.quotaRefresh")
      await expect(
        dispatchGlanceHostCommand(
          "glance_request",
          { consumer: "c", kind: "quota-refresh", key: "k" },
          deps()
        )
      ).resolves.toEqual({ ok: false, code: "errors.quotaRefresh" })
    })

    it("maps a throw to errors.requestFailed", async () => {
      ex.refresh.mockRejectedValue(new Error("boom"))
      await expect(
        dispatchGlanceHostCommand("glance_request", { consumer: "c", kind: "refresh" }, deps())
      ).resolves.toEqual({ ok: false, code: "errors.requestFailed" })
    })

    it("refuses a malformed request", async () => {
      await expect(
        dispatchGlanceHostCommand("glance_request", { consumer: "c", kind: "wipe" }, deps())
      ).resolves.toEqual({ ok: false, code: "glance_invalid_request" })
      expect(ex.refresh).not.toHaveBeenCalled()
    })

    it("answers glance_unavailable with no executor", async () => {
      hub.setExecutor(null)
      await expect(
        dispatchGlanceHostCommand("glance_request", { consumer: "c", kind: "refresh" }, deps())
      ).resolves.toEqual({ ok: false, code: "glance_unavailable" })
    })

    it("does not need a lease", async () => {
      expect(hub.hasLive(T0)).toBe(false)
      await expect(
        dispatchGlanceHostCommand("glance_request", { consumer: "c", kind: "refresh" }, deps())
      ).resolves.toEqual({ ok: true })
    })
  })

  describe("glance_quota_enable", () => {
    it("runs through the executor", async () => {
      await expect(
        dispatchGlanceHostCommand(
          "glance_quota_enable",
          { provider: "anthropic", accountId: "acc" },
          deps()
        )
      ).resolves.toEqual({ ok: true })
      expect(ex.quotaEnable).toHaveBeenCalledWith("anthropic", "acc")
    })

    it("maps an error key to a refusal", async () => {
      ex.quotaEnable.mockResolvedValue("errors.quotaEnable")
      await expect(
        dispatchGlanceHostCommand(
          "glance_quota_enable",
          { provider: "anthropic", accountId: "acc" },
          deps()
        )
      ).resolves.toEqual({ ok: false, code: "errors.quotaEnable" })
    })

    it("maps a throw to errors.requestFailed", async () => {
      ex.quotaEnable.mockRejectedValue(new Error("vault locked"))
      await expect(
        dispatchGlanceHostCommand(
          "glance_quota_enable",
          { provider: "anthropic", accountId: "acc" },
          deps()
        )
      ).resolves.toEqual({ ok: false, code: "errors.requestFailed" })
    })

    it("refuses a malformed payload", async () => {
      await expect(
        dispatchGlanceHostCommand("glance_quota_enable", { provider: "anthropic" }, deps())
      ).resolves.toEqual({ ok: false, code: "glance_invalid_request" })
      expect(ex.quotaEnable).not.toHaveBeenCalled()
    })

    it("answers glance_unavailable with no executor", async () => {
      hub.setExecutor(null)
      await expect(
        dispatchGlanceHostCommand(
          "glance_quota_enable",
          { provider: "anthropic", accountId: "acc" },
          deps()
        )
      ).resolves.toEqual({ ok: false, code: "glance_unavailable" })
    })
  })

  it("defaults to the shared hub", async () => {
    const exShared = {
      refresh: jest.fn(async () => null),
      quotaRefresh: jest.fn(async () => null),
      quotaEnable: jest.fn(async () => null),
    }
    const uninstall = glanceRemoteHub.setExecutor(exShared)
    try {
      await expect(
        dispatchGlanceHostCommand(
          "glance_request",
          { consumer: "c", kind: "refresh" },
          { platform: "tauri" }
        )
      ).resolves.toEqual({ ok: true })
      expect(exShared.refresh).toHaveBeenCalledTimes(1)
    } finally {
      uninstall()
    }
  })
})
