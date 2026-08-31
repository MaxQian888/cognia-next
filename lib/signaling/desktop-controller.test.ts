/**
 * Verifies the normalize step that bridges renderer-side `RTCIceServer`
 * shapes into the wire format the Rust `companion_signaling_configure`
 * command expects, plus the ADR-0021 TURN-provider patch builder + wiring.
 */

jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: jest.fn(async () => undefined) },
}))

import {
  buildSignalingConfigPatch,
  installDesktopSignalingController,
  normalizeServers,
  selectSignalingDevices,
} from "./desktop-controller"
import type { PairedDeviceRow } from "@/types/mobile/paired-device"
import { transport } from "@/lib/tauri/transport-instance"
import {
  resetWanWakeOverridesForTests,
  sleepDeviceForWan,
  wakeDeviceForWan,
} from "./wan-wake-overrides"
import type { AppSettings } from "@cognia/agent-config-types"

const mockCall = transport.call as jest.Mock

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return {
    id: "singleton",
    alwaysAllowTools: [],
    builtinTools: {} as never,
    ...patch,
  } as AppSettings
}

/** Pinned clock. Every dormancy assertion below is relative to it. */
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

function deviceRow(patch: Partial<PairedDeviceRow> = {}): PairedDeviceRow {
  return {
    deviceId: "d1",
    label: "Phone",
    platform: "ios",
    pubkey: "pk",
    appVersion: "1.0.0",
    pairedAt: NOW - DAY,
    lastSeenAt: NOW - DAY,
    allowRemoteTerminal: false,
    rendezvousId: "r1",
    signalingKeyRef: "kr:d1",
    signalingRoomDescriptor: {
      v: 2,
      roomId: "r1",
      roomNonce: "nonce",
      desktopSigningKey: "desktop-key",
      mobileSigningKey: "mobile-key",
      notAfter: 1_800_000_000_000,
    },
    ...patch,
  } as PairedDeviceRow
}

describe("selectSignalingDevices", () => {
  it("returns a registration for a fully-provisioned active device", () => {
    expect(selectSignalingDevices([deviceRow()], { now: NOW })).toEqual([
      {
        deviceId: "d1",
        rendezvousId: "r1",
        roomDescriptor: deviceRow().signalingRoomDescriptor,
        signalingKeyRef: "kr:d1",
      },
    ])
  })

  it("drops a paused device, whose JWT is on the Rust deny-list, so the socket could never serve a request", () => {
    expect(selectSignalingDevices([deviceRow({ pausedAt: NOW })], { now: NOW })).toEqual([])
  })

  it("drops a revoked device", () => {
    expect(selectSignalingDevices([deviceRow({ revokedAt: NOW })], { now: NOW })).toEqual([])
  })

  it("drops devices that were paired before the signaling fields existed", () => {
    const at = { now: NOW }
    expect(selectSignalingDevices([deviceRow({ rendezvousId: undefined })], at)).toEqual([])
    expect(selectSignalingDevices([deviceRow({ signalingKeyRef: undefined })], at)).toEqual([])
    expect(selectSignalingDevices([deviceRow({ signalingRoomDescriptor: undefined })], at)).toEqual(
      []
    )
  })

  it("drops a v1 room descriptor", () => {
    const row = deviceRow()
    const legacy = { ...row.signalingRoomDescriptor!, v: 1 as unknown as 2 }
    expect(
      selectSignalingDevices([deviceRow({ signalingRoomDescriptor: legacy })], { now: NOW })
    ).toEqual([])
  })

  it("keeps only the eligible rows out of a mixed list", () => {
    const rows = [
      deviceRow({ deviceId: "keep", rendezvousId: "r-keep" }),
      deviceRow({ deviceId: "paused", rendezvousId: "r-paused", pausedAt: 1 }),
      deviceRow({ deviceId: "revoked", rendezvousId: "r-revoked", revokedAt: 1 }),
    ]
    expect(selectSignalingDevices(rows, { now: NOW }).map((d) => d.deviceId)).toEqual(["keep"])
  })

  describe("dormancy", () => {
    it("drops a device that has been silent for more than 30 days", () => {
      // The row itself is untouched. This decides one thing only: whether the
      // hub spawns a client task, i.e. whether a permanent WSS socket exists.
      const stale = deviceRow({ lastSeenAt: NOW - 31 * DAY, pairedAt: NOW - 400 * DAY })
      expect(selectSignalingDevices([stale], { now: NOW })).toEqual([])
    })

    it("keeps a device seen inside the window", () => {
      const fresh = deviceRow({ lastSeenAt: NOW - 29 * DAY, pairedAt: NOW - 400 * DAY })
      expect(selectSignalingDevices([fresh], { now: NOW })).toHaveLength(1)
    })

    it("keeps a device that just paired and has not made a request yet", () => {
      // The pairing flow is itself waiting on this connection, so falling back
      // to `pairedAt` is what keeps a new phone from being born dormant.
      const justPaired = deviceRow({ lastSeenAt: 0, pairedAt: NOW })
      expect(selectSignalingDevices([justPaired], { now: NOW })).toHaveLength(1)
    })

    it("trims a realistic accumulated list down to the devices still in use", () => {
      const rows = [
        deviceRow({ deviceId: "phone", rendezvousId: "r-phone", lastSeenAt: NOW - 60_000 }),
        deviceRow({ deviceId: "tablet", rendezvousId: "r-tablet", lastSeenAt: NOW - 3 * DAY }),
        deviceRow({
          deviceId: "old-reinstall",
          rendezvousId: "r-old",
          lastSeenAt: NOW - 120 * DAY,
          pairedAt: NOW - 200 * DAY,
        }),
        deviceRow({
          deviceId: "dev-pairing",
          rendezvousId: "r-dev",
          lastSeenAt: NOW - 45 * DAY,
          pairedAt: NOW - 45 * DAY,
        }),
      ]
      expect(selectSignalingDevices(rows, { now: NOW }).map((d) => d.deviceId)).toEqual([
        "phone",
        "tablet",
      ])
    })

    it("defaults `now` to the wall clock, so a caller that omits it still gets the rule", () => {
      const stale = deviceRow({ lastSeenAt: 1, pairedAt: 1 })
      expect(selectSignalingDevices([stale])).toEqual([])
      const fresh = deviceRow({ lastSeenAt: Date.now(), pairedAt: Date.now() })
      expect(selectSignalingDevices([fresh])).toHaveLength(1)
    })
  })

  describe("manual wake", () => {
    it("reconnects a dormant device the owner explicitly woke", () => {
      const stale = deviceRow({ lastSeenAt: NOW - 120 * DAY, pairedAt: NOW - 200 * DAY })
      expect(
        selectSignalingDevices([stale], { now: NOW, wokenDeviceIds: new Set(["d1"]) })
      ).toHaveLength(1)
    })

    it("waives dormancy and nothing else: a woken revoked device stays disconnected", () => {
      const woken = new Set(["d1"])
      const at = { now: NOW, wokenDeviceIds: woken }
      expect(selectSignalingDevices([deviceRow({ revokedAt: NOW })], at)).toEqual([])
      expect(selectSignalingDevices([deviceRow({ pausedAt: NOW })], at)).toEqual([])
      expect(selectSignalingDevices([deviceRow({ rendezvousId: undefined })], at)).toEqual([])
    })

    it("wakes only the named device", () => {
      const stale = { lastSeenAt: NOW - 90 * DAY, pairedAt: NOW - 300 * DAY }
      const rows = [
        deviceRow({ deviceId: "wanted", rendezvousId: "r-wanted", ...stale }),
        deviceRow({ deviceId: "other", rendezvousId: "r-other", ...stale }),
      ]
      expect(
        selectSignalingDevices(rows, { now: NOW, wokenDeviceIds: new Set(["wanted"]) }).map(
          (d) => d.deviceId
        )
      ).toEqual(["wanted"])
    })

    it("is harmless for a device that was never dormant", () => {
      expect(
        selectSignalingDevices([deviceRow()], { now: NOW, wokenDeviceIds: new Set(["d1"]) })
      ).toHaveLength(1)
    })
  })
})

describe("normalizeServers", () => {
  it("returns undefined for absent input", () => {
    expect(normalizeServers(undefined)).toBeUndefined()
  })

  it("wraps a single URL string into an array", () => {
    expect(normalizeServers([{ urls: "stun:s.example:3478" }])).toEqual([
      { urls: ["stun:s.example:3478"], username: undefined, credential: undefined },
    ])
  })

  it("preserves multi-URL arrays", () => {
    expect(normalizeServers([{ urls: ["stun:a.example", "stun:b.example"] }])).toEqual([
      { urls: ["stun:a.example", "stun:b.example"], username: undefined, credential: undefined },
    ])
  })

  it("forwards username + credential strings", () => {
    expect(
      normalizeServers([
        {
          urls: "turn:t.example",
          username: "alice",
          credential: "s3cr3t",
        },
      ])
    ).toEqual([{ urls: ["turn:t.example"], username: "alice", credential: "s3cr3t" }])
  })

  it("stringifies non-string credentials (defensive — TURN spec allows oauth tokens)", () => {
    expect(
      normalizeServers([
        {
          urls: "turn:t.example",
          username: "alice",
          // OAuth credential type (object) — keeps the Rust side string-typed
          credential: { value: 42 } as unknown as string,
        },
      ])
    ).toEqual([
      {
        urls: ["turn:t.example"],
        username: "alice",
        credential: "[object Object]",
      },
    ])
  })
})

describe("buildSignalingConfigPatch", () => {
  it("merges static (resolved) TURN and provider servers into turnServers", () => {
    const patch = buildSignalingConfigPatch(
      settings({
        webrtcEnabled: true,
        signalingUrl: "wss://sig.example/signaling",
        iceServers: [{ urls: "stun:s" }],
      }),
      [{ urls: "turn:static", username: "u", credential: "c" }],
      [{ urls: "turn:prov" }]
    )
    expect(patch.enabled).toBe(true)
    expect(patch.signalingUrl).toBe("wss://sig.example/signaling")
    expect(patch.iceServers).toEqual([
      { urls: ["stun:s"], username: undefined, credential: undefined },
    ])
    expect(patch.turnServers).toEqual([
      { urls: ["turn:static"], username: "u", credential: "c" },
      { urls: ["turn:prov"], username: undefined, credential: undefined },
    ])
  })

  it("falls back to default STUN + empty TURN when unset", () => {
    const patch = buildSignalingConfigPatch(settings(), [], [])
    expect(patch.iceServers).toEqual([
      { urls: ["stun:stun.l.google.com:19302"] },
      { urls: ["stun:stun.cloudflare.com:3478"] },
    ])
    expect(patch.turnServers).toEqual([])
    expect(patch.enabled).toBe(true)
  })

  it("ignores fields the hub does not consume, so an unrelated settings write yields an identical patch", () => {
    // This is what makes the push dedupe worth having: the settings `liveQuery`
    // watches ONE Dexie row, so it re-emits for every field any of the ~169
    // `saveSettings` call sites touches, and `saveSettings` bumps `updatedAt`
    // unconditionally. None of that reaches the patch, so the hub must never
    // see it — an accepted patch tears down one WSS per paired device and
    // re-runs every handshake.
    const signaling = {
      webrtcEnabled: true,
      signalingUrl: "wss://sig.example/signaling",
      iceServers: [{ urls: "stun:s" }],
    }
    const before = buildSignalingConfigPatch(
      settings({ ...signaling, updatedAt: 1_000, theme: "light" }),
      [],
      []
    )
    const after = buildSignalingConfigPatch(
      settings({ ...signaling, updatedAt: 2_000, theme: "dark" }),
      [],
      []
    )
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  })

  it("respects webrtcEnabled === false", () => {
    expect(buildSignalingConfigPatch(settings({ webrtcEnabled: false }), [], []).enabled).toBe(
      false
    )
  })
})

describe("installDesktopSignalingController — TURN provisioner", () => {
  beforeEach(() => mockCall.mockClear())

  it("starts a provisioner, pushes a configure patch with the merged provider servers, and stops on uninstall", async () => {
    const stop = jest.fn()
    let startCount = 0
    const uninstall = installDesktopSignalingController({
      isTauriOverride: true,
      // Keeps the read off Dexie, which has no database in the node project.
      listPairedDevicesOverride: async () => [],
      getSettingsOverride: async () =>
        settings({
          webrtcEnabled: true,
          turnProvider: { kind: "cloudflare-calls", cloudflareKeyId: "k", secretRef: "kr:s" },
        }),
      startTurnProvisionerOverride: () => {
        startCount++
        return { current: () => [{ urls: "turn:prov" }], stop }
      },
    })
    await new Promise((r) => setTimeout(r, 10))

    expect(startCount).toBe(1)
    const configureCalls = mockCall.mock.calls.filter(
      (c) => c[0] === "companion_signaling_configure"
    )
    expect(configureCalls.length).toBeGreaterThanOrEqual(1)
    const patch = configureCalls.at(-1)![1].patch as { turnServers: unknown[] }
    expect(patch.turnServers).toContainEqual({
      urls: ["turn:prov"],
      username: undefined,
      credential: undefined,
    })

    uninstall()
    expect(stop).toHaveBeenCalled()
  })

  it("still pushes when the patch actually changes, and stops again once it settles", async () => {
    let refresh: ((servers: RTCIceServer[]) => void) | undefined
    const uninstall = installDesktopSignalingController({
      isTauriOverride: true,
      // Keeps the read off Dexie, which has no database in the node project.
      listPairedDevicesOverride: async () => [],
      getSettingsOverride: async () =>
        settings({
          webrtcEnabled: true,
          turnProvider: { kind: "cloudflare-calls", cloudflareKeyId: "k", secretRef: "kr:s" },
        }),
      startTurnProvisionerOverride: ({ onRefresh }) => {
        refresh = onRefresh
        return { current: () => [], stop: () => {} }
      },
    })
    await new Promise((r) => setTimeout(r, 10))
    const baseline = mockCall.mock.calls.filter(
      (c) => c[0] === "companion_signaling_configure"
    ).length

    // A provisioner refresh with new relays is a real change.
    refresh!([{ urls: "turn:prov-1" }])
    await new Promise((r) => setTimeout(r, 10))
    const afterChange = mockCall.mock.calls.filter(
      (c) => c[0] === "companion_signaling_configure"
    ).length
    expect(afterChange).toBe(baseline + 1)

    // The same relays again produce the same patch — nothing to push.
    refresh!([{ urls: "turn:prov-1" }])
    await new Promise((r) => setTimeout(r, 10))
    expect(
      mockCall.mock.calls.filter((c) => c[0] === "companion_signaling_configure")
    ).toHaveLength(afterChange)

    uninstall()
  })

  it("retries an identical patch after a failed push instead of stranding the hub on the old config", async () => {
    let refresh: ((servers: RTCIceServer[]) => void) | undefined
    mockCall.mockImplementation(async (command: string) => {
      if (command === "companion_signaling_configure") throw new Error("hub unreachable")
      return undefined
    })
    const uninstall = installDesktopSignalingController({
      isTauriOverride: true,
      // Keeps the read off Dexie, which has no database in the node project.
      listPairedDevicesOverride: async () => [],
      getSettingsOverride: async () =>
        settings({
          webrtcEnabled: true,
          turnProvider: { kind: "cloudflare-calls", cloudflareKeyId: "k", secretRef: "kr:s" },
        }),
      startTurnProvisionerOverride: ({ onRefresh }) => {
        refresh = onRefresh
        return { current: () => [], stop: () => {} }
      },
    })
    await new Promise((r) => setTimeout(r, 10))
    const failed = mockCall.mock.calls.filter(
      (c) => c[0] === "companion_signaling_configure"
    ).length
    expect(failed).toBeGreaterThanOrEqual(1)

    // Same patch as the one that failed: it must go out again, not be deduped
    // against a push the hub never accepted.
    mockCall.mockImplementation(async () => undefined)
    refresh!([])
    await new Promise((r) => setTimeout(r, 10))
    expect(mockCall.mock.calls.filter((c) => c[0] === "companion_signaling_configure").length).toBe(
      failed + 1
    )

    uninstall()
  })

  it("does not start a provisioner when no provider is configured", async () => {
    let startCount = 0
    const uninstall = installDesktopSignalingController({
      isTauriOverride: true,
      // Keeps the read off Dexie, which has no database in the node project.
      listPairedDevicesOverride: async () => [],
      getSettingsOverride: async () => settings({ webrtcEnabled: true }),
      startTurnProvisionerOverride: () => {
        startCount++
        return { current: () => [], stop: () => {} }
      },
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(startCount).toBe(0)
    uninstall()
  })
})

describe("installDesktopSignalingController — waking a dormant device", () => {
  /** Latest device list the controller pushed to the hub. */
  function lastSyncedDeviceIds(): string[] | null {
    const calls = mockCall.mock.calls.filter((c) => c[0] === "companion_signaling_sync_devices")
    if (calls.length === 0) return null
    return (calls.at(-1)![1].devices as { deviceId: string }[]).map((d) => d.deviceId)
  }

  const settle = () => new Promise((r) => setTimeout(r, 10))

  // Silent for four months, so the dormancy rule leaves it out.
  const dormant = () => [
    deviceRow({ lastSeenAt: Date.now() - 120 * DAY, pairedAt: Date.now() - 200 * DAY }),
  ]

  beforeEach(() => {
    mockCall.mockClear()
    mockCall.mockImplementation(async () => undefined)
    resetWanWakeOverridesForTests()
  })

  afterEach(() => {
    resetWanWakeOverridesForTests()
  })

  it("re-pushes the hub's device list so a woken device gets a client task", async () => {
    // `SignalingHub::reconnect_device` cannot do this on its own: it resolves
    // the device out of `pending_devices`, which is the last list this push
    // produced, so a dormant device is unknown to it until the push includes
    // it. This re-push is what makes the manual wake work at all.
    const uninstall = installDesktopSignalingController({
      isTauriOverride: true,
      getSettingsOverride: async () => settings({ webrtcEnabled: true }),
      listPairedDevicesOverride: async () => dormant(),
    })
    await settle()
    expect(lastSyncedDeviceIds()).toEqual([])

    wakeDeviceForWan("d1")
    await settle()
    expect(lastSyncedDeviceIds()).toEqual(["d1"])

    // Letting it sleep again hands the decision back to the dormancy rule.
    sleepDeviceForWan("d1")
    await settle()
    expect(lastSyncedDeviceIds()).toEqual([])

    uninstall()
  })

  /**
   * `[]` is not "nothing to say", it means "cancel every client you hold", and
   * the hub holds clients `refresh_installed_hub` spawned from the Rust
   * registration store that the renderer never pushed. A wake carries no rows
   * of its own, so it must not be able to send that list before Dexie has
   * answered, or after the read failed and left the cache empty.
   */
  it("does not push an empty device list when the paired-device read failed", async () => {
    const uninstall = installDesktopSignalingController({
      isTauriOverride: true,
      getSettingsOverride: async () => settings({ webrtcEnabled: true }),
      listPairedDevicesOverride: async () => {
        throw new Error("content cipher locked")
      },
    })
    await settle()
    expect(lastSyncedDeviceIds()).toBeNull()

    wakeDeviceForWan("d1")
    await settle()
    expect(lastSyncedDeviceIds()).toBeNull()

    uninstall()
  })

  it("stops listening for wakes once uninstalled", async () => {
    const uninstall = installDesktopSignalingController({
      isTauriOverride: true,
      getSettingsOverride: async () => settings({ webrtcEnabled: true }),
      listPairedDevicesOverride: async () => dormant(),
    })
    await settle()
    uninstall()
    const before = mockCall.mock.calls.filter(
      (c) => c[0] === "companion_signaling_sync_devices"
    ).length

    wakeDeviceForWan("d1")
    await settle()
    expect(
      mockCall.mock.calls.filter((c) => c[0] === "companion_signaling_sync_devices")
    ).toHaveLength(before)
  })
})
