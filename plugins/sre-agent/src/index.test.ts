import type { PluginContext, PluginTool } from "@/types/plugin"
import { findPluginManifestParityIssues } from "@/lib/plugin/core/manifest-parity"
import packagedManifest from "../plugin.json"
import definition, { manifest } from "./index"

describe("sre-agent plugin entrypoint", () => {
  it("exposes the plugin manifest with tools and subagent contributions", () => {
    expect(manifest).toMatchObject({
      id: "sre-agent",
      capabilities: expect.arrayContaining(["tools", "subagent"]),
    })
    expect(manifest.subagents).toHaveLength(1)
    expect(manifest.tools).toHaveLength(4)
    expect(manifest.permissions).toEqual([])
    expect(findPluginManifestParityIssues(packagedManifest as never, manifest)).toEqual([])
  })

  it("registers all tools on activate", async () => {
    const tools: PluginTool[] = []
    await definition.activate?.({
      pluginId: "sre-agent",
      agent: { registerTool: (tool: PluginTool) => tools.push(tool) },
      logger: { info: jest.fn() },
    } as unknown as PluginContext)

    expect(tools.map((tool) => tool.name)).toEqual([
      "sre_query_logs",
      "sre_query_trace",
      "sre_query_metrics",
      "sre_validate_timeline",
    ])
    expect(tools.map((tool) => tool.definition)).toEqual(manifest.tools)
  })

  it("aborts tools from a previous activation when reactivated or deactivated", async () => {
    const firstTools: PluginTool[] = []
    await definition.activate?.({
      pluginId: "sre-agent",
      agent: { registerTool: (tool: PluginTool) => firstTools.push(tool) },
      logger: { info: jest.fn() },
    } as unknown as PluginContext)

    const secondTools: PluginTool[] = []
    await definition.activate?.({
      pluginId: "sre-agent",
      agent: { registerTool: (tool: PluginTool) => secondTools.push(tool) },
      logger: { info: jest.fn() },
    } as unknown as PluginContext)

    await expect(
      firstTools[0].execute(
        {
          environment: "prod",
          startTime: "2026-08-04T12:02:00.000Z",
          endTime: "2026-08-04T12:05:20.000Z",
        },
        { config: {} }
      )
    ).rejects.toThrow("sre tool execution aborted")

    await expect(
      secondTools[0].execute(
        {
          environment: "prod",
          startTime: "2026-08-04T12:02:00.000Z",
          endTime: "2026-08-04T12:05:20.000Z",
        },
        { config: {} }
      )
    ).resolves.toMatchObject({ ok: true })

    await definition.deactivate?.()
    await expect(
      secondTools[0].execute(
        {
          environment: "prod",
          startTime: "2026-08-04T12:02:00.000Z",
          endTime: "2026-08-04T12:05:20.000Z",
        },
        { config: {} }
      )
    ).rejects.toThrow("sre tool execution aborted")
  })
})
