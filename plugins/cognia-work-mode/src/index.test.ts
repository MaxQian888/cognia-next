import type { PluginContext, PluginTool } from "@cognia/plugin-sdk"
import type { PluginDispatchSubagentOptions } from "@cognia/plugin-sdk"
import workModePlugin, { manifest } from "./index"

describe("cognia-work-mode plugin", () => {
  it("publishes the complete SDK-native capability bundle", () => {
    expect(manifest.id).toBe("cognia-work-mode")
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining(["tools", "modes", "skills", "subagent", "agent-team-template"])
    )
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(["artifact:read", "artifact:write", "agent:dispatch"])
    )
    expect(manifest.modes).toHaveLength(1)
    expect(manifest.skills).toHaveLength(5)
    expect(manifest.subagents).toHaveLength(3)
    expect(manifest.agentTeamTemplates).toHaveLength(1)
  })

  it("registers four model-facing tools through ctx.agent", async () => {
    const tools: PluginTool[] = []
    const info = jest.fn()
    const ctx = {
      pluginId: "cognia-work-mode",
      agent: { registerTool: (tool: PluginTool) => tools.push(tool) },
      artifact: {},
      logger: { info },
    } as unknown as PluginContext

    await workModePlugin.activate?.(ctx)

    expect(tools.map((tool) => tool.name)).toEqual([
      "work_create_deliverable",
      "work_update_deliverable",
      "work_review_deliverable",
      "work_parallelize",
    ])
    expect(new Set(tools.map((tool) => tool.pluginId))).toEqual(new Set(["cognia-work-mode"]))
    for (const tool of tools) {
      expect(tool.definition.parametersSchema).toMatchObject({ type: "object" })
    }
    expect(info).toHaveBeenCalledWith("work-mode plugin activated")
  })

  it("aborts in-flight specialist work when the plugin deactivates", async () => {
    const tools: PluginTool[] = []
    const dispatchSubagent = jest.fn(
      async (_id: string, _prompt: string, _options?: PluginDispatchSubagentOptions) => ({
        text: "PASS",
        channel: "text" as const,
        toolsAvailable: false,
        runId: "review-run",
      })
    )
    const ctx = {
      pluginId: "cognia-work-mode",
      agent: {
        registerTool: (tool: PluginTool) => tools.push(tool),
        dispatchSubagent,
      },
      artifact: {
        getArtifact: () => ({
          id: "artifact-1",
          sessionId: "session-1",
          messageId: "message-1",
          type: "document",
          title: "Draft",
          content: "Safe draft",
        }),
        createArtifact: async () => "review-1",
        openArtifact: jest.fn(),
      },
      logger: { info: jest.fn() },
    } as unknown as PluginContext
    await workModePlugin.activate(ctx)

    const reviewTool = tools.find((tool) => tool.name === "work_review_deliverable")!
    const run = reviewTool.execute({ artifactId: "artifact-1" }, { config: {} })
    const signal = dispatchSubagent.mock.calls[0][2]?.abortSignal as AbortSignal
    expect(signal.aborted).toBe(false)

    await workModePlugin.deactivate?.(ctx)
    expect(signal.aborted).toBe(true)
    await run
  })
})
