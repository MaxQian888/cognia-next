import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { PluginDispatchSubagentOptions, PluginToolRegistration } from "@cognia/plugin-sdk"
import { createTestPluginContext } from "@cognia/plugin-sdk/testing"

import workModePlugin, { manifest } from "./index"
import manifestJson from "../plugin.json"

describe("cognia-work-mode plugin", () => {
  it("publishes the complete SDK-native capability bundle", () => {
    expect(manifest.id).toBe("cognia-work-mode")
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining(["tools", "modes", "skills", "subagent", "agent-team-template"])
    )
    // agent:control is what `invokeDependencyTool` (spreadsheets → cognia-office) needs.
    expect(manifest.permissions).toEqual([
      "artifact:read",
      "artifact:write",
      "agent:dispatch",
      "agent:control",
    ])
    expect(manifest.modes).toHaveLength(1)
    expect(manifest.skills).toHaveLength(5)
    expect(manifest.subagents).toHaveLength(3)
    expect(manifest.agentTeamTemplates).toHaveLength(1)
  })

  it("spreads plugin.json instead of restating it", () => {
    expect(manifest.dependencies).toEqual(manifestJson.dependencies)
    expect(manifest.i18n).toEqual(manifestJson.i18n)
    expect(manifest.runtimeCompatibility).toEqual(manifestJson.runtimeCompatibility)
  })

  it("registers four model-facing tools through ctx.agent, owned by the host", async () => {
    const tools: PluginToolRegistration[] = []
    const { ctx } = createTestPluginContext({
      pluginId: "cognia-work-mode",
      overrides: { agent: { registerTool: (tool: PluginToolRegistration) => tools.push(tool) } },
    })

    await workModePlugin.activate(ctx)

    expect(tools.map((tool) => tool.name)).toEqual([
      "work_create_deliverable",
      "work_update_deliverable",
      "work_review_deliverable",
      "work_parallelize",
    ])
    for (const tool of tools) {
      expect(Object.hasOwn(tool, "pluginId")).toBe(false)
      expect(tool.definition.parametersSchema).toMatchObject({ type: "object" })
    }
  })

  it("aborts in-flight specialist work when the activation's lifecycle ends", async () => {
    const tools: PluginToolRegistration[] = []
    const dispatchSubagent = jest.fn(
      async (_id: string, _prompt: string, _options?: PluginDispatchSubagentOptions) => ({
        text: "PASS",
        channel: "text" as const,
        toolsAvailable: false,
        runId: "review-run",
      })
    )
    const lifecycle = new AbortController()
    const { ctx } = createTestPluginContext({
      pluginId: "cognia-work-mode",
      overrides: {
        agent: {
          registerTool: (tool: PluginToolRegistration) => tools.push(tool),
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
        lifecycle: { signal: lifecycle.signal, onDispose: jest.fn() },
      },
    })
    await workModePlugin.activate(ctx)

    const reviewTool = tools.find((tool) => tool.name === "work_review_deliverable")!
    const run = reviewTool.execute({ artifactId: "artifact-1" }, { config: {} })
    const signal = dispatchSubagent.mock.calls[0][2]?.abortSignal as AbortSignal
    expect(signal.aborted).toBe(false)

    lifecycle.abort()
    expect(signal.aborted).toBe(true)
    await run
  })

  it("keeps the README truthful about permissions and spreadsheets", () => {
    const readme = readFileSync(join(__dirname, "..", "README.md"), "utf8")
    expect(readme).toContain("agent:control")
    expect(readme).toMatch(/cognia-office/)
    expect(readme).not.toMatch(/spreadsheets as CSV-compatible text/)
  })
})
