/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import "@testing-library/jest-dom"
import { fireEvent, render, screen } from "@testing-library/react"

import { createEditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"

// Stub the heavy InspectorPanel (Monaco/schema-form registry) — we only
// assert the drawer embeds it and exposes the Connect action.
jest.mock("@/components/workflow/editor/inspector-panel", () => ({
  InspectorPanel: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="embedded-inspector" data-embedded={String(!!embedded)} />
  ),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    ({ inspectorTitle: "Node config", connect: "Connect" })[key] ?? key,
}))

import { MobileNodeInspectorDrawer } from "./mobile-node-inspector-drawer"

function buildWorkflow(): VisualWorkflow {
  return {
    id: "wf_drawer",
    schemaVersion: 1,
    name: "Drawer",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "ai_a",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "AI A", params: {} },
      },
    ],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
  }
}

describe("<MobileNodeInspectorDrawer />", () => {
  it("renders the embedded inspector when open", () => {
    const store = createEditorStore(buildWorkflow())
    render(
      <MobileNodeInspectorDrawer
        open
        onOpenChange={() => {}}
        store={store}
        canConnect={false}
        onStartConnect={() => {}}
      />
    )
    const inspector = screen.getByTestId("embedded-inspector")
    expect(inspector).toBeInTheDocument()
    expect(inspector).toHaveAttribute("data-embedded", "true")
  })

  it("hides the Connect action when canConnect is false", () => {
    const store = createEditorStore(buildWorkflow())
    render(
      <MobileNodeInspectorDrawer
        open
        onOpenChange={() => {}}
        store={store}
        canConnect={false}
        onStartConnect={() => {}}
      />
    )
    expect(screen.queryByTestId("mobile-inspector-connect")).toBeNull()
  })

  it("fires onStartConnect when Connect is tapped in edit mode", () => {
    const store = createEditorStore(buildWorkflow())
    const onStartConnect = jest.fn()
    render(
      <MobileNodeInspectorDrawer
        open
        onOpenChange={() => {}}
        store={store}
        canConnect
        onStartConnect={onStartConnect}
      />
    )
    // fireEvent.click (not userEvent) — Vaul intercepts the pointerdown
    // sequence on the drawer content for drag handling, which throws in jsdom.
    fireEvent.click(screen.getByTestId("mobile-inspector-connect"))
    expect(onStartConnect).toHaveBeenCalledTimes(1)
  })

  it("does not render content when closed", () => {
    const store = createEditorStore(buildWorkflow())
    render(
      <MobileNodeInspectorDrawer
        open={false}
        onOpenChange={() => {}}
        store={store}
        canConnect
        onStartConnect={() => {}}
      />
    )
    expect(screen.queryByTestId("embedded-inspector")).toBeNull()
  })
})
