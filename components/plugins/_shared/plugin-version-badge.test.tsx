import { render, screen } from "@testing-library/react"

import { PluginVersionBadge } from "./plugin-version-badge"

describe("PluginVersionBadge", () => {
  it("renders v{version}", () => {
    render(<PluginVersionBadge version="1.2.3" />)
    expect(screen.getByText("v1.2.3")).toBeInTheDocument()
  })

  it("exposes a stable data-testid", () => {
    render(<PluginVersionBadge version="0.0.1" />)
    expect(screen.getByTestId("plugin-version-badge")).toBeInTheDocument()
  })

  it("forwards a custom className onto the rendered Badge", () => {
    render(<PluginVersionBadge version="1.0.0" className="custom-cls" />)
    expect(screen.getByTestId("plugin-version-badge").className).toContain("custom-cls")
  })
})
