import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { MdnsBlock } from "./mdns-block"

import type { HostAdminReach } from "@/lib/connectivity/host-admin-reach"

const reach = jest.fn<HostAdminReach, []>(() => ({ available: true }))
jest.mock("@/hooks/connectivity/use-host-admin-reach", () => ({
  useHostAdminReachForCommand: () => reach(),
}))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
const prefs = { mdnsEnabled: true }
const patch = jest.fn(async (_p: unknown) => {})
jest.mock("@/lib/connectivity/reachability-prefs", () => ({
  loadReachabilityPrefs: async () => prefs,
  patchReachabilityPrefs: (p: unknown) => patch(p),
}))
const start = jest.fn(async () => ({ kind: "started" }))
jest.mock("@/lib/connectivity/mdns-discovery", () => ({
  startBroadcast: (...a: unknown[]) => start(...(a as [])),
  stopBroadcast: jest.fn(async () => {}),
}))
jest.mock("@/lib/tauri", () => ({
  transport: { call: async (name: string) => (name === "companion_mdns_status" ? false : "fp") },
}))

describe("MdnsBlock", () => {
  beforeEach(() => reach.mockReturnValue({ available: true }))

  it("warns when the saved preference is on but nothing is broadcasting, and starts on toggle", async () => {
    render(<MdnsBlock />)
    await waitFor(() => expect(screen.getByTestId("mdns-autostart-failed")).toBeInTheDocument())
    await act(async () => {
      fireEvent.click(screen.getByRole("switch"))
    })
    expect(start).toHaveBeenCalled()
    expect(patch).toHaveBeenCalledWith({ mdnsEnabled: true })
  })

  it("explains the block instead of hiding the switch", () => {
    reach.mockReturnValue({ available: false, block: "no-host" })
    render(<MdnsBlock />)
    expect(screen.getByRole("switch")).toBeDisabled()
    expect(screen.getByTestId("mdns-reach")).toHaveAttribute("data-reach", "no-host")
  })
})
