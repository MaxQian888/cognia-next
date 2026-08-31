/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { MobileCanvasActionSheet } from "./mobile-canvas-action-sheet"
import type { CanvasPressTarget } from "./use-canvas-long-press"

const messages = {
  mobile: {
    workflow: {
      editor: {
        actions: {
          titleNode: "Node",
          titleEdge: "Connection",
          titleCanvas: "Canvas",
          configure: "Configure",
          runFrom: "Run from here",
          runOnly: "Run only this node",
          duplicate: "Duplicate",
          copy: "Copy",
          paste: "Paste",
          delete: "Delete node",
          deleteConnection: "Delete connection",
          addNode: "Add node",
          findNode: "Find node",
          fitView: "Fit to view",
        },
      },
    },
  },
}

function renderSheet(target: CanvasPressTarget | null, canPaste = false) {
  const handlers = {
    onOpenChange: jest.fn(),
    onAddNode: jest.fn(),
    onConfigure: jest.fn(),
    onDuplicate: jest.fn(),
    onCopy: jest.fn(),
    onPaste: jest.fn(),
    onRunFrom: jest.fn(),
    onRunOnly: jest.fn(),
    onDeleteNode: jest.fn(),
    onDeleteEdge: jest.fn(),
    onFitView: jest.fn(),
    onFindNode: jest.fn(),
  }
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MobileCanvasActionSheet target={target} canPaste={canPaste} {...handlers} />
    </NextIntlClientProvider>
  )
  return handlers
}

describe("MobileCanvasActionSheet", () => {
  it("stays shut when nothing was pressed", () => {
    renderSheet(null)
    expect(screen.queryByTestId("mobile-canvas-actions")).toBeNull()
  })

  it("offers the node actions a phone had no other way to reach", () => {
    // Before this, Delete lived only inside the node inspector, and copy,
    // paste and run-from-here did not exist on a phone at all.
    const h = renderSheet({ kind: "node", id: "n1" })
    fireEvent.click(screen.getByTestId("mobile-canvas-action-delete"))
    expect(h.onDeleteNode).toHaveBeenCalledWith("n1")
    expect(h.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("passes the pressed node id to every node action", () => {
    const h = renderSheet({ kind: "node", id: "n7" })
    fireEvent.click(screen.getByTestId("mobile-canvas-action-runFrom"))
    expect(h.onRunFrom).toHaveBeenCalledWith("n7")
  })

  it("offers only deletion for an edge", () => {
    const h = renderSheet({ kind: "edge", id: "e1" })
    expect(screen.queryByTestId("mobile-canvas-action-duplicate")).toBeNull()
    fireEvent.click(screen.getByTestId("mobile-canvas-action-deleteEdge"))
    expect(h.onDeleteEdge).toHaveBeenCalledWith("e1")
  })

  it("hides Paste when the clipboard holds nothing this editor can use", () => {
    renderSheet({ kind: "pane" })
    expect(screen.queryByTestId("mobile-canvas-action-paste")).toBeNull()
    expect(screen.getByTestId("mobile-canvas-action-addNode")).toBeInTheDocument()
  })

  it("shows Paste once the clipboard has been probed", () => {
    const h = renderSheet({ kind: "pane" }, true)
    fireEvent.click(screen.getByTestId("mobile-canvas-action-paste"))
    expect(h.onPaste).toHaveBeenCalled()
  })

  // The canvas is also where a search belongs: on a phone there is no
  // Ctrl/Cmd+F, and this sheet is the phone's right-click menu.
  it("finds a node from the canvas actions", () => {
    const h = renderSheet({ kind: "pane" })
    fireEvent.click(screen.getByTestId("mobile-canvas-action-findNode"))
    expect(h.onFindNode).toHaveBeenCalled()
    expect(h.onOpenChange).toHaveBeenCalledWith(false)
  })
})
