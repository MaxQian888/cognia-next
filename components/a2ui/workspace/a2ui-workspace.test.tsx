/**
 * Smoke test for the workspace orchestrator.
 *
 * The full workspace composes ~9 panels + Zustand + Next-intl + shadcn
 * resizable + sonner toaster. The test verifies it mounts without crashing
 * given a minimal mocked store + i18n context and exposes the header /
 * toolbar / preview surface.
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { TooltipProvider } from "@/components/ui/tooltip"
import enMessages from "@/i18n/messages/en.json"

// Stub the store with a minimal selector-based mock.
const storeState: Record<string, unknown> = {
  surfaces: { sx: { id: "sx", title: "Sample", ready: true, components: {}, dataModel: {} } },
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
}

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (state: Record<string, unknown>) => unknown) => selector(storeState),
}))

// Heavy panels are stubbed so this test stays focused on orchestration.
jest.mock("./component-tree-panel", () => ({
  ComponentTreePanel: () => <div data-testid="tree-panel" />,
}))
jest.mock("./property-inspector-panel", () => ({
  PropertyInspectorPanel: () => <div data-testid="props-panel" />,
}))
jest.mock("./data-model-panel", () => ({
  DataModelPanel: () => <div data-testid="data-panel" />,
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
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
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
  it("mounts header, toolbar and preview surface for the desktop layout", () => {
    renderWorkspace(<A2UIWorkspace surfaceId="sx" />)
    expect(screen.getByText("Sample")).toBeInTheDocument() // header title
    expect(screen.getAllByTestId("surface-preview").length).toBeGreaterThan(0)
    expect(screen.getAllByTestId("tree-panel").length).toBeGreaterThan(0)
    expect(screen.getAllByTestId("props-panel").length).toBeGreaterThan(0)
  })

  it("applies the optional className to the outer wrapper", () => {
    const { container } = renderWorkspace(<A2UIWorkspace surfaceId="sx" className="custom-shell" />)
    expect(container.querySelector(".custom-shell")).not.toBeNull()
  })
})
