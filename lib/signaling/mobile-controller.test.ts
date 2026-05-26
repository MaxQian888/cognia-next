/**
 * Mobile-controller — covers the `applySettings` reducer that the
 * production `installMobileSignalingController` plumbs through
 * `dexie.liveQuery`. Exercising the reducer directly avoids the
 * `liveQuery` timing race that fake-indexeddb exhibits under Jest.
 */

import {
  applySettings,
  installMobileSignalingController,
  REUPGRADE_MIN_SPACING_MS,
} from "./mobile-controller"
import type { NetworkStatus } from "@/lib/capacitor/network"
import type { AppSettings } from "@/lib/claude/types"

class FakeTransport {
  readonly enableCalls: Array<{
    signalingUrl: string
    rtcConfiguration?: RTCConfiguration
  }> = []
  disableCount = 0
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
