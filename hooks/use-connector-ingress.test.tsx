/**
 * @jest-environment jsdom
 */

import { renderHook, waitFor } from "@testing-library/react"

let hostProfile = "desktop"
jest.mock("@/hooks/use-host-profile", () => ({ useHostProfile: () => hostProfile }))

const tunnel = { running: false, url: null as string | null, loading: false }
jest.mock("@/hooks/use-tunnel-status", () => ({ useTunnelStatus: () => tunnel }))

jest.mock("@/lib/connectors/lark-web/entry-client", () => ({ resolveLarkApiBase: () => "" }))

import { useConnectorIngress } from "./use-connector-ingress"

beforeEach(() => {
  hostProfile = "desktop"
  tunnel.running = false
  tunnel.url = null
  tunnel.loading = false
})

describe("useConnectorIngress — desktop", () => {
  it("publishes the cloudflared origin with no path prefix", () => {
    tunnel.running = true
    tunnel.url = "https://demo.trycloudflare.com/"
    const { result } = renderHook(() => useConnectorIngress())
    expect(result.current).toMatchObject({
      base: "https://demo.trycloudflare.com",
      reason: "ready",
      desktopShape: true,
      loading: false,
    })
  })

  it("reports tunnel-off, which is the one state with a remedy the user can take", () => {
    const { result } = renderHook(() => useConnectorIngress())
    expect(result.current.base).toBeNull()
    expect(result.current.reason).toBe("tunnel-off")
  })

  it("holds while the probe is still out rather than claiming either outcome", () => {
    tunnel.loading = true
    const { result } = renderHook(() => useConnectorIngress())
    expect(result.current.reason).toBe("loading")
    expect(result.current.loading).toBe(true)
  })
})

describe("useConnectorIngress — cloud and headless", () => {
  it.each(["cloud-companion", "headless"])("nests under /connectors on %s", (profile) => {
    hostProfile = profile
    const { result } = renderHook(() => useConnectorIngress())
    expect(result.current).toMatchObject({
      base: `${window.location.origin}/connectors`,
      reason: "ready",
      desktopShape: false,
      loading: false,
    })
  })

  it("ignores a running tunnel on a cloud host", () => {
    // The failure this hook exists to stop: passing connector reach (true on
    // headless) as `isDesktop` handed a cloud install a tunnel URL for a host
    // that has no tunnel, and the address that works appeared nowhere.
    hostProfile = "cloud-companion"
    tunnel.running = true
    tunnel.url = "https://demo.trycloudflare.com"
    const { result } = renderHook(() => useConnectorIngress())
    expect(result.current.base).toBe(`${window.location.origin}/connectors`)
    expect(result.current.base).not.toContain("trycloudflare")
  })

  it("reports origin-missing rather than tunnel-off when there is no origin", () => {
    hostProfile = "cloud-companion"
    const { result } = renderHook(() => useConnectorIngress({ publicOrigin: () => null }))
    expect(result.current.base).toBeNull()
    // Distinct from tunnel-off: a cloud host has no tunnel to start, so
    // collapsing the two prints the desktop's advice to the wrong host.
    expect(result.current.reason).toBe("origin-missing")
  })
})

describe("useConnectorIngress — mobile companion", () => {
  it("uses the paired host's tunnel origin, unprefixed", async () => {
    hostProfile = "mobile-companion"
    const { result } = renderHook(() =>
      useConnectorIngress({
        loadCompanionEndpoints: async () =>
          ({ tunnelBaseUrl: "https://host.trycloudflare.com" }) as never,
      })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current).toMatchObject({
      base: "https://host.trycloudflare.com",
      reason: "ready",
      desktopShape: true,
    })
  })

  it("does not fall back to the LAN base when the host has no tunnel", async () => {
    // A phone paired over LAN knows a `baseUrl`, but it is a private address.
    // Pasting it into a platform console advertises something the platform can
    // never reach, so the absence of a tunnel is reported rather than papered
    // over with the one origin the phone happens to hold.
    hostProfile = "mobile-companion"
    const { result } = renderHook(() =>
      useConnectorIngress({
        loadCompanionEndpoints: async () =>
          ({ tunnelBaseUrl: null, baseUrl: "https://192.168.1.20:7431" }) as never,
      })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.base).toBeNull()
    expect(result.current.reason).toBe("tunnel-off")
  })

  it("survives an endpoint read that throws", async () => {
    hostProfile = "mobile-companion"
    const { result } = renderHook(() =>
      useConnectorIngress({
        loadCompanionEndpoints: async () => {
          throw new Error("offline")
        },
      })
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.base).toBeNull()
  })
})

describe("useConnectorIngress — web standalone", () => {
  it("says nothing can receive, rather than offering a remedy that does not exist", () => {
    hostProfile = "web-standalone"
    const { result } = renderHook(() => useConnectorIngress())
    expect(result.current).toEqual({
      base: null,
      loading: false,
      reason: "unsupported",
      desktopShape: false,
    })
  })
})
