import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { TunnelBlock } from "./tunnel-block"

import type { HostAdminReach } from "@/lib/connectivity/host-admin-reach"

const reach = jest.fn<HostAdminReach, []>(() => ({ available: true }))
jest.mock("@/hooks/connectivity/use-host-admin-reach", () => ({
  useHostAdminReachForCommand: () => reach(),
}))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/connectivity/tunnel-resolver", () => ({
  ...jest.requireActual("@/lib/connectivity/tunnel-resolver"),
  saveNamedTunnelConfig: jest.fn(),
}))
const call = jest.fn(async (name: string, _args?: Record<string, unknown>) => {
  if (name === "companion_tunnel_current") return null
  if (name === "companion_tunnel_get_config") return { mode: "quick", hasToken: false }
  if (name === "companion_tunnel_probe")
    return {
      installed: true,
      path: "/opt/homebrew/bin/cloudflared",
      version: "cloudflared version 2026.8.1",
    }
  if (name === "companion_tunnel_start")
    return { publicUrl: "https://x.trycloudflare.com", localUrl: "https://127.0.0.1:27890" }
  return undefined
})
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...a: unknown[]) => call(...(a as [string, Record<string, unknown>?])) },
}))
jest.mock("@/lib/db/paired-devices", () => ({ listPairedDevices: async () => [] }))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn(async () => {}) }))
jest.mock("@/components/connectivity/tunnel-install-guide", () => ({
  TunnelInstallGuide: ({ testid, onRecheck }: { testid: string; onRecheck: () => void }) => (
    <button type="button" data-testid={testid} onClick={onRecheck} />
  ),
}))

describe("TunnelBlock", () => {
  const defaultCall = call.getMockImplementation()
  beforeEach(() => {
    reach.mockReturnValue({ available: true })
    call.mockClear()
    if (defaultCall) call.mockImplementation(defaultCall)
  })

  it("starts a quick tunnel against the local HTTPS listener and shows its URL", async () => {
    render(<TunnelBlock />)
    await waitFor(() => expect(call).toHaveBeenCalledWith("companion_tunnel_get_config"))
    await act(async () => {
      fireEvent.click(screen.getByRole("switch"))
    })
    expect(call).toHaveBeenCalledWith("companion_tunnel_start", {
      localUrl: "https://127.0.0.1:27890",
      replace: false,
    })
    expect(screen.getByTestId("tunnel-url")).toHaveTextContent("https://x.trycloudflare.com")
    // The intl stub echoes keys: the badge is the "installed" line.
    expect(screen.getByTestId("tunnel-probe")).toHaveTextContent("installed")
    expect(screen.queryByTestId("tunnel-install-guide")).toBeNull()
  })

  it("shows the install guide before the switch is touched when cloudflared is missing", async () => {
    call.mockImplementation(async (name: string) => {
      if (name === "companion_tunnel_probe") return { installed: false }
      if (name === "companion_tunnel_get_config") return { mode: "quick", hasToken: false }
      return null
    })
    render(<TunnelBlock />)
    await waitFor(() => expect(screen.getByTestId("tunnel-install-guide")).toBeInTheDocument())
    expect(screen.queryByTestId("tunnel-probe")).toBeNull()
    // Re-check after installing: the guide goes away.
    call.mockImplementation(async (name: string) => {
      if (name === "companion_tunnel_probe") return { installed: true, path: "/x" }
      return null
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId("tunnel-install-guide"))
    })
    await waitFor(() => expect(screen.queryByTestId("tunnel-install-guide")).toBeNull())
  })

  it("surfaces an origin conflict and replaces only on request", async () => {
    const started = {
      publicUrl: "https://y.trycloudflare.com",
      localUrl: "https://127.0.0.1:27890",
    }
    call.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === "companion_tunnel_current") return null
      if (name === "companion_tunnel_get_config") return { mode: "quick", hasToken: false }
      if (name === "companion_tunnel_probe") return { installed: true, path: "/x" }
      if (name === "companion_tunnel_start") {
        if (args?.replace === true) return started
        throw new Error(
          "tunnel_busy: already exposing http://127.0.0.1:7891 at https://a.trycloudflare.com"
        )
      }
      return undefined
    })
    render(<TunnelBlock />)
    await waitFor(() => expect(call).toHaveBeenCalledWith("companion_tunnel_get_config"))
    await act(async () => {
      fireEvent.click(screen.getByRole("switch"))
    })
    // The intl stub echoes keys, so the body reads as its key.
    expect(screen.getByTestId("tunnel-conflict")).toHaveTextContent("busyBody")
    expect(screen.getByRole("switch")).not.toBeChecked()
    await act(async () => {
      fireEvent.click(screen.getByTestId("tunnel-conflict-replace"))
    })
    expect(call).toHaveBeenCalledWith("companion_tunnel_start", {
      localUrl: "https://127.0.0.1:27890",
      replace: true,
    })
    expect(screen.queryByTestId("tunnel-conflict")).toBeNull()
    expect(screen.getByTestId("tunnel-url")).toHaveTextContent("https://y.trycloudflare.com")
  })

  it("says what a tunnel started elsewhere is exposing instead of claiming it", async () => {
    call.mockImplementation(async (name: string) => {
      if (name === "companion_tunnel_current")
        return { publicUrl: "https://a.trycloudflare.com", localUrl: "http://127.0.0.1:7891" }
      if (name === "companion_tunnel_get_config") return { mode: "quick", hasToken: false }
      if (name === "companion_tunnel_probe") return { installed: true, path: "/x" }
      return undefined
    })
    render(<TunnelBlock />)
    await waitFor(() => expect(screen.getByTestId("tunnel-exposing")).toBeInTheDocument())
    expect(screen.getByTestId("tunnel-exposing")).toHaveTextContent("exposingOther")
    expect(screen.getByTestId("tunnel-block")).toHaveAttribute(
      "data-exposing",
      "http://127.0.0.1:7891"
    )
  })

  it("is inert with a reason on a headless target", () => {
    reach.mockReturnValue({ available: false, block: "needs-desktop-shell" })
    render(<TunnelBlock />)
    expect(screen.getByRole("switch")).toBeDisabled()
    expect(screen.getByTestId("tunnel-reach")).toHaveAttribute("data-reach", "needs-desktop-shell")
    expect(call).not.toHaveBeenCalled()
  })
})
