/**
 * Tests for the workspace component-tree panel.
 */

import React from "react"
import { createEvent, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { TooltipProvider } from "@/components/ui/tooltip"

const storeState: {
  surfaces: Record<string, unknown>
  moveComponent?: jest.Mock
} = { surfaces: {} }

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}))

import { A2UIWorkspaceProvider } from "./a2ui-workspace-context"
import { ComponentTreePanel } from "./component-tree-panel"

function renderTree(surfaceId = "sx", props: React.ComponentProps<typeof ComponentTreePanel> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as Record<string, unknown>}>
      <TooltipProvider>
        <A2UIWorkspaceProvider surfaceId={surfaceId}>
          <ComponentTreePanel {...props} />
        </A2UIWorkspaceProvider>
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

// jsdom returns a zero-rect from getBoundingClientRect and drops `clientY` from
// fireEvent init, so stub both to control the top/bottom-half drop position.
function dropAt(row: HTMLElement, clientY: number) {
  row.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom: 20,
      height: 20,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect
  const event = createEvent.drop(row)
  Object.defineProperty(event, "clientY", { value: clientY })
  fireEvent(row, event)
}

describe("ComponentTreePanel", () => {
  beforeEach(() => {
    storeState.surfaces = {}
  })

  it("renders the no-surface fallback when the surface is missing", () => {
    renderTree("missing")
    expect(screen.getByText(/no surface loaded/i)).toBeInTheDocument()
  })

  it("renders the root component name as the top node", () => {
    storeState.surfaces = {
      sx: {
        rootId: "root",
        components: {
          root: { id: "root", component: "Column", children: ["c1"] },
          c1: { id: "c1", component: "Button" },
        },
      },
    }
    renderTree()
    expect(screen.getByText("Column")).toBeInTheDocument()
    // child is rendered because root is expanded by default
    expect(screen.getByText("Button")).toBeInTheDocument()
  })

  it("collapses a node when its chevron is clicked", () => {
    storeState.surfaces = {
      sx: {
        rootId: "root",
        components: {
          root: { id: "root", component: "Column", children: ["c1"] },
          c1: { id: "c1", component: "Button" },
        },
      },
    }
    renderTree()
    expect(screen.getByText("Button")).toBeInTheDocument()
    const toggleBtn = screen.getByRole("button", { name: "Collapse component" })
    fireEvent.click(toggleBtn)
    expect(screen.queryByText("Button")).toBeNull()
  })

  it("exposes localized duplicate and delete actions", () => {
    storeState.surfaces = {
      sx: {
        rootId: "root",
        components: {
          root: { id: "root", component: "Column", children: [] },
        },
      },
    }
    const onDuplicateSelected = jest.fn()
    const onDeleteSelected = jest.fn()
    renderTree("sx", {
      canDuplicateSelected: true,
      canDeleteSelected: true,
      onDuplicateSelected,
      onDeleteSelected,
    })

    fireEvent.click(screen.getByRole("button", { name: "Duplicate Component" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete Component" }))
    expect(onDuplicateSelected).toHaveBeenCalledTimes(1)
    expect(onDeleteSelected).toHaveBeenCalledTimes(1)
  })

  it("disables component actions when the current selection cannot be mutated", () => {
    storeState.surfaces = {
      sx: {
        rootId: "root",
        components: {
          root: { id: "root", component: "Column", children: [] },
        },
      },
    }
    renderTree("sx", { canDuplicateSelected: false, canDeleteSelected: false })

    expect(screen.getByRole("button", { name: "Duplicate Component" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Delete Component" })).toBeDisabled()
  })

  it("reorders a sibling before the drop target on a top-half drop", () => {
    const moveComponent = jest.fn(() => true)
    storeState.moveComponent = moveComponent
    storeState.surfaces = {
      sx: {
        rootId: "root",
        components: {
          root: { id: "root", component: "Column", children: ["first", "second"] },
          first: { id: "first", component: "Text", text: "First" },
          second: { id: "second", component: "Text", text: "Second" },
        },
      },
    }
    renderTree()
    const firstRow = screen.getByRole("treeitem", { name: /Text first/i })
    const secondRow = screen.getByRole("treeitem", { name: /Text second/i })

    fireEvent.dragStart(secondRow)
    dropAt(firstRow, 5) // top half (< midpoint 10) → insert before "first"

    expect(moveComponent).toHaveBeenCalledWith("sx", "second", {
      parentId: "root",
      slotId: "/children",
      index: 0,
    })
  })

  it("reorders a sibling after the drop target on a bottom-half drop", () => {
    const moveComponent = jest.fn(() => true)
    storeState.moveComponent = moveComponent
    storeState.surfaces = {
      sx: {
        rootId: "root",
        components: {
          root: { id: "root", component: "Column", children: ["first", "second"] },
          first: { id: "first", component: "Text", text: "First" },
          second: { id: "second", component: "Text", text: "Second" },
        },
      },
    }
    renderTree()
    const firstRow = screen.getByRole("treeitem", { name: /Text first/i })
    const secondRow = screen.getByRole("treeitem", { name: /Text second/i })

    fireEvent.dragStart(firstRow)
    dropAt(secondRow, 15) // bottom half (> midpoint 10) → after "second"

    // after=true → base index 2; same-slot down-shift → 1 (first lands after second)
    expect(moveComponent).toHaveBeenCalledWith("sx", "first", {
      parentId: "root",
      slotId: "/children",
      index: 1,
    })
  })

  it("does not move a node dropped onto itself", () => {
    const moveComponent = jest.fn(() => true)
    storeState.moveComponent = moveComponent
    storeState.surfaces = {
      sx: {
        rootId: "root",
        components: {
          root: { id: "root", component: "Column", children: ["first"] },
          first: { id: "first", component: "Text", text: "First" },
        },
      },
    }
    renderTree()
    const firstRow = screen.getByRole("treeitem", { name: /Text first/i })

    fireEvent.dragStart(firstRow)
    fireEvent.drop(firstRow, { clientY: 10 })

    expect(moveComponent).not.toHaveBeenCalled()
  })

  it("opens catalog add and selected-component move dialogs from visible controls", () => {
    storeState.surfaces = {
      sx: {
        rootId: "root",
        components: {
          root: { id: "root", component: "Column", children: ["first", "second"] },
          first: { id: "first", component: "Text", text: "First" },
          second: { id: "second", component: "Text", text: "Second" },
        },
      },
    }
    renderTree("sx", {
      onAddComponent: jest.fn(() => true),
      onMoveSelected: jest.fn(() => true),
    })

    fireEvent.click(screen.getByRole("button", { name: "Add Component" }))
    expect(screen.getByRole("dialog", { name: "Add Component" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    fireEvent.click(screen.getByRole("treeitem", { name: /Text first/i }))
    fireEvent.click(screen.getByRole("button", { name: "Move Component" }))
    expect(screen.getByRole("dialog", { name: "Move Component" })).toBeInTheDocument()
  })
})
