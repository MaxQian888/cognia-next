/** @jest-environment jsdom */
/**
 * Mobile-controller — covers the `applySettings` reducer that the
 * production `installCompanionSignalingController` plumbs through
 * `dexie.liveQuery`. Exercising the reducer directly avoids the
 * `liveQuery` timing race that fake-indexeddb exhibits under Jest.
 */

import {
  applySettings,
  installCompanionSignalingController,
  probeCandidateDefault,
  LAN_RERESOLVE_MIN_SPACING_MS,
  REUPGRADE_MIN_SPACING_MS,
} from "./mobile-controller"
import {
  __resetCompanionConfigCacheForTests,
  saveCompanionConfig,
} from "@/lib/tauri/transport-companion"
import {
  __setCompanionStorageForTests,
  type CompanionConfig,
  type CompanionConfigStorage,
} from "@/lib/tauri/companion-storage"
import type { NetworkStatus } from "@/lib/capacitor/network"
import type { AppSettings } from "@cognia/agent-config-types"

// The controller's production entry point is a Dexie `liveQuery` subscription,
// and under Jest the real one never emits (the fake-indexeddb timing race noted
// above) — which left the observer callbacks, the path that actually drives
// settings into the transport on a real device, completely unexercised. This
// stand-in keeps every other Dexie export intact and emits exactly once per
// install, routing a rejected read to the observer's `error` arm.
jest.mock("dexie", () => {
  const actual = jest.requireActual<Record<string, unknown>>("dexie")
  const liveQuery = (query: () => Promise<unknown>) => ({
    subscribe: (observer: { next: (v: unknown) => void; error: (e: unknown) => void }) => {
      void Promise.resolve()
        .then(query)
        .then(
          (value) => observer.next(value),
          (err) => observer.error(err)
        )
      return { unsubscribe: () => {} }
    },
  })
  // Preserve the default export explicitly — every `lib/db/*` module does
  // `class X extends Dexie`, and losing it takes the whole graph down.
  const DexieDefault = (actual.default ?? actual) as Record<string, unknown>
  // The controller calls `Dexie.liveQuery(...)` (the static) rather than the
  // named export — see the interop note in `lib/db/outbound-jobs.ts`. Because
  // this factory sets `__esModule: true`, the default export is handed back
  // untouched, so stubbing only the named `liveQuery` below would leave the
  // controller on the REAL implementation and this mock silently inert.
  // Jest gives each test file its own module registry, so patching the static
  // here cannot leak into another suite.
  DexieDefault.liveQuery = liveQuery
  return {
    ...actual,
    __esModule: true,
    default: DexieDefault,
    liveQuery,
  }
})

class FakeTransport {
  readonly enableCalls: Array<{
    signalingUrl: string
    rtcConfiguration?: RTCConfiguration
  }> = []
  disableCount = 0
  reconnectWsCount = 0
  onLan = false
  /** When set, `enableWebRtcTier` rejects — drives the error paths. */
  enableError: Error | null = null
  /** When set, `isOnConnectedLan` throws — drives the boot-path error guard. */
  lanCheckError: Error | null = null
  /** Drives the failover sweep's "don't tear down a live connection" guard. */
  connectionState: "connected" | "reconnecting" | "offline" | "unauthenticated" = "offline"
  /** Listeners registered by the controller's endpoint-refresh subscription. */
  readonly connectionStateHandlers = new Set<(state: string) => void>()
  detachConnectionStateCount = 0
  async enableWebRtcTier(opts: {
    signalingUrl: string
    rtcConfiguration?: RTCConfiguration
  }): Promise<void> {
    this.enableCalls.push({
      signalingUrl: opts.signalingUrl,
      rtcConfiguration: opts.rtcConfiguration,
    })
    if (this.enableError) throw this.enableError
  }
  disableWebRtcTier(): void {
    this.disableCount++
  }
  isOnConnectedLan(): boolean {
    if (this.lanCheckError) throw this.lanCheckError
    return this.onLan
  }
  getConnectionState(): string {
    return this.connectionState
  }
  onConnectionStateChange(handler: (state: string) => void): () => void {
    this.connectionStateHandlers.add(handler)
    return () => {
      this.detachConnectionStateCount++
      this.connectionStateHandlers.delete(handler)
    }
  }
  /** Test helper — drive a state transition through the registered listeners. */
  emitConnectionState(state: "connected" | "reconnecting" | "offline" | "unauthenticated"): void {
    this.connectionState = state
    for (const handler of this.connectionStateHandlers) handler(state)
  }
  reconnectWs(): void {
    this.reconnectWsCount++
  }
}

type Tx = import("@/lib/tauri/transport-companion").CompanionTransport

let storedCompanionConfig: CompanionConfig | null = null
const testCompanionStorage: CompanionConfigStorage = {
  load: async () => storedCompanionConfig,
  save: async (config) => {
    storedCompanionConfig = config
  },
  clear: async () => {
    storedCompanionConfig = null
  },
}

beforeEach(() => {
  storedCompanionConfig = null
  __setCompanionStorageForTests(testCompanionStorage)
  __resetCompanionConfigCacheForTests()
})

afterEach(() => {
  __setCompanionStorageForTests(null)
  __resetCompanionConfigCacheForTests()
})

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
        signalingUrl: "wss://my.signaling.example/signaling",
        iceServers: [{ urls: "stun:stun.example:3478" }],
        turnServers: [{ urls: "turn:turn.example:3478", username: "u", credential: "p" }],
      })
    )
    expect(tx.enableCalls.length).toBe(1)
    expect(tx.enableCalls[0].signalingUrl).toBe("wss://my.signaling.example/signaling")
    expect(tx.enableCalls[0].rtcConfiguration?.iceServers).toEqual([
      { urls: "stun:stun.example:3478" },
      { urls: "turn:turn.example:3478", username: "u", credential: "p" },
    ])
  })

  it("falls back to defaults when no signaling URL or ICE servers are set", async () => {
    const tx = new FakeTransport()
    await applySettings(tx as unknown as Tx, settings({ webrtcEnabled: true }))
    expect(tx.enableCalls.length).toBe(1)
    expect(tx.enableCalls[0].signalingUrl).toBe("wss://signaling.cognia.cn/signaling")
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

describe("installCompanionSignalingController — TURN provisioner", () => {
  // NB: the liveQuery initial fire is unreliable under fake-indexeddb (see the
  // file header), so these exercise the provisioner via a network trigger,
  // which runs `reupgrade()` → `manageProvisioner` like production.
  it("starts a provisioner when turnProvider.kind !== 'none', merges its servers, and stops it on uninstall", async () => {
    const tx = new FakeTransport()
    const stop = jest.fn()
    let netHandler: (s: NetworkStatus) => void = () => {}
    let startCount = 0
    const uninstall = installCompanionSignalingController({
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
    const uninstall = installCompanionSignalingController({
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

describe("installCompanionSignalingController", () => {
  it("returns a no-op uninstaller when no companion transport exists", () => {
    // Neither Capacitor nor a browser with a configured server: the live
    // transport is Tauri IPC or the web stub, so there is nothing to drive.
    const tx = new FakeTransport()
    const uninstall = installCompanionSignalingController({
      isCapacitorOverride: false,
      hasWebCompanionTargetOverride: false,
      transportOverride: tx as unknown as Tx,
    })
    expect(typeof uninstall).toBe("function")
    expect(tx.enableCalls).toEqual([])
    uninstall()
  })

  it("runs in a browser pointed at a cloud server", async () => {
    // This is the gap the host-neutral split closed: a browser companion used
    // to get an immediate no-op, so it never refreshed the channel inventory,
    // never re-probed on reconnect and never had a WebRTC tier at all.
    const tx = new FakeTransport()
    const refreshEndpoints = jest.fn(async () => undefined)
    let netHandler: (s: NetworkStatus) => void = () => {}
    const uninstall = installCompanionSignalingController({
      isCapacitorOverride: false,
      hasWebCompanionTargetOverride: true,
      transportOverride: tx as unknown as Tx,
      getSettingsOverride: async () => settings({ webrtcEnabled: true }),
      refreshEndpointsOverride: refreshEndpoints as never,
      subscribeNetworkOverride: async (handler) => {
        netHandler = handler
        return () => {}
      },
      subscribeResumeOverride: async () => () => {},
    })

    await new Promise((r) => setTimeout(r, 10))
    // The WebRTC tier is opted into from settings, exactly as on a phone.
    expect(tx.enableCalls.length).toBeGreaterThan(0)
    // And a network-recovery trigger is wired.
    expect(typeof netHandler).toBe("function")
    uninstall()
  })

  it("skips local-network discovery in a browser but still sweeps channels", async () => {
    // mDNS and a /24 sweep need native networking. Reaching for them in a
    // browser would be a guaranteed failure on every reconnect; the concrete
    // addresses the host reports over `companion_endpoints` are the browser's
    // only route, so the sweep still runs.
    const tx = new FakeTransport()
    tx.connectionState = "offline"
    const resolveLan = jest.fn(async () => ({ lanBaseUrl: null }))
    await saveCompanionConfig({
      baseUrl: "https://cloud.example",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
      deviceKeyThumbprint: "device-thumbprint",
      deviceId: "d1",
      serverVersion: "1",
      tunnelBaseUrl: "https://tunnel.example",
    } as CompanionConfig)

    const uninstall = installCompanionSignalingController({
      isCapacitorOverride: false,
      hasWebCompanionTargetOverride: true,
      transportOverride: tx as unknown as Tx,
      getSettingsOverride: async () => settings({ webrtcEnabled: false }),
      resolveLanBaseUrlOverride: resolveLan as never,
      probeCandidateOverride: async () => true,
      subscribeNetworkOverride: async () => () => {},
      subscribeResumeOverride: async () => () => {},
    })

    await new Promise((r) => setTimeout(r, 20))
    expect(resolveLan).not.toHaveBeenCalled()
    uninstall()
  })

  it("re-upgrades the WebRTC tier on network reconnect and app resume, throttled", async () => {
    const tx = new FakeTransport()
    let netHandler: (s: NetworkStatus) => void = () => {}
    let resumeHandler: () => void = () => {}
    let nowMs = 0
    const uninstall = installCompanionSignalingController({
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
    const uninstall = installCompanionSignalingController({
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

describe("installCompanionSignalingController — LAN re-resolution", () => {
  const LAN_CONFIG: CompanionConfig = {
    baseUrl: "https://abc-1234.trycloudflare.com",
    devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
    deviceKeyThumbprint: "device-thumbprint",
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
    const uninstall = installCompanionSignalingController({
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
    const uninstall = installCompanionSignalingController({
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
    const uninstall = installCompanionSignalingController({
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

describe("installCompanionSignalingController — resilience", () => {
  it("re-pushes ICE servers when the provisioner rotates credentials", async () => {
    const tx = new FakeTransport()
    let onRefresh: ((iceServers: RTCIceServer[]) => void) | null = null
    let servers: RTCIceServer[] = [{ urls: "turn:first" }]
    let netHandler: (s: NetworkStatus) => void = () => {}
    const uninstall = installCompanionSignalingController({
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
      startTurnProvisionerOverride: (opts) => {
        onRefresh = opts.onRefresh
        return { current: () => servers, stop: () => {} }
      },
    })
    await new Promise((r) => setTimeout(r, 10))
    netHandler({ connected: true, connectionType: "wifi" })
    await new Promise((r) => setTimeout(r, 10))
    expect(onRefresh).not.toBeNull()

    servers = [{ urls: "turn:rotated" }]
    onRefresh!([{ urls: "turn:rotated" }])
    await new Promise((r) => setTimeout(r, 10))

    expect(tx.enableCalls.at(-1)?.rtcConfiguration?.iceServers).toContainEqual({
      urls: "turn:rotated",
    })
    uninstall()
  })

  it("logs and survives a failed re-push after credential rotation", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const tx = new FakeTransport()
    let onRefresh: ((iceServers: RTCIceServer[]) => void) | null = null
    let netHandler: (s: NetworkStatus) => void = () => {}
    const uninstall = installCompanionSignalingController({
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
      startTurnProvisionerOverride: (opts) => {
        onRefresh = opts.onRefresh
        return { current: () => [{ urls: "turn:prov" }], stop: () => {} }
      },
    })
    await new Promise((r) => setTimeout(r, 10))
    netHandler({ connected: true, connectionType: "wifi" })
    await new Promise((r) => setTimeout(r, 10))

    tx.enableError = new Error("negotiation exploded")
    onRefresh!([{ urls: "turn:prov" }])
    await new Promise((r) => setTimeout(r, 10))

    expect(warn).toHaveBeenCalledWith(
      "mobile-signaling-controller: provisioner re-push failed",
      expect.any(Error)
    )
    warn.mockRestore()
    uninstall()
  })

  it("does not leak an unhandled rejection when the boot-time repoint throws", async () => {
    // A pairing must exist, otherwise the repoint returns before it ever
    // touches the transport and the guard under test never runs.
    __resetCompanionConfigCacheForTests()
    localStorage.clear()
    await saveCompanionConfig({
      baseUrl: "https://192.168.1.5:27890",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
      deviceKeyThumbprint: "device-thumbprint",
      deviceId: "dev-1",
      serverVersion: "0.2.0",
    })
    const tx = new FakeTransport()
    tx.lanCheckError = new Error("transport torn down")
    const uninstall = installCompanionSignalingController({
      isCapacitorOverride: true,
      transportOverride: tx as unknown as Tx,
      getSettingsOverride: async () => settings({ webrtcEnabled: false }),
      subscribeNetworkOverride: async () => () => {},
      subscribeResumeOverride: async () => () => {},
      nowOverride: () => 0,
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(() => uninstall()).not.toThrow()
    __resetCompanionConfigCacheForTests()
    localStorage.clear()
  })

  it("logs and survives a settings push that the transport rejects", async () => {
    // The liveQuery observer is the production entry point: a transport that
    // fails negotiation there must be logged, not left as an unhandled
    // rejection that kills the subscription.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const tx = new FakeTransport()
    tx.enableError = new Error("negotiation exploded")
    const uninstall = installCompanionSignalingController({
      isCapacitorOverride: true,
      transportOverride: tx as unknown as Tx,
      getSettingsOverride: async () => settings({ webrtcEnabled: true }),
      subscribeNetworkOverride: async () => () => {},
      subscribeResumeOverride: async () => () => {},
      nowOverride: () => 0,
    })
    await new Promise((r) => setTimeout(r, 10))

    expect(warn).toHaveBeenCalledWith(
      "mobile-signaling-controller: applySettings failed",
      expect.any(Error)
    )
    warn.mockRestore()
    uninstall()
  })

  it("logs and survives a settings read that keeps failing", async () => {
    // Both the liveQuery subscription and the re-upgrade path read settings;
    // a Dexie failure must not take the controller down with it.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const tx = new FakeTransport()
    let netHandler: (s: NetworkStatus) => void = () => {}
    const uninstall = installCompanionSignalingController({
      isCapacitorOverride: true,
      transportOverride: tx as unknown as Tx,
      getSettingsOverride: async () => {
        throw new Error("dexie is closed")
      },
      subscribeNetworkOverride: async (handler) => {
        netHandler = handler
        return () => {}
      },
      subscribeResumeOverride: async () => () => {},
      nowOverride: () => 0,
    })
    await new Promise((r) => setTimeout(r, 10))
    netHandler({ connected: true, connectionType: "wifi" })
    await new Promise((r) => setTimeout(r, 10))

    expect(warn).toHaveBeenCalled()
    expect(tx.enableCalls).toHaveLength(0)
    warn.mockRestore()
    uninstall()
  })

  it("still installs when the network and resume subscriptions both reject", async () => {
    // No Capacitor plugin (or no window): the settings liveQuery still drives
    // the happy path, so installation must not throw or leak.
    const tx = new FakeTransport()
    const uninstall = installCompanionSignalingController({
      isCapacitorOverride: true,
      transportOverride: tx as unknown as Tx,
      getSettingsOverride: async () => settings({ webrtcEnabled: true }),
      subscribeNetworkOverride: async () => {
        throw new Error("no plugin")
      },
      subscribeResumeOverride: async () => {
        throw new Error("no plugin")
      },
      nowOverride: () => 0,
    })
    await new Promise((r) => setTimeout(r, 10))
    // Neither rejection escapes as an unhandled rejection, and dispose stays
    // safe with both unsub handles still null.
    expect(() => uninstall()).not.toThrow()
  })

  it("drops a subscription that resolved after uninstall", async () => {
    // The subscribe promises can settle after dispose; the late handles must
    // be released rather than left listening on a dead controller.
    const tx = new FakeTransport()
    const netUnsub = jest.fn()
    const resumeUnsub = jest.fn()
    let releaseNet: (() => void) | null = null
    const uninstall = installCompanionSignalingController({
      isCapacitorOverride: true,
      transportOverride: tx as unknown as Tx,
      getSettingsOverride: async () => settings({ webrtcEnabled: true }),
      subscribeNetworkOverride: () =>
        new Promise((resolve) => {
          releaseNet = () => resolve(netUnsub)
        }),
      subscribeResumeOverride: () =>
        new Promise((resolve) => {
          releaseNet = ((prev) => () => {
            prev?.()
            resolve(resumeUnsub)
          })(releaseNet)
        }),
      nowOverride: () => 0,
    })
    uninstall()
    releaseNet!()
    await new Promise((r) => setTimeout(r, 10))

    expect(netUnsub).toHaveBeenCalled()
    expect(resumeUnsub).toHaveBeenCalled()
  })
})

describe("probeCandidateDefault", () => {
  const health = (fingerprint: string) => ({
    version: "0.2.0",
    fingerprint,
    advertisedPort: 27890,
    serverId: "server-1",
  })

  it("rejects a candidate that does not answer /healthz", async () => {
    const fetchHealthz = jest.fn().mockResolvedValue(null)
    const out = await probeCandidateDefault(
      "https://dead.example",
      new AbortController().signal,
      "abc123",
      fetchHealthz as never
    )
    expect(out).toBe(false)
  })

  it("accepts a candidate whose reported fingerprint matches the pin, case-insensitively", async () => {
    // `/healthz` reports the desktop's OWN self-signed SPKI regardless of which
    // channel the request arrived on, so this identifies the host even over a
    // Cloudflare-terminated tunnel.
    const fetchHealthz = jest.fn().mockResolvedValue(health("ABC123"))
    const out = await probeCandidateDefault(
      "https://calm-rock.trycloudflare.com",
      new AbortController().signal,
      "abc123",
      fetchHealthz as never
    )
    expect(out).toBe(true)
  })

  it("rejects a live candidate whose fingerprint does not match the pin", async () => {
    // A squatted tunnel hostname must not be able to attract the connection.
    const fetchHealthz = jest.fn().mockResolvedValue(health("deadbeef"))
    const out = await probeCandidateDefault(
      "https://impostor.trycloudflare.com",
      new AbortController().signal,
      "abc123",
      fetchHealthz as never
    )
    expect(out).toBe(false)
  })

  it("accepts any live candidate when the device holds no pin", async () => {
    const fetchHealthz = jest.fn().mockResolvedValue(health("whatever"))
    const out = await probeCandidateDefault(
      "https://x.example",
      new AbortController().signal,
      undefined,
      fetchHealthz as never
    )
    expect(out).toBe(true)
  })
})

describe("installCompanionSignalingController — channel failover", () => {
  /**
   * A phone paired on the LAN that has since left the network: `baseUrl` is a
   * dead 192.168.x address, and the tunnel URL is only known because a prior
   * `companion_endpoints` refresh cached it.
   */
  const OFF_LAN_CONFIG: CompanionConfig = {
    baseUrl: "https://192.168.1.5:27890",
    devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
    deviceKeyThumbprint: "device-thumbprint",
    deviceId: "dev-1",
    serverVersion: "0.2.0",
    serverFingerprint: "abc123",
    tunnelBaseUrl: "https://calm-rock.trycloudflare.com",
  }

  beforeEach(async () => {
    __resetCompanionConfigCacheForTests()
    localStorage.clear()
    await saveCompanionConfig(OFF_LAN_CONFIG)
  })

  afterEach(() => {
    __resetCompanionConfigCacheForTests()
    localStorage.clear()
  })

  function install(
    tx: FakeTransport,
    overrides: Partial<Parameters<typeof installCompanionSignalingController>[0]> = {}
  ) {
    let netHandler: (s: NetworkStatus) => void = () => {}
    const uninstall = installCompanionSignalingController({
      isCapacitorOverride: true,
      transportOverride: tx as unknown as Tx,
      getSettingsOverride: async () => settings({ webrtcEnabled: false }),
      subscribeNetworkOverride: async (handler) => {
        netHandler = handler
        return () => {}
      },
      subscribeResumeOverride: async () => () => {},
      nowOverride: () => 0,
      resolveLanBaseUrlOverride: async () => ({ lanBaseUrl: null }),
      refreshEndpointsOverride: async () => null,
      ...overrides,
    })
    return { uninstall, trigger: () => netHandler({ connected: true, connectionType: "wifi" }) }
  }

  it("fails over to the cached tunnel URL when the LAN is gone and the transport is down", async () => {
    const tx = new FakeTransport()
    tx.connectionState = "offline"
    const probed: string[] = []
    const { uninstall, trigger } = install(tx, {
      probeCandidateOverride: async (baseUrl) => {
        probed.push(baseUrl)
        return baseUrl === "https://calm-rock.trycloudflare.com"
      },
    })
    await new Promise((r) => setTimeout(r, 10))
    trigger()
    await new Promise((r) => setTimeout(r, 10))

    // Tunnel is probed ahead of the dead pair-time address, and wins.
    expect(probed).toContain("https://calm-rock.trycloudflare.com")
    expect(tx.reconnectWsCount).toBeGreaterThanOrEqual(1)
    const { loadCompanionConfig } = jest.requireActual<
      typeof import("@/lib/tauri/transport-companion")
    >("@/lib/tauri/transport-companion")
    expect(loadCompanionConfig()!.baseUrl).toBe("https://calm-rock.trycloudflare.com")
    uninstall()
  })

  it("does not sweep while the transport is still connected on another channel", async () => {
    // Tearing down a working tunnel connection to go probing would turn a
    // usable session into an outage.
    const tx = new FakeTransport()
    tx.connectionState = "connected"
    const probe = jest.fn().mockResolvedValue(true)
    const { uninstall, trigger } = install(tx, { probeCandidateOverride: probe })
    await new Promise((r) => setTimeout(r, 10))
    trigger()
    await new Promise((r) => setTimeout(r, 10))

    expect(probe).not.toHaveBeenCalled()
    expect(tx.reconnectWsCount).toBe(0)
    uninstall()
  })

  it("leaves baseUrl alone when no candidate answers", async () => {
    const tx = new FakeTransport()
    tx.connectionState = "offline"
    const { uninstall, trigger } = install(tx, { probeCandidateOverride: async () => false })
    await new Promise((r) => setTimeout(r, 10))
    trigger()
    await new Promise((r) => setTimeout(r, 10))

    expect(tx.reconnectWsCount).toBe(0)
    uninstall()
  })

  it("does not sweep when the device knows no addresses at all", async () => {
    // Fresh pairing with an unparseable/empty baseUrl and no cached channels:
    // there is nothing to probe, so the sweep must exit before touching the
    // network rather than firing a probe against an empty string.
    __resetCompanionConfigCacheForTests()
    localStorage.clear()
    await saveCompanionConfig({
      baseUrl: "",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
      deviceKeyThumbprint: "device-thumbprint",
      deviceId: "dev-1",
      serverVersion: "0.2.0",
    })
    const tx = new FakeTransport()
    tx.connectionState = "offline"
    const probe = jest.fn().mockResolvedValue(true)
    const { uninstall, trigger } = install(tx, { probeCandidateOverride: probe })
    await new Promise((r) => setTimeout(r, 10))
    trigger()
    await new Promise((r) => setTimeout(r, 10))

    expect(probe).not.toHaveBeenCalled()
    expect(tx.reconnectWsCount).toBe(0)
    uninstall()
  })

  it("does not reconnect when the winning candidate is the address already in use", async () => {
    // The pair-time address is itself a candidate. If it is the one that
    // answers, repointing would be a no-op write plus a needless socket churn.
    const tx = new FakeTransport()
    tx.connectionState = "offline"
    const { uninstall, trigger } = install(tx, {
      probeCandidateOverride: async (baseUrl) => baseUrl === "https://192.168.1.5:27890",
    })
    await new Promise((r) => setTimeout(r, 10))
    trigger()
    await new Promise((r) => setTimeout(r, 10))

    expect(tx.reconnectWsCount).toBe(0)
    uninstall()
  })

  it("sweeps even when the LAN scan throws", async () => {
    // A scan failure must not swallow the failover — the sweep probes concrete
    // addresses and does not depend on discovery having worked.
    const tx = new FakeTransport()
    tx.connectionState = "offline"
    const probe = jest.fn().mockResolvedValue(false)
    const { uninstall, trigger } = install(tx, {
      resolveLanBaseUrlOverride: async () => {
        throw new Error("scan blew up")
      },
      probeCandidateOverride: probe,
    })
    await new Promise((r) => setTimeout(r, 10))
    trigger()
    await new Promise((r) => setTimeout(r, 10))

    expect(probe).toHaveBeenCalled()
    uninstall()
  })

  it("refreshes the channel inventory immediately when installed while already connected", async () => {
    // `onConnectionStateChange` does not seed the current value, so a warm
    // remount over a live connection would otherwise never refresh.
    const tx = new FakeTransport()
    tx.connectionState = "connected"
    const refresh = jest.fn().mockResolvedValue(null)
    const { uninstall } = install(tx, { refreshEndpointsOverride: refresh })
    await new Promise((r) => setTimeout(r, 10))
    expect(refresh).toHaveBeenCalledTimes(1)
    uninstall()
  })

  it("refreshes the channel inventory on each transition into connected", async () => {
    const tx = new FakeTransport()
    const refresh = jest.fn().mockResolvedValue(null)
    const { uninstall } = install(tx, { refreshEndpointsOverride: refresh })
    await new Promise((r) => setTimeout(r, 10))

    tx.emitConnectionState("reconnecting")
    expect(refresh).not.toHaveBeenCalled()

    tx.emitConnectionState("connected")
    expect(refresh).toHaveBeenCalledTimes(1)

    uninstall()
    expect(tx.detachConnectionStateCount).toBe(1)
    tx.emitConnectionState("connected")
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("survives a rejecting endpoint refresh", async () => {
    const tx = new FakeTransport()
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const { uninstall } = install(tx, {
      refreshEndpointsOverride: async () => {
        throw new Error("nope")
      },
    })
    await new Promise((r) => setTimeout(r, 10))
    tx.emitConnectionState("connected")
    await new Promise((r) => setTimeout(r, 0))
    expect(warn).toHaveBeenCalledWith(
      "mobile-signaling-controller: endpoint refresh failed",
      expect.any(Error)
    )
    warn.mockRestore()
    uninstall()
  })
})
