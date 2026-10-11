/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("./plugin-library-list", () => ({
  PluginLibraryList: () => <div data-testid="plugin-library-list-stub" />,
}))

jest.mock("./plugin-library-status-bar", () => ({
  PluginLibraryStatusBar: () => <div data-testid="plugin-library-status-bar-stub" />,
}))

import { PluginLibraryPane } from "./plugin-library-pane"

describe("PluginLibraryPane", () => {
  // The capability facets moved into the section nav rail. A second rail in
  // this pane is what squeezed the list on an ordinary desktop window.
  it("renders no capability rail of its own", () => {
    render(<PluginLibraryPane />)
    expect(screen.getByTestId("plugin-library-pane")).toBeInTheDocument()
    expect(screen.queryByTestId("plugin-library-capability-rail")).toBeNull()
    expect(screen.queryByTestId("plugin-category-facets")).toBeNull()
    expect(screen.getByTestId("plugin-library-list-stub")).toBeInTheDocument()
  })

  // The filter/status strip sits above the scroller, so the chips stay put
  // while rows scroll and appear without resizing the page header.
  it("mounts the status strip above the list scroller", () => {
    render(<PluginLibraryPane />)
    const strip = screen.getByTestId("plugin-library-status-bar-stub")
    const scroller = screen.getByTestId("plugin-library-list-column")
    expect(scroller.contains(strip)).toBe(false)
    expect(scroller).toHaveClass("overflow-y-auto")
    expect(strip.compareDocumentPosition(scroller) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("opens the list container the rows and cards size against", () => {
    render(<PluginLibraryPane />)
    // The class IS the mechanism under test (rows gate on `@sm/plugin-list`).
    expect(screen.getByTestId("plugin-library-pane").className).toContain("@container/plugin-list")
  })
})
