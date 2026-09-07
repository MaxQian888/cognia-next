import { render, screen } from "@testing-library/react"

import { RemoteAccessSummary } from "./remote-access-summary"
import { COMPANION_TUNNEL_LOCAL_URL } from "@/lib/connectivity/tunnel-resolver"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

const tailscale = {
  networks: [
    {
      provider: "tailscale" as const,
      installed: true,
      addresses: [{ interface: "utun4", address: "100.101.2.3" }],
    },
    { provider: "zerotier" as const, installed: false, addresses: [] },
  ],
}

describe("RemoteAccessSummary", () => {
  it("says anywhere with a ready relay and shows each route's state", () => {
    render(
      <RemoteAccessSummary
        isHost
        relay="ready"
        tunnel={{ available: true, publicUrl: null, localUrl: null }}
        mesh={{ available: true, status: tailscale }}
      />
    )
    expect(screen.getByTestId("remote-access-verdict")).toHaveAttribute("data-verdict", "anywhere")
    expect(screen.getByTestId("remote-access-relay")).toHaveAttribute("data-tone", "on")
    expect(screen.getByTestId("remote-access-tunnel")).toHaveTextContent("routeState.tunnelOff")
    expect(screen.getByTestId("remote-access-mesh")).toHaveTextContent("100.101.2.3")
    expect(screen.getByTestId("remote-access-mesh")).toHaveTextContent(
      "routeState.meshOn:provider.tailscale"
    )
  })

  it("a legacy rendezvous is the amber verdict, and a live tunnel overrides it", () => {
    const { rerender } = render(
      <RemoteAccessSummary
        isHost
        relay="legacy"
        tunnel={{ available: true, publicUrl: null, localUrl: null }}
        mesh={{ available: true, status: null }}
      />
    )
    expect(screen.getByTestId("remote-access-verdict")).toHaveAttribute(
      "data-verdict",
      "anywhereLegacy"
    )
    rerender(
      <RemoteAccessSummary
        isHost
        relay="legacy"
        tunnel={{
          available: true,
          publicUrl: "https://a.trycloudflare.com",
          localUrl: COMPANION_TUNNEL_LOCAL_URL,
        }}
        mesh={{ available: true, status: null }}
      />
    )
    expect(screen.getByTestId("remote-access-verdict")).toHaveAttribute("data-verdict", "anywhere")
    expect(screen.getByTestId("remote-access-tunnel")).toHaveTextContent("a.trycloudflare.com")
  })

  it("a tunnel exposing another origin is not a route to this Host", () => {
    // One cloudflared child is shared with the connectors' webhook receiver.
    // A public URL in front of *that* proves nothing about reaching this Host.
    render(
      <RemoteAccessSummary
        isHost
        relay="unchecked"
        tunnel={{
          available: true,
          publicUrl: "https://a.trycloudflare.com",
          localUrl: "http://127.0.0.1:17890",
        }}
        mesh={{ available: true, status: null }}
      />
    )
    expect(screen.getByTestId("remote-access-verdict")).toHaveAttribute("data-verdict", "unknown")
    expect(screen.getByTestId("remote-access-tunnel")).toHaveAttribute("data-tone", "warn")
    expect(screen.getByTestId("remote-access-tunnel")).toHaveTextContent(
      "routeState.tunnelOther:http://127.0.0.1:17890"
    )
  })

  it("labels desktop-only routes as such off the desktop and never hides them", () => {
    render(
      <RemoteAccessSummary
        isHost
        relay="unchecked"
        tunnel={{ available: false, publicUrl: null, localUrl: null }}
        mesh={{ available: false, status: null }}
      />
    )
    expect(screen.getByTestId("remote-access-verdict")).toHaveAttribute("data-verdict", "unknown")
    expect(screen.getByTestId("remote-access-tunnel")).toHaveTextContent(
      "routeState.tunnelDesktopOnly"
    )
    expect(screen.getByTestId("remote-access-mesh")).toHaveTextContent("routeState.meshDesktopOnly")
  })

  it("names an installed but disconnected overlay client", () => {
    render(
      <RemoteAccessSummary
        isHost={false}
        relay="off"
        tunnel={{ available: false, publicUrl: null, localUrl: null }}
        mesh={{
          available: true,
          status: {
            networks: [{ provider: "zerotier", installed: true, addresses: [] }],
          },
        }}
      />
    )
    expect(screen.getByTestId("remote-access-verdict")).toHaveAttribute("data-verdict", "notHost")
    expect(screen.getByTestId("remote-access-mesh")).toHaveTextContent(
      "routeState.meshInstalled:provider.zerotier"
    )
  })
})
