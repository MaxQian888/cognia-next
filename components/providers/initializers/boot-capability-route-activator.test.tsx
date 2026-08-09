import { render, waitFor } from "@testing-library/react"

let mockPathname = "/"
jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}))

const mockEnsureBootCapability = jest.fn<Promise<void>, [string]>(() => Promise.resolve())
jest.mock("@/lib/boot/capabilities", () => ({
  ensureBootCapability: (capability: string) => mockEnsureBootCapability(capability),
}))

import { BootCapabilityRouteActivator } from "./boot-capability-route-activator"

describe("BootCapabilityRouteActivator", () => {
  beforeEach(() => {
    mockPathname = "/"
    mockEnsureBootCapability.mockClear()
    window.history.replaceState({}, "", "/")
  })

  it("does not request optional runtimes on the chat route", () => {
    render(<BootCapabilityRouteActivator />)
    expect(mockEnsureBootCapability).not.toHaveBeenCalled()
  })

  it("requests the route runtime after navigation", async () => {
    mockPathname = "/workflows"
    render(<BootCapabilityRouteActivator />)
    await waitFor(() =>
      expect(mockEnsureBootCapability).toHaveBeenCalledWith("workflow-automation")
    )
  })

  it("uses the settings section deep link as a capability trigger", async () => {
    mockPathname = "/settings"
    window.history.replaceState({}, "", "/settings?section=plugins")
    render(<BootCapabilityRouteActivator />)
    await waitFor(() => expect(mockEnsureBootCapability).toHaveBeenCalledWith("plugin-runtime"))
  })
})
