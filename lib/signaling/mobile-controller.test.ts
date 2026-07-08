/** @jest-environment jsdom */
/**
 * Mobile-controller — covers the `applySettings` reducer that the
 * production `installMobileSignalingController` plumbs through
 * `dexie.liveQuery`. Exercising the reducer directly avoids the
 * `liveQuery` timing race that fake-indexeddb exhibits under Jest.
 */

import {
  applySettings,
  installMobileSignalingController,
  LAN_RERESOLVE_MIN_SPACING_MS,
  REUPGRADE_MIN_SPACING_MS,
} from "./mobile-controller"
import {
  __resetCompanionConfigCacheForTests,
  saveCompanionConfig,
} from "@/lib/tauri/transport-companion"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import type { NetworkStatus } from "@/lib/capacitor/network"
import type { AppSettings } from "@/lib/claude/types"

class FakeTransport {
  readonly enableCalls: Array<{
    signalingUrl: string
    rtcConfiguration?: RTCConfiguration
  }> = []
  disableCount = 0
  reconnectWsCount = 0
  onLan = false
  async enableWebRtcTier(opts: {
    signalingUrl: string
    rtcConfiguration?: RTCConfiguration
  }): Promise<void> {
    this.enableCalls.push({
      signalingUrl: opts.signalingUrl,
      rtcConfiguration: opts.rtcConfiguration,
    })
  }
  disableWebRtcTier(): void {
    this.disableCount++
  }
  isOnConnectedLan(): boolean {
    return this.onLan
  }
  reconnectWs(): void {
    this.reconnectWsCount++
  }
}

type Tx = import("@/lib/tauri/transport-companion").CompanionTransport

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return {
    id: "singleton",
    alwaysAllowTools: [],
    builtinTools: {} as never,
    ...patch,
  } as AppSettings
}

describe("applySettings", () => {
  it("calls enableWebRtcTier with the configured signaling URL and merged ICE/TURN list", async () => {
    const tx = new FakeTransport()
    await applySettings(
      tx as unknown as Tx,
      settings({
        webrtcEnabled: true,
        signalingUrl: "wss://my.signaling.example/v1/signaling",
        iceServers: [{ urls: "stun:stun.example:3478" }],
        turnServers: [{ urls: "turn:turn.example:3478", username: "u", credential: "p" }],
      })
    )
    expect(tx.enableCalls.length).toBe(1)
    expect(tx.enableCalls[0].signalingUrl).toBe("wss://my.signaling.example/v1/signaling")
    expect(tx.enableCalls[0].rtcConfiguration?.iceServers).toEqual([
      { urls: "stun:stun.example:3478" },
      { urls: "turn:turn.example:3478", username: "u", credential: "p" },
    ])
  })

  it("falls back to defaults when no signaling URL or ICE servers are set", async () => {
    const tx = new FakeTransport()
    await applySettings(tx as unknown as Tx, settings({ webrtcEnabled: true }))
    expect(tx.enableCalls.length).toBe(1)
    expect(tx.enableCalls[0].signalingUrl).toBe("wss://signaling.cognia.cn/v1/signaling")
    expect(tx.enableCalls[0].rtcConfiguration?.iceServers).toEqual([
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
    ])
  })

  it("disables the tier when webrtcEnabled is false", async () => {
    const tx = new FakeTransport()
    await applySettings(tx as unknown as Tx, settings({ webrtcEnabled: false }))
    expect(tx.disableCount).toBe(1)
    expect(tx.enableCalls).toEqual([])
  })

  it("treats undefined webrtcEnabled as opt-in default", async () => {
    const tx = new FakeTransport()
    await applySettings(tx as unknown as Tx, settings())
    expect(tx.enableCalls.length).toBe(1)
    expect(tx.disableCount).toBe(0)
  })

  it("tears down the tier (LAN-first) when already on a connected LAN", async () => {
    const tx = new FakeTransport()
    tx.onLan = true
    await applySettings(tx as unknown as Tx, settings({ webrtcEnabled: true }))
    expect(tx.disableCount).toBe(1)
    expect(tx.enableCalls).toEqual([])
  })

  it("merges injected provider-provisioned ICE servers after static ICE/TURN", async () => {
    const tx = new FakeTransport()
    await applySettings(
      tx as unknown as Tx,
      settings({
        webrtcEnabled: true,
        iceServers: [{ urls: "stun:s" }],
        turnServers: [],
      }),
      [{ urls: "turn:prov", username: "u", credential: "c" }]
    )
    expect(tx.enableCalls[0].rtcConfiguration?.iceServers).toEqual([
      { urls: "stun:s" },
      { urls: "turn:prov", username: "u", credential: "c" },
    ])
  })
})

describe("installMobileSignalingController — TURN provisioner", () => {
  // NB: the liveQuery initial fire is unreliable under fake-indexeddb (see the
  // file header), so these exercise the provisioner via a network trigger,
  // which runs `reupgrade()` → `manageProvisioner` like production.
  it("starts a provisioner when turnProvider.kind !== 'none', merges its servers, and stops it on uninstall", async () => {
    const tx = new FakeTransport()
    const stop = jest.fn()
    let netHandler: (s: NetworkStatus) => void = () => {}
    let startCount = 0
    const uninstall = installMobileSignalingController({
      isCapacitorOverride: true,
      transportOverride: tx as unknown as Tx,
      getSettingsOverride: async () =>
        settings({
          webrtcEnabled: true,
          turnProvider: { kind: "cloudflare-calls", cloudflareKeyId: "k", secretRef: "kr:s" },
        }),
      subscribeNetworkOverride: async (handler) => {
        netHandler = handler
        return () => {}
      },
      subscribeResumeOverride: async () => () => {},
      nowOverride: () => 0,
      startTurnProvisionerOverride: () => {
        startCount++
        return { current: () => [{ urls: "turn:prov" }], stop }
      },
    })
    await new Promise((r) => setTimeout(r, 10))
    netHandler({ connected: true, connectionType: "wifi" })
    await new Promise((r) => setTimeout(r, 0))

    expect(startCount).toBe(1)
    expect(tx.enableCalls.at(-1)?.rtcConfiguration?.iceServers).toContainEqual({
      urls: "turn:prov",
    })
    uninstall()
    expect(stop).toHaveBeenCalled()
  })

  it("does not start a provisioner when turnProvider is unset / none", async () => {
    const tx = new FakeTransport()
    let netHandler: (s: NetworkStatus) => void = () => {}
    let startCount = 0
    const uninstall = installMobileSignalingController({
      isCapacitorOverride: true,
      transportOverride: tx as unknown as Tx,
      getSettingsOverride: async () => settings({ webrtcEnabled: true }),
      subscribeNetworkOverride: async (handler) => {
        netHandler = handler
        return () => {}
      },
      subscribeResumeOverride: async () => () => {},
      nowOverride: () => 0,
      startTurnProvisionerOverride: () => {
        startCount++
        return { current: () => [], stop: () => {} }
      },
    })
    await new Promise((r) => setTimeout(r, 10))
    netHandler({ connected: true, connectionType: "wifi" })
    await new Promise((r) => setTimeout(r, 0))
    expect(startCount).toBe(0)
    uninstall()
  })
})

describe("installMobileSignalingController", () => {
  it("returns a no-op uninstaller outside Capacitor", () => {
    const tx = new FakeTransport()
    const uninstall = installMobileSignalingController({
      isCapacitorOverride: false,
      transportOverride: tx as unknown as Tx,
    })
    expect(typeof uninstall).toBe("function")
    expect(tx.enableCalls).toEqual([])
    uninstall()
  })

  it("re-upgrades the WebRTC tier on network reconnect and app resume, throttled", async () => {
    const tx = new FakeTransport()
    let netHandler: (s: NetworkStatus) => void = () => {}
    let resumeHandler: () => void = () => {}
    let nowMs = 0
    const uninstall = installMobileSignalingController({
      isCapacitorOverride: true,
      transportOverride: tx as unknown as Tx,
      getSettingsOverride: async () => settings({ webrtcEnabled: true }),
      subscribeNetworkOverride: async (handler) => {
        netHandler = handler
        return () => {}
      },
      subscribeResumeOverride: async (handler) => {
        resumeHandler = handler
        return () => {}
      },
      nowOverride: () => nowMs,
    })

    // Let the async subscribe setup (and the settings liveQuery) settle.
    await new Promise((r) => setTimeout(r, 10))
    const baseline = tx.enableCalls.length

    // Network connectivity returns → one re-upgrade.
    netHandler({ connected: true, connectionType: "wifi" })
    await new Promise((r) => setTimeout(r, 0))
    expect(tx.enableCalls.length).toBe(baseline + 1)

    // App resume within the throttle window → suppressed.
    resumeHandler()
    await new Promise((r) => setTimeout(r, 0))
    expect(tx.enableCalls.length).toBe(baseline + 1)

    // Past the throttle window → resume re-upgrades again.
    nowMs += REUPGRADE_MIN_SPACING_MS + 1
    resumeHandler()
    await new Promise((r) => setTimeout(r, 0))
    expect(tx.enableCalls.length).toBe(baseline + 2)

    uninstall()
  })

  it("does not re-upgrade on a disconnected network event", async () => {
    const tx = new FakeTransport()
    let netHandler: (s: NetworkStatus) => void = () => {}
    const uninstall = installMobileSignalingController({
      isCapacitorOverride: true,
      transportOverride: tx as unknown as Tx,
      getSettingsOverride: async () => settings({ webrtcEnabled: true }),
      subscribeNetworkOverride: async (handler) => {
        netHandler = handler
        return () => {}
      },
      subscribeResumeOverride: async () => () => {},
      nowOverride: () => 0,
    })
    await new Promise((r) => setTimeout(r, 10))
    const baseline = tx.enableCalls.length

    netHandler({ connected: false, connectionType: "none" })
    await new Promise((r) => setTimeout(r, 0))
    expect(tx.enableCalls.length).toBe(baseline)

    uninstall()
  })
})

describe("installMobileSignalingController — LAN re-resolution", () => {
  const LAN_CONFIG: CompanionConfig = {
    baseUrl: "https://abc-1234.trycloudflare.com",
    deviceJwt: "jwt",
    deviceId: "dev-1",
    serverVersion: "0.1.0",
    serverFingerprint: "AA:BB",
  }

  beforeEach(async () => {
    __resetCompanionConfigCacheForTests()
    localStorage.clear()
    await saveCompanionConfig(LAN_CONFIG)
  })

  afterEach(() => {
    __resetCompanionConfigCacheForTests()
    localStorage.clear()
  })

  it("repoints baseUrl to the discovered LAN address and reconnects the WS on network reconnect", async () => {
    const tx = new FakeTransport()
    let netHandler: (s: NetworkStatus) => void = () => {}
    const resolveCalls: Array<{ baseUrl: string }> = []
    const uninstall = installMobileSignalingController({
      isCapacitorOverride: true,
      transportOverride: tx as unknown as Tx,
      getSettingsOverride: async () => settings({ webrtcEnabled: true }),
      subscribeNetworkOverride: async (handler) => {
        netHandler = handler
        return () => {}
      },
      subscribeResumeOverride: async () => () => {},
      nowOverride: () => 0,
      resolveLanBaseUrlOverride: async ({ config }) => {
        resolveCalls.push({ baseUrl: config.baseUrl })
        return { lanBaseUrl: "https://192.168.1.5:7890" }
      },
    })
    await new Promise((r) => setTimeout(r, 10))

    // Advance past both throttle windows so the network trigger re-resolves.
    netHandler({ connected: true, connectionType: "wifi" })
    await new Promise((r) => setTimeout(r, 0))

    expect(resolveCalls.length).toBeGreaterThanOrEqual(1)
    expect(tx.reconnectWsCount).toBe(1)
    uninstall()
  })

  it("skips re-resolution when already on a connected LAN", async () => {
    const tx = new FakeTransport()
    tx.onLan = true
    let netHandler: (s: NetworkStatus) => void = () => {}
    let resolveCount = 0
    const uninstall = installMobileSignalingController({
      isCapacitorOverride: true,
      transportOverride: tx as unknown as Tx,
      getSettingsOverride: async () => settings({ webrtcEnabled: true }),
      subscribeNetworkOverride: async (handler) => {
        netHandler = handler
        return () => {}
      },
      subscribeResumeOverride: async () => () => {},
      nowOverride: () => 0,
      resolveLanBaseUrlOverride: async () => {
        resolveCount++
        return { lanBaseUrl: null }
      },
    })
    await new Promise((r) => setTimeout(r, 10))

    netHandler({ connected: true, connectionType: "wifi" })
    await new Promise((r) => setTimeout(r, 0))

    expect(resolveCount).toBe(0)
    expect(tx.reconnectWsCount).toBe(0)
    uninstall()
  })

  it("aborts the in-flight scan on uninstall", async () => {
    const tx = new FakeTransport()
    let netHandler: (s: NetworkStatus) => void = () => {}
    let capturedSignal: AbortSignal | null = null
    let nowMs = 0
    const uninstall = installMobileSignalingController({
      isCapacitorOverride: true,
      transportOverride: tx as unknown as Tx,
      getSettingsOverride: async () => settings({ webrtcEnabled: true }),
      subscribeNetworkOverride: async (handler) => {
        netHandler = handler
        return () => {}
      },
      subscribeResumeOverride: async () => () => {},
      nowOverride: () => nowMs,
      resolveLanBaseUrlOverride: ({ signal }) =>
        new Promise((resolve) => {
          capturedSignal = signal
          // Never settle until aborted.
          signal.addEventListener("abort", () => resolve({ lanBaseUrl: null }), { once: true })
        }),
    })
    await new Promise((r) => setTimeout(r, 10))

    nowMs += LAN_RERESOLVE_MIN_SPACING_MS + 1
    netHandler({ connected: true, connectionType: "wifi" })
    await new Promise((r) => setTimeout(r, 0))
    expect(capturedSignal).not.toBeNull()
    expect(capturedSignal!.aborted).toBe(false)

    uninstall()
    expect(capturedSignal!.aborted).toBe(true)
  })
})
