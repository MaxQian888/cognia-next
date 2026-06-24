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

  it("hides the capability rail on a narrow pane via a container query", () => {
    render(<PluginLibraryPane />)
    const rail = screen.getByTestId("plugin-library-capability-rail")
    expect(rail.className).toContain("hidden")
    // Container-relative, not viewport-relative — the pane is only a slice
    // of the window, so the rail keys off the pane's own width.
    expect(rail.className).toContain("@3xl/plugin-pane:block")
  })

  it("scopes the list body to its own container so cards/rows size to the pane", () => {
    render(<PluginLibraryPane />)
    const pane = screen.getByTestId("plugin-library-pane")
    expect(pane.className).toContain("@container/plugin-pane")
    // The list wrapper opens a nested container measured after the rail.
    expect(pane.querySelector(".\\@container\\/plugin-list")).not.toBeNull()
  })
})
