/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom"
import { fireEvent, render, screen } from "@testing-library/react"

import type { NodeCatalogEntry } from "@/lib/workflow/nodes/catalog"

// Stub the catalog-driven sidebar — the palette test only verifies the sheet
// wraps it and forwards the tap-to-add callback.
jest.mock("@/components/workflow/editor/node-search-sidebar", () => ({
  NodeSearchSidebar: ({
    embedded,
    onAddNodeAtCenter,
  }: {
    embedded?: boolean
    onAddNodeAtCenter?: (entry: NodeCatalogEntry) => void
  }) => (
    <button
      type="button"
      data-testid="stub-sidebar"
      data-embedded={String(!!embedded)}
      onClick={() => onAddNodeAtCenter?.({ kind: "ai.prompt" } as NodeCatalogEntry)}
    >
      add-ai
    </button>
  ),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => ({ addNode: "Add node" })[key] ?? key,
}))

import { MobileNodePaletteSheet } from "./mobile-node-palette-sheet"

describe("<MobileNodePaletteSheet />", () => {
  it("renders the embedded sidebar when open", () => {
    render(<MobileNodePaletteSheet open onOpenChange={() => {}} onAdd={() => {}} />)
    const sidebar = screen.getByTestId("stub-sidebar")
    expect(sidebar).toBeInTheDocument()
    expect(sidebar).toHaveAttribute("data-embedded", "true")
  })

  it("forwards the picked entry to onAdd", () => {
    const onAdd = jest.fn()
    render(<MobileNodePaletteSheet open onOpenChange={() => {}} onAdd={onAdd} />)
    fireEvent.click(screen.getByTestId("stub-sidebar"))
    expect(onAdd).toHaveBeenCalledWith({ kind: "ai.prompt" })
  })

  it("renders nothing when closed", () => {
    render(<MobileNodePaletteSheet open={false} onOpenChange={() => {}} onAdd={() => {}} />)
    expect(screen.queryByTestId("stub-sidebar")).toBeNull()
  })
})
