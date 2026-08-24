import { render, screen } from "@testing-library/react"

import { DeviceConsoleLink } from "./device-console-link"

describe("DeviceConsoleLink", () => {
  it("pluralizes the paired count", () => {
    const { rerender } = render(<DeviceConsoleLink surface="paired" count={0} />)
    expect(screen.getByText(/No devices are paired/)).toBeInTheDocument()

    rerender(<DeviceConsoleLink surface="paired" count={1} />)
    expect(screen.getByText(/One device is paired/)).toBeInTheDocument()

    rerender(<DeviceConsoleLink surface="paired" count={4} />)
    expect(screen.getByText(/4 devices are paired/)).toBeInTheDocument()
  })

  it("uses the host wording for the hosts surface", () => {
    render(<DeviceConsoleLink surface="hosts" count={2} />)
    expect(screen.getByText("Remote hosts")).toBeInTheDocument()
    expect(screen.getByText(/2 hosts are configured/)).toBeInTheDocument()
  })

  it("links to the console, and to a specific device when given one", () => {
    const { rerender } = render(<DeviceConsoleLink surface="paired" count={1} />)
    expect(screen.getByRole("link")).toHaveAttribute("href", "/devices")

    rerender(<DeviceConsoleLink surface="paired" count={1} deviceRef="device:d1" />)
    expect(screen.getByRole("link")).toHaveAttribute("href", "/devices?device=device%3Ad1")
  })

  it("is addressable per surface so each settings tab can be asserted on", () => {
    render(<DeviceConsoleLink surface="hosts" count={0} />)
    expect(screen.getByTestId("device-console-link-hosts")).toBeInTheDocument()
  })
})
