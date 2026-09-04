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

jest.mock("../dialogs/plugin-category-sheet", () => ({
  PluginCategorySheet: () => <div data-testid="plugin-category-sheet-stub" />,
}))

import { PluginLibraryPane } from "./plugin-library-pane"
import { PLUGIN_RAIL_WIDTH_CLASS } from "../plugin-rail-width"

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
    // Container-relative, not viewport-relative: the pane is only a slice of
    // the window, so the rail keys off the pane's own width. The gate is
    // `@xl` (576px) rather than the original `@3xl` (768px) because the
    // center pane never reached 768px at the default split, which made the
    // rail unreachable on an ordinary 1440px desktop.
    expect(rail.className).toContain("@xl/plugin-pane:block")
    expect(rail.className).not.toContain("@3xl/plugin-pane:block")
  })

  // The rail and its Sheet fallback must be gated on the SAME container so
  // exactly one of them is present at every width. Before this, the fallback
  // sat in the page header behind a `lg:` viewport rule and the two could
  // both be hidden at once.
  it("renders the capability sheet fallback under the rail's own container gate", () => {
    render(<PluginLibraryPane />)
    const trigger = screen.getByTestId("plugin-category-sheet-stub")
    const gate = trigger.parentElement as HTMLElement
    expect(gate.className).toContain("@xl/plugin-pane:hidden")
    const rail = screen.getByTestId("plugin-library-capability-rail")
    expect(rail.className).toContain("@xl/plugin-pane:block")
  })

  it("sizes the capability rail from the shared rail constant", () => {
    render(<PluginLibraryPane />)
    const rail = screen.getByTestId("plugin-library-capability-rail")
    // The section nav pane on its left is sized from the same constant. A
    // hand-written width here is how the two rails drifted apart.
    expect(rail.className).toContain(PLUGIN_RAIL_WIDTH_CLASS)
    expect(rail.className).not.toMatch(/\bw-40\b/)
    expect(rail.className).not.toMatch(/\bw-52\b/)
  })

  it("scopes the list body to its own container so cards/rows size to the pane", () => {
    render(<PluginLibraryPane />)
    const pane = screen.getByTestId("plugin-library-pane")
    expect(pane.className).toContain("@container/plugin-pane")
    // The list wrapper opens a nested container measured after the rail.
    expect(pane.querySelector(".\\@container\\/plugin-list")).not.toBeNull()
  })
})
