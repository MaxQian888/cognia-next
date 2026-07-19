/**
 * Tests for the workspace component-tree panel.
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { TooltipProvider } from "@/components/ui/tooltip"

const storeState: { surfaces: Record<string, unknown> } = { surfaces: {} }

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
