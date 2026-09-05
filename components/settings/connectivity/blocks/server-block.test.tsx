import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { ServerBlock } from "./server-block"

import type { HostAdminReach } from "@/lib/connectivity/host-admin-reach"

const reach = jest.fn<HostAdminReach, []>(() => ({ available: true }))
jest.mock("@/hooks/connectivity/use-host-admin-reach", () => ({
  useHostAdminReachForCommand: () => reach(),
}))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
const prefs = { serverEnabled: false, bindLoopbackOnly: true }
const patch = jest.fn(async (_p: unknown) => {})
jest.mock("@/lib/connectivity/reachability-prefs", () => ({
  loadReachabilityPrefs: async () => prefs,
  patchReachabilityPrefs: (p: unknown) => patch(p),
}))
const call = jest.fn(async (name: string) => {
  if (name === "companion_server_status")
    return { running: false, bindMode: "none", boundPort: null }
  if (name === "companion_tls_paths")
    return { certPemPath: "/c.pem", keyPemPath: "/k.pem", fingerprintSha256: "ab" }
  if (name === "companion_server_start") return 27890
  return undefined
})
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...a: unknown[]) => call(...(a as [string])) },
}))
jest.mock("@/lib/db/paired-devices", () => ({ listPairedDevices: async () => [] }))

describe("ServerBlock", () => {
  beforeEach(() => {
    reach.mockReturnValue({ available: true })
    call.mockClear()
    patch.mockClear()
  })

  it("shows the TLS material and starts the server on the chosen binding", async () => {
    render(<ServerBlock />)
    await waitFor(() => expect(screen.getByTestId("server-tls-paths")).toBeInTheDocument())
    await act(async () => {
      fireEvent.click(screen.getByRole("switch"))
    })
    expect(call).toHaveBeenCalledWith("companion_server_start", {
      port: 27890,
      bindLoopbackOnly: true,
    })
    expect(patch).toHaveBeenCalledWith({ serverEnabled: true, port: 27890, bindLoopbackOnly: true })
  })

  it("renders disabled with the reason when this shell cannot reach the desktop process", () => {
    reach.mockReturnValue({ available: false, block: "needs-desktop-shell" })
    render(<ServerBlock />)
    expect(screen.getByRole("switch")).toBeDisabled()
    expect(screen.getByTestId("server-reach")).toHaveAttribute("data-reach", "needs-desktop-shell")
    expect(call).not.toHaveBeenCalled()
  })
})
