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
jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn() },
  localTransport: { call: jest.fn() },
  isTauri: () => profile === "desktop",
}))
import { localTransport, transport } from "@/lib/tauri"
// The probe is injected in every case below. Mocking the module keeps the
// platform-fetch import chain (keyring, proxy) out of a hook test.
jest.mock("@/lib/signaling/relay-probe", () => ({ probeRelay: jest.fn() }))

describe("useRemoteAccess", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    profile = "desktop"
    settings = null
    reach.mockReturnValue({ available: true })
  })

  it("reads this desktop's connectivity independently of its selected remote host", async () => {
    ;(localTransport.call as jest.Mock).mockImplementation(async (name) => {
      if (name === "companion_signaling_status")
        return { enabled: true, signalingUrl: "wss://local/signaling" }
      if (name === "companion_tunnel_current")
        return { publicUrl: "https://local-tunnel", localUrl: "http://localhost" }
      return { networks: [] }
    })
    const { result } = renderHook(() => useRemoteAccess({ pollMs: 0, meshPollMs: 0 }))
    await waitFor(() => expect(result.current.relay.signalingUrl).toBe("wss://local/signaling"))
    expect(result.current.tunnel.publicUrl).toBe("https://local-tunnel")
    expect(transport.call).not.toHaveBeenCalled()
  })

  it.each(["mobile-companion", "cloud-companion"])(
    "keeps %s signaling on its paired host",
    async (nextProfile) => {
      profile = nextProfile
      reach.mockImplementation((name) =>
        name === "companion_signaling_status"
          ? { available: true }
          : { available: false, block: "needs-desktop-shell" }
      )
      ;(transport.call as jest.Mock).mockResolvedValue({
        enabled: true,
        signalingUrl: "wss://paired/signaling",
      })
      const { result } = renderHook(() => useRemoteAccess({ pollMs: 0, meshPollMs: 0 }))
      await waitFor(() => expect(result.current.relay.signalingUrl).toBe("wss://paired/signaling"))
      expect(localTransport.call).not.toHaveBeenCalled()
    }
  )

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

  it("drops a verdict that belonged to a rendezvous no longer configured", async () => {
    let url = "wss://first/signaling"
    const probe = jest.fn(async () => ({
      state: "ready" as const,
      healthUrl: "https://first/healthz",
    }))
    const { result } = renderHook(() =>
      useRemoteAccess({
        // A live poll, so the Host can report a different URL mid-session.
        pollMs: 20,
        meshPollMs: 0,
        readSignalingStatus: async () => ({ enabled: true, signalingUrl: url }),
        readTunnel: async () => null,
        readMesh: async () => ({ networks: [] }),
        probe,
      })
    )
    await waitFor(() => expect(result.current.relay.signalingUrl).toBe("wss://first/signaling"))
    await act(async () => {
      await result.current.relay.check()
    })
    expect(result.current.relay.route).toBe("ready")

    // The Host reports a different rendezvous: the old `ready` said nothing
    // about it, so it goes, and the check is offered again.
    url = "wss://second/signaling"
    await waitFor(() => expect(result.current.relay.signalingUrl).toBe("wss://second/signaling"))
    await waitFor(() => expect(result.current.relay.result).toBeNull())
    expect(result.current.relay.route).toBe("unchecked")
    expect(result.current.relay.checkedAt).toBeNull()
  })

  it("a companion's own probe never stands in for the Host's route out", async () => {
    // `probeRelay` goes out over this shell's transport. From a paired phone
    // that measures the phone, so the result is kept but the route is unproven.
    profile = "cloud-companion"
    const probe = jest.fn(async () => ({
      state: "ready" as const,
      healthUrl: "https://r/healthz",
    }))
    const { result } = renderHook(() =>
      useRemoteAccess({
        pollMs: 0,
        readSignalingStatus: async () => ({ enabled: true, signalingUrl: "wss://r/signaling" }),
        readTunnel: async () => null,
        readMesh: async () => ({ networks: [] }),
        probe,
      })
    )
    // Wait for the Host's URL, not just for `source`: until the first read
    // lands the hook is still showing the default rendezvous.
    await waitFor(() => expect(result.current.relay.signalingUrl).toBe("wss://r/signaling"))
    await act(async () => {
      await result.current.relay.check()
    })
    expect(result.current.relay.probedFromHost).toBe(false)
    expect(result.current.relay.result?.state).toBe("ready")
    expect(result.current.relay.route).toBe("unchecked")
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
