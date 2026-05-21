/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("./plugin-library-list", () => ({
  PluginLibraryList: () => <div data-testid="plugin-library-list-stub" />,
}))

jest.mock("../plugin-category-sidebar", () => ({
  PluginCategorySidebar: () => <div data-testid="plugin-category-sidebar-stub" />,
}))

import { PluginLibraryPane } from "./plugin-library-pane"

describe("PluginLibraryPane", () => {
  it("renders the capability rail and the list side-by-side", () => {
    render(<PluginLibraryPane />)
    expect(screen.getByTestId("plugin-library-pane")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-library-capability-rail")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-category-sidebar-stub")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-library-list-stub")).toBeInTheDocument()
  })

  it("hides the capability rail below the lg breakpoint via hidden lg:block", () => {
    render(<PluginLibraryPane />)
    const rail = screen.getByTestId("plugin-library-capability-rail")
    expect(rail.className).toContain("hidden")
    expect(rail.className).toContain("lg:block")
  })
})
