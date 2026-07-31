/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"
import { createEditorStore } from "./store"
import {
  buildMentionableWorkflowElements,
  useMentionableWorkflowElements,
} from "./use-mentionable-workflow-elements"
import type { VisualWorkflow } from "@/types/workflow/visual"

function emptyWorkflow(): VisualWorkflow {
  return {
    id: "wf_test",
    schemaVersion: 1,
    name: "Empty",
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

describe("buildMentionableWorkflowElements", () => {
  it("projects nodes and edges into mentionable elements", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const a = useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const b = useStore.getState().addNode("ai.prompt", { x: 200, y: 0 })
    useStore.getState().updateNodeData(a, { label: "Start" })
    useStore.getState().updateNodeData(b, { label: "Draft" })
    const e = useStore.getState().connect({ source: a, target: b })

    const els = buildMentionableWorkflowElements(
      useStore.getState().nodes,
      useStore.getState().edges
    )

    const node = els.find((x) => x.id === a)
    expect(node).toMatchObject({ type: "node", label: "Start", kind: "trigger.manual" })
    // searchText is a lowercased haystack (id + label + kind).
    expect(node?.searchText).toContain(a.toLowerCase())
    expect(node?.searchText).toBe(node?.searchText.toLowerCase())

    const edge = els.find((x) => x.id === e)
    expect(edge?.type).toBe("edge")
    // Endpoints read as node labels, not raw ids.
    expect(edge?.label).toBe("Start → Draft")
    expect(edge?.sublabel).toBe("Start → Draft")
    expect(typeof edge?.kind).toBe("string")
  })

  it("falls back to the node id when the label is blank", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const a = useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    useStore.getState().updateNodeData(a, { label: "" })
    const els = buildMentionableWorkflowElements(useStore.getState().nodes, [])
    expect(els).toHaveLength(1)
    expect(els[0].label).toBe(a)
  })

  it("resolves edge label / kind across the explicit, top-level, and derived branches", () => {
    // Hand-built RF shapes exercise the branches the store's default edges don't:
    // an explicit edge kind + data.label, a top-level `label`, a bare edge with
    // unknown endpoints, and a non-string node label.
    const nodes = [
      { id: "n_a", data: { kind: "ai.prompt", label: "Alpha" } },
      { id: "n_b", data: { kind: "flow.branch", label: 123 } },
    ] as never
    const edges = [
      { id: "e_1", source: "n_a", target: "n_b", data: { kind: "conditional", label: "yes" } },
      { id: "e_2", source: "n_a", target: "n_b", label: "top-level" },
      { id: "e_3", source: "n_x", target: "n_y" },
    ] as never
    const byId = Object.fromEntries(
      buildMentionableWorkflowElements(nodes, edges).map((e) => [e.id, e])
    )
    // Non-string node label → id fallback.
    expect(byId["n_b"].label).toBe("n_b")
    // Explicit edge data.label + data.kind win.
    expect(byId["e_1"]).toMatchObject({ label: "yes", kind: "conditional" })
    // Top-level `label` is the next fallback.
    expect(byId["e_2"].label).toBe("top-level")
    // No label + unknown endpoints → derived "src → tgt", default kind.
    expect(byId["e_3"]).toMatchObject({ kind: "default", label: "n_x → n_y" })
  })
})

describe("useMentionableWorkflowElements", () => {
  it("reactively returns the store's mentionable elements", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().addNode("ai.prompt", { x: 0, y: 0 })
    const { result } = renderHook(() => useMentionableWorkflowElements(useStore))
    expect(result.current).toHaveLength(1)
    expect(result.current[0].type).toBe("node")
  })

  it("keeps a stable list across position-only node updates (drag frames)", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const a = useStore.getState().addNode("ai.prompt", { x: 0, y: 0 })
    const { result } = renderHook(() => useMentionableWorkflowElements(useStore))
    const before = result.current

    // Simulate a drag frame: replace the nodes array with only positions changed.
    act(() => {
      useStore.setState((s) => ({
        nodes: s.nodes.map((n) => ({ ...n, position: { x: 42, y: 42 } })),
      }))
    })
    // Same array reference — no rebuild, no re-render churn during drags.
    expect(result.current).toBe(before)

    // A label change IS reflected.
    act(() => {
      useStore.getState().updateNodeData(a, { label: "Renamed" })
    })
    expect(result.current).not.toBe(before)
    expect(result.current[0].label).toBe("Renamed")
  })
})
