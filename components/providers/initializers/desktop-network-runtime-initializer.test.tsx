import { render } from "@testing-library/react"

import { DesktopNetworkRuntimeInitializer } from "./desktop-network-runtime-initializer"

const installDesktopNetworkRuntime = jest.fn()
jest.mock("@/lib/network/desktop-network-runtime", () => ({
  installDesktopNetworkRuntime: () => installDesktopNetworkRuntime(),
}))

beforeEach(() => {
  installDesktopNetworkRuntime.mockReset()
})

describe("DesktopNetworkRuntimeInitializer", () => {
  it("installs the host transport once on mount and renders nothing", () => {
    const { container, rerender } = render(<DesktopNetworkRuntimeInitializer />)

    expect(container).toBeEmptyDOMElement()
    expect(installDesktopNetworkRuntime).toHaveBeenCalledTimes(1)

    rerender(<DesktopNetworkRuntimeInitializer />)
    expect(installDesktopNetworkRuntime).toHaveBeenCalledTimes(1)
  })

  it("installs once per mounted instance, not once per render pass", () => {
    render(<DesktopNetworkRuntimeInitializer />)
    render(<DesktopNetworkRuntimeInitializer />)

    // Two separate mounts each call it; the module-level guard inside the
    // installer is what makes the second call a no-op, so the component must
    // not silently swallow it here.
    expect(installDesktopNetworkRuntime).toHaveBeenCalledTimes(2)
  })
})
