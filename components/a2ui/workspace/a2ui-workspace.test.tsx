/**
 * Smoke test for the workspace orchestrator.
 *
 * The full workspace composes ~9 panels + Zustand + Next-intl + shadcn
 * resizable + sonner toaster. The test verifies it mounts without crashing
 * given a minimal mocked store + i18n context and exposes the header /
 * toolbar / preview surface.
 */

import React from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { TooltipProvider } from "@/components/ui/tooltip"
import enMessages from "@/i18n/messages/en.json"

// Stub the store with a minimal selector-based mock.
const storeState: Record<string, unknown> = {
  surfaces: {
    sx: {
      id: "sx",
      title: "Sample",
      ready: true,
      rootId: "root",
      components: {
        root: { id: "root", component: "Column", children: ["child"] },
        child: { id: "child", component: "Text", text: "Child" },
      },
      dataModel: {},
    },
  },
  undoStacks: {},
  redoStacks: {},
  errors: {},
  loadingSurfaces: {},
  streamingSurfaces: {},
  undo: jest.fn(),
  redo: jest.fn(),
  setError: jest.fn(),
  setDataValue: jest.fn(),
  updateComponents: jest.fn(),
  emitAction: jest.fn(),
  deleteSurface: jest.fn(),
  removeComponent: jest.fn(() => true),
  duplicateComponent: jest.fn(() => "child-copy"),
  addComponentSubtree: jest.fn(() => true),
  addComponentSubtreeToRoot: jest.fn(() => true),
  moveComponent: jest.fn(() => true),
}

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (state: Record<string, unknown>) => unknown) => selector(storeState),
}))

// Heavy panels are stubbed so this test stays focused on orchestration.
jest.mock("./component-tree-panel", () => ({
  ComponentTreePanel: (props: {
    onDeleteSelected?: () => void
    onDuplicateSelected?: () => void
    onAddComponent?: (
      type: string,
      placement: { parentId: string; slotId: string; index?: number }
    ) => boolean
    onAddComponentToRoot?: (type: string) => boolean
    onMoveSelected?: (placement: { parentId: string; slotId: string; index?: number }) => boolean
  }) => {
    const React = jest.requireActual<typeof import("react")>("react")
    const { useWorkspaceContext } = jest.requireActual<typeof import("./a2ui-workspace-context")>(
      "./a2ui-workspace-context"
    )
    const { setSelectedComponentId } = useWorkspaceContext()
    return React.createElement(
      "div",
      { "data-testid": "tree-panel" },
      React.createElement(
        "button",
        { "data-testid": "select-child", onClick: () => setSelectedComponentId("child") },
        "select"
      ),
      React.createElement(
        "button",
        { "data-testid": "tree-delete", onClick: props.onDeleteSelected },
        "delete"
      ),
      React.createElement(
        "button",
        { "data-testid": "tree-duplicate", onClick: props.onDuplicateSelected },
        "duplicate"
      ),
      React.createElement(
        "button",
        {
          "data-testid": "tree-add",
          onClick: () =>
            props.onAddComponent?.("Popover", {
              parentId: "root",
              slotId: "/children",
              index: 1,
            }),
        },
        "add"
      ),
      React.createElement(
        "button",
        {
          "data-testid": "tree-add-root",
          onClick: () => props.onAddComponentToRoot?.("Card"),
        },
        "add-root"
      ),
      React.createElement(
        "button",
        {
          "data-testid": "tree-move",
          onClick: () =>
            props.onMoveSelected?.({ parentId: "root", slotId: "/children", index: 0 }),
        },
        "move"
      )
    )
  },
}))
jest.mock("./property-inspector-panel", () => ({
  PropertyInspectorPanel: () => <div data-testid="props-panel" />,
}))
jest.mock("./data-model-panel", () => ({
  DataModelPanel: () => <div data-testid="data-panel" />,
}))
jest.mock("./version-history-panel", () => ({
  VersionHistoryPanel: () => <div data-testid="history-panel" />,
}))
jest.mock("./a2ui-error-panel", () => ({
  A2UIErrorPanel: () => null,
}))
jest.mock("@/components/a2ui/a2ui-surface", () => ({
  A2UIInlineSurface: () => <div data-testid="surface-preview" />,
}))
jest.mock("@/hooks/a2ui/use-app-builder", () => ({
  useA2UIAppBuilder: () => ({ exportApp: jest.fn() }),
}))
jest.mock("@/hooks/a2ui/use-a2ui-save", () => ({
  useA2UISave: () => jest.fn(async () => true),
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

let mockShortcutOptions: Record<string, (() => void) | undefined> = {}
jest.mock("@/hooks/a2ui/use-a2ui-workspace-shortcuts", () => ({
  useA2UIWorkspaceShortcuts: (options: Record<string, (() => void) | undefined>) => {
    mockShortcutOptions = options
  },
}))

import { A2UIWorkspace } from "./a2ui-workspace"

function renderWorkspace(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as Record<string, unknown>}>
      <TooltipProvider>{node}</TooltipProvider>
    </NextIntlClientProvider>
  )
}

describe("A2UIWorkspace", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockShortcutOptions = {}
  })

  it("mounts header, toolbar, preview, and reachable version history", async () => {
    const user = userEvent.setup()
    renderWorkspace(<A2UIWorkspace surfaceId="sx" />)
    expect(screen.getByText("Sample")).toBeInTheDocument() // header title
    expect(screen.getAllByTestId("surface-preview").length).toBeGreaterThan(0)
    expect(screen.getAllByTestId("tree-panel").length).toBeGreaterThan(0)
    expect(screen.getAllByTestId("props-panel").length).toBeGreaterThan(0)
    for (const historyTab of screen.getAllByRole("tab", { name: "Version History" })) {
      await user.click(historyTab)
    }
    expect(screen.getAllByTestId("history-panel").length).toBeGreaterThan(0)
  })

  it("applies the optional className to the outer wrapper", () => {
    const { container } = renderWorkspace(<A2UIWorkspace surfaceId="sx" className="custom-shell" />)
    expect(container.querySelector(".custom-shell")).not.toBeNull()
  })

  it("wires visible controls and registered shortcuts to selected-component mutations", () => {
    renderWorkspace(<A2UIWorkspace surfaceId="sx" />)
    fireEvent.click(screen.getAllByTestId("select-child")[0])

    fireEvent.click(screen.getAllByTestId("tree-duplicate")[0])
    expect(storeState.duplicateComponent).toHaveBeenCalledWith("sx", "child")

    fireEvent.click(screen.getAllByTestId("select-child")[0])
    act(() => mockShortcutOptions.onDeleteComponent?.())
    expect(storeState.removeComponent).toHaveBeenCalledWith("sx", "child")

    fireEvent.click(screen.getAllByTestId("select-child")[0])
    act(() => mockShortcutOptions.onDuplicateComponent?.())
    expect(storeState.duplicateComponent).toHaveBeenCalledWith("sx", "child")

    fireEvent.click(screen.getAllByTestId("tree-add")[0])
    expect(storeState.addComponentSubtree).toHaveBeenCalledWith(
      "sx",
      expect.arrayContaining([
        expect.objectContaining({
          id: "popover",
          component: "Popover",
          trigger: "popover-trigger",
        }),
        expect.objectContaining({ id: "popover-trigger", component: "Button" }),
      ]),
      "popover",
      { parentId: "root", slotId: "/children", index: 1 }
    )

    fireEvent.click(screen.getAllByTestId("tree-add-root")[0])
    expect(storeState.addComponentSubtreeToRoot).toHaveBeenCalledWith(
      "sx",
      [expect.objectContaining({ id: "card", component: "Card", children: [] })],
      "card"
    )

    fireEvent.click(screen.getAllByTestId("select-child")[0])
    fireEvent.click(screen.getAllByTestId("tree-move")[0])
    expect(storeState.moveComponent).toHaveBeenCalledWith("sx", "child", {
      parentId: "root",
      slotId: "/children",
      index: 0,
    })
  })

  it("applies toolbar zoom to the shared preview rendering path", () => {
    renderWorkspace(<A2UIWorkspace surfaceId="sx" />)
    const previews = screen.getAllByTestId("workspace-preview-scale")
    expect(previews[0]).toHaveStyle({ transform: "scale(1)" })

    fireEvent.click(screen.getByRole("button", { name: "Zoom In" }))
    for (const preview of previews) {
      expect(preview).toHaveStyle({ transform: "scale(1.25)" })
    }

    fireEvent.click(screen.getByRole("button", { name: "Reset Zoom (125%)" }))
    for (const preview of previews) {
      expect(preview).toHaveStyle({ transform: "scale(1)" })
    }
  })

  it("toggles desktop tree and property panels without removing mobile navigation", () => {
    renderWorkspace(<A2UIWorkspace surfaceId="sx" />)
    expect(screen.getAllByTestId("tree-panel")).toHaveLength(1)
    expect(screen.getAllByTestId("props-panel")).toHaveLength(1)

    fireEvent.click(screen.getByRole("button", { name: "Hide component tree" }))
    expect(screen.queryByTestId("tree-panel")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Show component tree" })).toBeInTheDocument()

    expect(screen.getByRole("tab", { name: "Components" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Hide properties panel" }))
    expect(screen.queryByTestId("props-panel")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Show properties panel" })).toBeInTheDocument()

    expect(screen.getAllByRole("tab", { name: "Properties" }).length).toBeGreaterThan(0)
  })
})
