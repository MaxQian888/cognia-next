import { defineWorkflowNode } from "./define-workflow-node"

describe("defineWorkflowNode", () => {
  it("returns the node definition unchanged (pure pass-through)", () => {
    const execute = jest.fn(async () => ({ status: "success" as const, output: {} }))
    const node = defineWorkflowNode({
      kind: "action.fetchPage",
      typeVersion: 1,
      category: "plugin",
      label: "Fetch Page",
      description: "Fetch a URL and return its text.",
      iconName: "Globe",
      paramsSchema: { type: "object", properties: { url: { type: "string" } } },
      execute,
    })
    expect(node.kind).toBe("action.fetchPage")
    expect(node.execute).toBe(execute)
  })

  it("preserves optional retry/timeout/desktopOnly fields", () => {
    const node = defineWorkflowNode({
      kind: "action.x",
      typeVersion: 2,
      category: "plugin",
      label: "X",
      description: "x",
      iconName: "Box",
      paramsSchema: {},
      retryable: false,
      timeoutMs: 5000,
      desktopOnly: true,
      execute: async () => ({ status: "success", output: {} }),
    })
    expect(node).toMatchObject({ retryable: false, timeoutMs: 5000, desktopOnly: true })
  })
})
