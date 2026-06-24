/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { PluginLibraryListSkeleton, PluginLibraryGridSkeleton } from "./plugin-library-skeleton"

describe("plugin library skeletons", () => {
  it("renders the list skeleton with the requested row count", () => {
    render(<PluginLibraryListSkeleton count={3} />)
    const root = screen.getByTestId("plugin-library-list-skeleton")
    expect(root).toHaveAttribute("aria-busy")
    expect(root.children).toHaveLength(3)
  })

  it("renders the grid skeleton", () => {
    render(<PluginLibraryGridSkeleton count={2} />)
    expect(screen.getByTestId("plugin-library-grid-skeleton")).toBeInTheDocument()
  })
})
