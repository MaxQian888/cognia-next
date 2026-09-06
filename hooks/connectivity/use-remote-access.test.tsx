import { act, renderHook, waitFor } from "@testing-library/react"

import { useRemoteAccess } from "./use-remote-access"

import type { HostAdminReach } from "@/lib/connectivity/host-admin-reach"

let profile = "desktop"
const reach = jest.fn<HostAdminReach, [string]>(() => ({ available: true }))
jest.mock("@/hooks/use-host-profile", () => ({ useHostProfile: () => profile }))
jest.mock("@/hooks/connectivity/use-host-admin-reach", () => ({
  useHostAdminReachForCommand: (command: string) => reach(command),
}))
let settings: Record<string, unknown> | null = null
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: { settings: unknown }) => unknown) => selector({ settings }),
}))
jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() }, isTauri: () => false }))
// The probe is injected in every case below. Mocking the module keeps the
// platform-fetch import chain (keyring, proxy) out of a hook test.
jest.mock("@/lib/signaling/relay-probe", () => ({ probeRelay: jest.fn() }))

describe("useRemoteAccess", () => {
  beforeEach(() => {
    profile = "desktop"
    settings = null
    reach.mockReturnValue({ available: true })
  })

  it("reads the Host's relay switch and URL, the tunnel and the mesh, and probes on demand", async () => {
    const probe = jest.fn(async () => ({
      state: "ready" as const,
      healthUrl: "https://r/healthz",
      latencyMs: 5,
    }))
    const { result } = renderHook(() =>
      useRemoteAccess({
        pollMs: 0,
        readSignalingStatus: async () => ({ enabled: true, signalingUrl: "wss://r/signaling" }),
        readTunnel: async () => ({ publicUrl: "https://a.trycloudflare.com", localUrl: "l" }),
        readMesh: async () => ({ networks: [] }),
        probe,
      })
    )
    await waitFor(() => expect(result.current.relay.source).toBe("host"))
    await waitFor(() => expect(result.current.tunnel.publicUrl).toBe("https://a.trycloudflare.com"))
    expect(result.current.isHost).toBe(true)
    expect(result.current.relay.signalingUrl).toBe("wss://r/signaling")
    expect(result.current.relay.route).toBe("unchecked")
    expect(probe).not.toHaveBeenCalled()
    await act(async () => {
      await result.current.relay.check()
    })
    expect(probe).toHaveBeenCalledWith("wss://r/signaling", expect.anything())
    expect(result.current.relay.route).toBe("ready")
    expect(result.current.relay.checkedAt).not.toBeNull()
  })

  it("reads the switch as off from the Host and reports the relay route as off", async () => {
    const { result } = renderHook(() =>
      useRemoteAccess({
        pollMs: 0,
        readSignalingStatus: async () => ({ enabled: false, signalingUrl: "wss://r/signaling" }),
        readTunnel: async () => null,
        readMesh: async () => ({ networks: [] }),
      })
    )
    await waitFor(() => expect(result.current.relay.enabled).toBe(false))
    expect(result.current.relay.route).toBe("off")
  })

  it("a standalone browser reads its own setting and has no tunnel or mesh", async () => {
    profile = "web-standalone"
    settings = { webrtcEnabled: true, signalingUrl: "wss://mine/signaling" }
    reach.mockImplementation(() => ({ available: false, block: "no-host" }))
    const readSignalingStatus = jest.fn()
    const { result } = renderHook(() =>
      useRemoteAccess({
        pollMs: 0,
        readSignalingStatus,
        readTunnel: jest.fn(),
        readMesh: jest.fn(),
      })
    )
    expect(result.current.isHost).toBe(false)
    expect(result.current.relay.source).toBe("local")
    expect(result.current.relay.signalingUrl).toBe("wss://mine/signaling")
    expect(result.current.tunnel.available).toBe(false)
    expect(result.current.mesh.available).toBe(false)
    expect(readSignalingStatus).not.toHaveBeenCalled()
  })

  it("a Host that refuses the status read is reported unavailable, not as a default", async () => {
    const { result } = renderHook(() =>
      useRemoteAccess({
        pollMs: 0,
        readSignalingStatus: async () => {
          throw new Error("403")
        },
        readTunnel: async () => null,
        readMesh: async () => ({ networks: [] }),
      })
    )
    await waitFor(() => expect(result.current.relay.source).toBe("unavailable"))
    expect(result.current.relay.enabled).toBe(false)
  })
})
