import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { MeshBlock } from "./mesh-block"

import type { HostAdminReach } from "@/lib/connectivity/host-admin-reach"
import type { ReachabilityPrefs } from "@/lib/connectivity/reachability-prefs"

const reach = jest.fn<HostAdminReach, []>(() => ({ available: true }))
jest.mock("@/hooks/connectivity/use-host-admin-reach", () => ({
  useHostAdminReachForCommand: () => reach(),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))
const toast = { success: jest.fn(), error: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toast.success(...a),
    error: (...a: unknown[]) => toast.error(...a),
  },
}))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn(async () => {}) }))
jest.mock("@/components/connectivity/tunnel-install-guide", () => ({
  TunnelInstallGuide: ({ tool, testid }: { tool: string; testid: string }) => (
    <div data-testid={testid} data-tool={tool} />
  ),
}))

const connected = {
  networks: [
    {
      provider: "tailscale" as const,
      installed: true,
      addresses: [{ interface: "utun4", address: "100.101.2.3" }],
    },
    { provider: "zerotier" as const, installed: false, addresses: [] },
  ],
}

function prefs(overrides: Partial<ReachabilityPrefs> = {}): ReachabilityPrefs {
  return {
    serverEnabled: true,
    port: 27890,
    bindLoopbackOnly: false,
    mdnsEnabled: false,
    ...overrides,
  }
}

describe("MeshBlock", () => {
  beforeEach(() => {
    reach.mockReturnValue({ available: true })
    toast.success.mockClear()
  })

  it("lists both providers with their state and offers the carried address for invitations", async () => {
    const patch = jest.fn(async (p: Partial<ReachabilityPrefs>) => prefs(p))
    render(
      <MeshBlock
        mesh={{ available: true, status: connected, refresh: async () => {} }}
        loadPrefs={async () => prefs()}
        patchPrefs={patch}
      />
    )
    expect(screen.getByTestId("mesh-provider-tailscale")).toHaveAttribute("data-state", "connected")
    expect(screen.getByTestId("mesh-provider-zerotier")).toHaveAttribute("data-state", "absent")
    await waitFor(() => expect(screen.getByRole("switch")).not.toBeChecked())
    await act(async () => {
      fireEvent.click(screen.getByRole("switch"))
    })
    expect(patch).toHaveBeenCalledWith({ advertiseHost: "100.101.2.3" })
    expect(toast.success).toHaveBeenCalledWith("advertiseSaved:100.101.2.3")
    expect(screen.getByRole("switch")).toBeChecked()
  })

  it("clears the advertised host when switched off", async () => {
    const patch = jest.fn(async (p: Partial<ReachabilityPrefs>) => prefs(p))
    render(
      <MeshBlock
        mesh={{ available: true, status: connected, refresh: async () => {} }}
        loadPrefs={async () => prefs({ advertiseHost: "100.101.2.3" })}
        patchPrefs={patch}
      />
    )
    await waitFor(() => expect(screen.getByRole("switch")).toBeChecked())
    await act(async () => {
      fireEvent.click(screen.getByRole("switch"))
    })
    expect(patch).toHaveBeenCalledWith({ advertiseHost: null })
  })

  it("warns when the saved advertise host is no longer carried, and blocks the switch on loopback", async () => {
    render(
      <MeshBlock
        mesh={{
          available: true,
          status: {
            networks: [
              {
                provider: "tailscale",
                installed: true,
                addresses: [{ interface: "utun4", address: "100.101.2.4" }],
              },
            ],
          },
          refresh: async () => {},
        }}
        loadPrefs={async () => prefs({ advertiseHost: "100.101.2.3", bindLoopbackOnly: true })}
        patchPrefs={async (p) => prefs(p)}
      />
    )
    await waitFor(() => expect(screen.getByTestId("mesh-advertise-stale")).toBeInTheDocument())
    expect(screen.getByTestId("mesh-advertise-stale")).toHaveTextContent(
      "advertiseStale:100.101.2.3"
    )
    expect(screen.getByTestId("mesh-loopback-hint")).toBeInTheDocument()
    expect(screen.getByRole("switch")).toBeDisabled()
  })

  it("shows the install guide for an absent provider on request and opens the vendor page", async () => {
    const open = jest.fn(async () => {})
    render(
      <MeshBlock
        mesh={{
          available: true,
          status: {
            networks: [
              { provider: "tailscale", installed: false, addresses: [] },
              { provider: "zerotier", installed: false, addresses: [] },
            ],
          },
          refresh: async () => {},
        }}
        loadPrefs={async () => prefs()}
        open={open}
      />
    )
    expect(screen.getByTestId("mesh-install-hint")).toBeInTheDocument()
    expect(screen.queryByRole("switch")).toBeNull()
    fireEvent.click(screen.getByTestId("mesh-guide-toggle-zerotier"))
    expect(screen.getByTestId("mesh-install-guide")).toHaveAttribute("data-tool", "zerotier")
    fireEvent.click(screen.getByTestId("mesh-open-tailscale"))
    expect(open).toHaveBeenCalledWith("https://tailscale.com/download")
  })

  it("is inert with a reason off the desktop", () => {
    reach.mockReturnValue({ available: false, block: "needs-desktop-shell" })
    render(<MeshBlock mesh={{ available: false, status: null, refresh: async () => {} }} />)
    expect(screen.getByTestId("mesh-reach")).toHaveAttribute("data-reach", "needs-desktop-shell")
    expect(screen.queryByTestId("mesh-providers")).toBeNull()
    expect(screen.getByTestId("mesh-refresh")).toBeDisabled()
  })

  it("can stop advertising a host no interface carries any more", async () => {
    // The daemon went down, so there is nothing to pick. The switch is the
    // only control that writes `advertiseHost: null` — it has to stay.
    const patch = jest.fn(async () => prefs())
    const empty = {
      networks: [
        { provider: "tailscale" as const, installed: true, addresses: [] },
        { provider: "zerotier" as const, installed: false, addresses: [] },
      ],
    }
    render(
      <MeshBlock
        mesh={{ available: true, status: empty, refresh: async () => {} }}
        loadPrefs={async () => prefs({ advertiseHost: "100.101.2.3" })}
        patchPrefs={patch}
      />
    )
    await waitFor(() => expect(screen.getByTestId("mesh-advertise-stale")).toBeInTheDocument())
    const toggle = screen.getByRole("switch")
    expect(toggle).toBeChecked()
    expect(toggle).not.toBeDisabled()
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(patch).toHaveBeenCalledWith({ advertiseHost: null })
  })

  it("stays checked when the carried address changed under a saved host", async () => {
    const moved = {
      networks: [
        {
          provider: "tailscale" as const,
          installed: true,
          addresses: [{ interface: "utun4", address: "100.101.9.9" }],
        },
        { provider: "zerotier" as const, installed: false, addresses: [] },
      ],
    }
    render(
      <MeshBlock
        mesh={{ available: true, status: moved, refresh: async () => {} }}
        loadPrefs={async () => prefs({ advertiseHost: "100.101.2.3" })}
      />
    )
    await waitFor(() => expect(screen.getByRole("switch")).toBeChecked())
  })
})
