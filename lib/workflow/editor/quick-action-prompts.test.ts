import type { EditorState } from "./store"
import { buildQuickActionPrompt } from "./quick-action-prompts"

function makeState(overrides: Partial<EditorState> = {}): EditorState {
  return {
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    baseWorkflow: { id: "wf_x", name: "Test wf" } as EditorState["baseWorkflow"],
    selectedNodeIds: [],
    selectedEdgeIds: [],
    dirty: false,
    savedAt: null,
    runStatusByStepId: {},
    validationByStepId: {},
    lastRunByStepId: {},
    ...overrides,
  } as unknown as EditorState
}

function makeNode(id: string, kind: string, label: string, params: Record<string, unknown> = {}) {
  return {
    id,
    type: "workflowNode" as const,
    position: { x: 0, y: 0 },
    data: { kind, label, params, typeVersion: 1 },
  } as unknown as EditorState["nodes"][number]
}

describe("buildQuickActionPrompt", () => {
  describe("validate", () => {
    it("returns the 'no issues' prompt when the graph is empty", () => {
      const out = buildQuickActionPrompt("validate", makeState())
      expect(out).not.toBeNull()
      expect(out).toMatch(/^\/validate/)
      expect(out).toContain("no validation errors")
    })

    it("includes the issue summary when nodes have invalid params", () => {
      // A cron-trigger node with an empty cron expression — params schema
      // requires `cron`, so `validateAllNodes` surfaces an issue under n_a.
      const nodes = [makeNode("n_a", "trigger.cron", "Daily", { cron: "" })]
      const out = buildQuickActionPrompt("validate", makeState({ nodes }))
      expect(out).not.toBeNull()
      expect(out).toMatch(/^\/validate/)
      expect(out).toContain("n_a")
      expect(out).toContain("issue")
    })
  })

  describe("explain", () => {
    it("falls back to a 'no selection' hint when nothing is picked", () => {
      const out = buildQuickActionPrompt("explain", makeState())
      expect(out).not.toBeNull()
      expect(out).toMatch(/^\/explain/)
      expect(out).toMatch(/no nodes are selected/i)
    })

    it("lists each selected node with id, label, kind", () => {
      const nodes = [
        makeNode("n_a", "ai.prompt", "Summarize"),
        makeNode("n_b", "email.send", "Notify user"),
      ]
      const out = buildQuickActionPrompt(
        "explain",
        makeState({ nodes, selectedNodeIds: ["n_a", "n_b"] })
      )
      expect(out).not.toBeNull()
      expect(out).toContain("`n_a`")
      expect(out).toContain("Summarize")
      expect(out).toContain("`ai.prompt`")
      expect(out).toContain("`n_b`")
      expect(out).toContain("Notify user")
      expect(out).toContain("`email.send`")
    })

    it("skips selected ids that aren't in the node list (stale selection)", () => {
      const nodes = [makeNode("n_a", "ai.prompt", "Summarize")]
      const out = buildQuickActionPrompt(
        "explain",
        makeState({ nodes, selectedNodeIds: ["n_a", "ghost"] })
      )
      expect(out).not.toBeNull()
      expect(out).toContain("`n_a`")
      expect(out).not.toContain("`ghost`")
    })
  })

  describe("suggest", () => {
    it("uses an empty-selection phrasing when nothing is picked", () => {
      const nodes = [makeNode("n_a", "ai.prompt", "Summarize")]
      const out = buildQuickActionPrompt("suggest", makeState({ nodes }))
      expect(out).not.toBeNull()
      expect(out).toMatch(/^\/suggest-next/)
      expect(out).toMatch(/no selection/i)
      expect(out).toContain("1 node")
    })

    it("includes selected nodes as anchor context", () => {
      const nodes = [
        makeNode("n_a", "ai.prompt", "Summarize"),
        makeNode("n_b", "email.send", "Notify"),
      ]
      const out = buildQuickActionPrompt("suggest", makeState({ nodes, selectedNodeIds: ["n_a"] }))
      expect(out).not.toBeNull()
      expect(out).toContain("`n_a`")
      expect(out).toContain("Summarize")
      expect(out).toMatch(/next node/i)
    })
  })

  it("returns null for an unknown quick-action kind", () => {
    // @ts-expect-error testing the defensive branch
    const out = buildQuickActionPrompt("frobnicate", makeState())
    expect(out).toBeNull()
  })
})
