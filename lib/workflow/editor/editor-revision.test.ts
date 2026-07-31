import { workflowEditorRevision } from "./editor-revision"

const state = {
  nodes: [
    {
      id: "n1",
      type: "workflowNode",
      position: { x: 1, y: 2 },
      data: { kind: "trigger.manual", label: "Start" },
    },
  ],
  edges: [],
} as never

describe("workflowEditorRevision", () => {
  it("changes for semantic graph edits but ignores UI-only node state", () => {
    const initial = workflowEditorRevision(state)
    expect(
      workflowEditorRevision({
        ...(state as object),
        nodes: [
          { ...(state as { nodes: object[] }).nodes[0], selected: true, measured: { width: 1 } },
        ],
        edges: [],
      } as never)
    ).toBe(initial)
    expect(
      workflowEditorRevision({
        ...(state as object),
        nodes: [{ ...(state as { nodes: object[] }).nodes[0], position: { x: 3, y: 2 } }],
        edges: [],
      } as never)
    ).not.toBe(initial)
  })
})
