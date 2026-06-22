import type { PluginNodeDef, PluginTriggerDef, PluginManifestWorkflowsBlock } from "./workflow"

/**
 * The workflow capability surface is type-only — the runtime API lives on
 * `PluginContext.workflow` and is re-exported under
 * `@cognia/plugin-sdk/context`. These compile-only assertions catch
 * upstream renames in `types/plugin/plugin-workflow.ts`.
 */
describe("plugin-sdk: api/workflow", () => {
  it("re-exports the node + trigger def shapes", () => {
    const node = {
      kind: "action.test",
      typeVersion: 1,
      category: "plugin",
      label: "Test",
      description: "test node",
      iconName: "Box",
      paramsSchema: { type: "object" },
      execute: jest.fn(),
    } as unknown as PluginNodeDef
    const trigger = {
      kind: "trigger.test",
      typeVersion: 1,
      label: "Test trigger",
      description: "test trigger",
      iconName: "Bell",
      paramsSchema: { type: "object" },
      start: jest.fn(),
    } as unknown as PluginTriggerDef
    expect(node.kind).toBe("action.test")
    expect(trigger.kind).toBe("trigger.test")
  })

  it("re-exports the manifest-side workflows block", () => {
    const block: PluginManifestWorkflowsBlock = {
      nodes: [
        {
          kind: "action.test",
          typeVersion: 1,
          category: "plugin",
          label: "Test",
          description: "test node",
          iconName: "Box",
          paramsSchema: { type: "object" },
        },
      ],
    }
    expect(block.nodes?.[0]?.kind).toBe("action.test")
  })
})
