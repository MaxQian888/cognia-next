import * as sdk from "./tool"
import type { PluginTool, PluginToolContext, PluginToolDef } from "./tool"

describe("plugin-sdk api/tool", () => {
  it("re-exports the plugin tool authoring helper", () => {
    expect(typeof sdk.defineTool).toBe("function")

    const def = sdk.defineTool({
      name: "summarize_text",
      description: "Summarize text.",
      parametersSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      requiresApproval: false,
    })

    expect(def.name).toBe("summarize_text")
    expect(def.requiresApproval).toBe(false)
  })

  it("re-exports plugin tool runtime types", () => {
    const assertTypes = <_T extends PluginToolDef | PluginTool | PluginToolContext>(): void =>
      undefined

    expect(assertTypes).toBeDefined()
  })
})
