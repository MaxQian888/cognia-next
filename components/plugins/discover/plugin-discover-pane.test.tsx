/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("../marketplace/plugin-marketplace", () => ({
  PluginMarketplace: () => <div data-testid="plugin-marketplace-stub" />,
}))

import { PluginDiscoverPane } from "./plugin-discover-pane"

describe("PluginDiscoverPane", () => {
  it("mounts the existing PluginMarketplace inside a scrollable wrapper", () => {
    render(<PluginDiscoverPane />)
    expect(screen.getByTestId("plugin-discover-pane")).toHaveClass(
      "min-w-0",
      "max-w-full",
      "overflow-x-clip"
    )
    expect(screen.getByTestId("plugin-marketplace-stub")).toBeInTheDocument()
  })

  it("pads by the pane's own width, not the viewport's", () => {
    render(<PluginDiscoverPane />)
    const pane = screen.getByTestId("plugin-discover-pane")
    expect(pane).toHaveClass("@container")
    expect(pane.className).not.toMatch(/(^|\s)sm:/)
    const inner = screen.getByTestId("plugin-marketplace-stub").parentElement!
    expect(inner).toHaveClass("p-3", "@lg:p-4")
  })
})
