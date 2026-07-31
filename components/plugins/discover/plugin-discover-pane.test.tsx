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
})
