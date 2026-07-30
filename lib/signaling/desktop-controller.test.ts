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
} from "./desktop-controller"
import { transport } from "@/lib/tauri/transport-instance"
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
        signalingUrl: "wss://sig.example/v2/signaling",
        iceServers: [{ urls: "stun:s" }],
      }),
      [{ urls: "turn:static", username: "u", credential: "c" }],
      [{ urls: "turn:prov" }]
    )
    expect(patch.enabled).toBe(true)
    expect(patch.signalingUrl).toBe("wss://sig.example/v2/signaling")
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

  it("does not start a provisioner when no provider is configured", async () => {
    let startCount = 0
    const uninstall = installDesktopSignalingController({
      isTauriOverride: true,
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
