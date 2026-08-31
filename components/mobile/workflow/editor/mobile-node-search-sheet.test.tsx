/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"

import { MobileNodeSearchSheet } from "./mobile-node-search-sheet"

const messages = {
  workflows: {
    editor: {
      spotlight: {
        openShortcut: "Search nodes",
        placeholder: "Search nodes on this canvas",
        empty: "No matching nodes.",
        breadcrumbIn: "in {group}",
      },
    },
  },
}

function makeWorkflow(): VisualWorkflow {
  return {
    id: "wf_test",
    schemaVersion: 1,
    name: "Test",
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
    viewport: { x: 0, y: 0, zoom: 1 },
  }
}

function seed(): { store: EditorStore; ids: Record<string, string> } {
  const store = createEditorStore(makeWorkflow())
  const ai = store.getState().addNode("ai.prompt", { x: 100, y: 200 })
  store.getState().updateNodeData(ai, { label: "Summarise email" })
  const action = store.getState().addNode("action.skill.invoke", { x: 800, y: 200 })
  store.getState().updateNodeData(action, { label: "Send Slack message" })
  return { store, ids: { ai, action } }
}

function renderSheet(store: EditorStore, open = true) {
  const setCenter = jest.fn()
  const onOpenChange = jest.fn()
  const onReveal = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MobileNodeSearchSheet
        open={open}
        onOpenChange={onOpenChange}
        store={store}
        reactFlowInstance={{ setCenter }}
        onReveal={onReveal}
      />
    </NextIntlClientProvider>
  )
  return { setCenter, onOpenChange, onReveal }
}

describe("MobileNodeSearchSheet", () => {
  it("lists every node on the canvas", () => {
    const { store, ids } = seed()
    renderSheet(store)

    expect(screen.getByTestId(`mobile-node-search-row-${ids.ai}`)).toBeInTheDocument()
    expect(screen.getByTestId(`mobile-node-search-row-${ids.action}`)).toBeInTheDocument()
  })

  it("filters on the same haystack the desktop dialog matches against", () => {
    const { store, ids } = seed()
    renderSheet(store)

    fireEvent.change(screen.getByTestId("mobile-node-search-input"), {
      target: { value: "slack" },
    })

    expect(screen.getByTestId(`mobile-node-search-row-${ids.action}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`mobile-node-search-row-${ids.ai}`)).toBeNull()
  })

  it("says so rather than showing an empty list", () => {
    const { store } = seed()
    renderSheet(store)

    fireEvent.change(screen.getByTestId("mobile-node-search-input"), {
      target: { value: "nothing matches this" },
    })

    expect(screen.getByText("No matching nodes.")).toBeInTheDocument()
  })

  it("centres, selects and pulses the tapped node, then closes onto the canvas", () => {
    const { store, ids } = seed()
    const { setCenter, onOpenChange, onReveal } = renderSheet(store)

    fireEvent.click(screen.getByTestId(`mobile-node-search-row-${ids.action}`))

    // Same pane-aware centring the desktop uses: the action node sits at
    // (800,200) with a 240x80 box, so its centre is (920, 240).
    expect(setCenter).toHaveBeenCalledWith(920, 240, { zoom: 1.2, duration: 240 })
    expect(store.getState().selectedNodeIds).toEqual([ids.action])
    expect(store.getState().spotlightedNodeId).toBe(ids.action)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onReveal).toHaveBeenCalledWith(ids.action)
  })

  it("names the group a node sits in", () => {
    const { store, ids } = seed()
    store.getState().addNode(
      "annotation.group",
      { x: 0, y: 0 },
      { label: "Group", params: { title: "Onboarding", width: 500, height: 500 } }
    )
    renderSheet(store)

    expect(screen.getByTestId(`mobile-node-search-breadcrumb-${ids.ai}`)).toHaveTextContent(
      "in Onboarding"
    )
    expect(screen.queryByTestId(`mobile-node-search-breadcrumb-${ids.action}`)).toBeNull()
  })
})
