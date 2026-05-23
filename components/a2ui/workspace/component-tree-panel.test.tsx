/**
 * Tests for the workspace component-tree panel.
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

const storeState: { surfaces: Record<string, unknown> } = { surfaces: {} }

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}))

import { A2UIWorkspaceProvider } from "./a2ui-workspace-context"
import { ComponentTreePanel } from "./component-tree-panel"

function renderTree(surfaceId = "sx") {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as Record<string, unknown>}>
      <A2UIWorkspaceProvider surfaceId={surfaceId}>
        <ComponentTreePanel />
      </A2UIWorkspaceProvider>
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
    // The first button in the tree is the chevron toggle of the root.
    const toggleBtn = screen.getAllByRole("button")[0]
    fireEvent.click(toggleBtn)
    expect(screen.queryByText("Button")).toBeNull()
  })
})
