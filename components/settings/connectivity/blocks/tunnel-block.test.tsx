import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { TunnelBlock } from "./tunnel-block"

import type { HostAdminReach } from "@/lib/connectivity/host-admin-reach"

const reach = jest.fn<HostAdminReach, []>(() => ({ available: true }))
jest.mock("@/hooks/connectivity/use-host-admin-reach", () => ({
  useHostAdminReachForCommand: () => reach(),
}))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/connectivity/tunnel-resolver", () => ({ saveNamedTunnelConfig: jest.fn() }))
const call = jest.fn(async (name: string) => {
  if (name === "companion_tunnel_current") return null
  if (name === "companion_tunnel_get_config") return { mode: "quick", hasToken: false }
  if (name === "companion_tunnel_start")
    return { publicUrl: "https://x.trycloudflare.com", localUrl: "l" }
  return undefined
})
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...a: unknown[]) => call(...(a as [string])) },
}))
jest.mock("@/lib/db/paired-devices", () => ({ listPairedDevices: async () => [] }))

describe("TunnelBlock", () => {
  beforeEach(() => {
    reach.mockReturnValue({ available: true })
    call.mockClear()
  })

  it("starts a quick tunnel against the local HTTPS listener and shows its URL", async () => {
    render(<TunnelBlock />)
    await waitFor(() => expect(call).toHaveBeenCalledWith("companion_tunnel_get_config"))
    await act(async () => {
      fireEvent.click(screen.getByRole("switch"))
    })
    expect(call).toHaveBeenCalledWith("companion_tunnel_start", {
      localUrl: "https://127.0.0.1:27890",
    })
    expect(screen.getByTestId("tunnel-url")).toHaveTextContent("https://x.trycloudflare.com")
  })

  it("is inert with a reason on a headless target", () => {
    reach.mockReturnValue({ available: false, block: "needs-desktop-shell" })
    render(<TunnelBlock />)
    expect(screen.getByRole("switch")).toBeDisabled()
    expect(screen.getByTestId("tunnel-reach")).toHaveAttribute("data-reach", "needs-desktop-shell")
    expect(call).not.toHaveBeenCalled()
  })
})
