import { definePluginTool } from "./define-plugin-tool"

describe("definePluginTool", () => {
  it("returns a runtime tool without requiring pluginId", async () => {
    const tool = {
      name: "summarize",
      definition: {
        name: "summarize",
        description: "Summarize input text.",
        parametersSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      execute: async (args: Record<string, unknown>) => args.text,
    }

    expect(definePluginTool(tool)).toBe(tool)
    await expect(tool.execute({ text: "hello" })).resolves.toBe("hello")
  })

  it("keeps legacy pluginId metadata for source compatibility", () => {
    const tool = {
      name: "legacy",
      pluginId: "untrusted-author-value",
      definition: {
        name: "legacy",
        description: "Legacy registration.",
        parametersSchema: { type: "object", properties: {} },
      },
      execute: async () => null,
    }

    expect(definePluginTool(tool)).toBe(tool)
  })
})
