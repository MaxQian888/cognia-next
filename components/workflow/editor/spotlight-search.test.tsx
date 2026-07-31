/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { SpotlightSearch } from "./spotlight-search"

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
  const trigger = store.getState().addNode("trigger.manual", { x: 0, y: 0 })
  store.getState().updateNodeData(trigger, { label: "Manual trigger" })
  return { store, ids: { ai, action, trigger } }
}

function fakeRfi() {
  const setViewport = jest.fn()
  const setCenter = jest.fn()
  const fitView = jest.fn()
  return {
    rfi: { setViewport, setCenter, fitView } as unknown as never,
    setViewport,
    setCenter,
    fitView,
  }
}

describe("SpotlightSearch", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true })
    Object.defineProperty(window, "innerHeight", { value: 768, configurable: true })
  })

  it("renders the input when open", async () => {
    const { store } = seed()
    const { rfi } = fakeRfi()
    render(
      <SpotlightSearch
        open
        onOpenChange={() => undefined}
        store={store}
        reactFlowInstance={rfi}
        animationsEnabled
      />
    )
    expect(await screen.findByTestId("spotlight-input")).toBeInTheDocument()
  })

  it("renders rows for every node", async () => {
    const { store, ids } = seed()
    const { rfi } = fakeRfi()
    render(
      <SpotlightSearch
        open
        onOpenChange={() => undefined}
        store={store}
        reactFlowInstance={rfi}
        animationsEnabled
      />
    )
    expect(await screen.findByTestId(`spotlight-row-${ids.ai}`)).toBeInTheDocument()
    expect(screen.getByTestId(`spotlight-row-${ids.action}`)).toBeInTheDocument()
    expect(screen.getByTestId(`spotlight-row-${ids.trigger}`)).toBeInTheDocument()
  })

  it("filters rows by typed substring", async () => {
    const { store, ids } = seed()
    const { rfi } = fakeRfi()
    render(
      <SpotlightSearch
        open
        onOpenChange={() => undefined}
        store={store}
        reactFlowInstance={rfi}
        animationsEnabled
      />
    )
    const user = userEvent.setup()
    const input = await screen.findByTestId("spotlight-input")
    await user.type(input, "summar")
    await waitFor(() => {
      expect(screen.getByTestId(`spotlight-row-${ids.ai}`)).toBeInTheDocument()
      expect(screen.queryByTestId(`spotlight-row-${ids.action}`)).toBeNull()
      expect(screen.queryByTestId(`spotlight-row-${ids.trigger}`)).toBeNull()
    })
  })

  it("selecting a row centers the node via setCenter, selects it, and pulses it", async () => {
    const { store, ids } = seed()
    const { rfi, setCenter, setViewport } = fakeRfi()
    const onOpenChange = jest.fn()
    render(
      <SpotlightSearch
        open
        onOpenChange={onOpenChange}
        store={store}
        reactFlowInstance={rfi}
        animationsEnabled
      />
    )
    fireEvent.click(await screen.findByTestId(`spotlight-row-${ids.action}`))
    // Centering must go through setCenter (pane-aware) — NOT setViewport with
    // window-width math, which lands the node right of the canvas centre when
    // a sidebar is open. action node @ (800,200), 240×80 → centre (920, 240).
    expect(setViewport).not.toHaveBeenCalled()
    expect(setCenter).toHaveBeenCalledTimes(1)
    const [cx, cy, opts] = setCenter.mock.calls[0]
    expect(cx).toBe(920)
    expect(cy).toBe(240)
    expect(opts.zoom).toBeCloseTo(1.2)
    expect(opts.duration).toBe(240)
    expect(store.getState().selectedNodeIds).toEqual([ids.action])
    expect(store.getState().spotlightedNodeId).toBe(ids.action)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("uses duration=0 and ms=0 when animationsEnabled=false", async () => {
    const { store, ids } = seed()
    const { rfi, setCenter } = fakeRfi()
    render(
      <SpotlightSearch
        open
        onOpenChange={() => undefined}
        store={store}
        reactFlowInstance={rfi}
        animationsEnabled={false}
      />
    )
    fireEvent.click(await screen.findByTestId(`spotlight-row-${ids.ai}`))
    expect(setCenter.mock.calls[0][2].duration).toBe(0)
    // With ms=0, the spotlightedNodeId is cleared synchronously.
    expect(store.getState().spotlightedNodeId).toBeNull()
  })

  it("renders a group breadcrumb segment for nodes inside an annotation.group", async () => {
    const store = createEditorStore(makeWorkflow())
    // Group at (0,0) with explicit size 500×500.
    store.getState().addNode(
      "annotation.group",
      { x: 0, y: 0 },
      {
        label: "Group A",
        params: { title: "Onboarding subgraph", width: 500, height: 500 },
      }
    )
    // AI node whose centre lies inside the group (50+120 = 170 < 500).
    const aiId = store.getState().addNode("ai.prompt", { x: 50, y: 50 })
    store.getState().updateNodeData(aiId, { label: "Summarise email" })
    // Sibling node OUTSIDE the group.
    const outsideId = store.getState().addNode("ai.prompt", { x: 900, y: 900 })
    store.getState().updateNodeData(outsideId, { label: "Outside node" })

    const { rfi } = fakeRfi()
    render(
      <SpotlightSearch
        open
        onOpenChange={() => undefined}
        store={store}
        reactFlowInstance={rfi}
        animationsEnabled
      />
    )

    const breadcrumb = await screen.findByTestId(`spotlight-breadcrumb-${aiId}`)
    expect(breadcrumb.textContent).toContain("Onboarding subgraph")
    // The outside-the-group node should NOT have a breadcrumb segment.
    expect(screen.queryByTestId(`spotlight-breadcrumb-${outsideId}`)).toBeNull()
  })
})
