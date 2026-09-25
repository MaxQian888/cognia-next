import type { PluginContext, PluginToolRegistration } from "@cognia/plugin-sdk"
import packagedManifest from "../plugin.json"
import definition, { manifest } from "./index"
import { PANEL_ACTIVITY, PANEL_ID } from "./ids"
import { clearSrePanelRuntime, peekSrePanelRuntime } from "./panel-runtime"

const WINDOW_ARGS = {
  environment: "prod",
  startTime: "2026-08-04T12:02:00.000Z",
  endTime: "2026-08-04T12:05:20.000Z",
}

function fakeContext(tools: PluginToolRegistration[] = []) {
  const register = jest.fn(() => () => {})
  const showConfirmDialog = jest.fn(async () => true)
  const error = jest.fn()
  const ctx = {
    pluginId: "sre-agent",
    agent: { registerTool: (tool: PluginToolRegistration) => tools.push(tool) },
    contextPanels: { register, setBadge: jest.fn(() => true) },
    ui: { showConfirmDialog },
    i18n: { t: (key: string) => (key === "panel.title" ? "SRE incidents" : key) },
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error },
  }
  return { ctx: ctx as unknown as PluginContext, register, showConfirmDialog, error }
}

describe("sre-agent plugin entrypoint", () => {
  afterEach(() => clearSrePanelRuntime())

  it("is plugin.json, with tools, subagent and panel contributions", () => {
    expect(manifest).toEqual(packagedManifest)
    expect(manifest).toMatchObject({
      id: "sre-agent",
      capabilities: expect.arrayContaining(["tools", "subagent", "context-panel"]),
    })
    expect(manifest.subagents).toHaveLength(1)
    expect(manifest.tools).toHaveLength(4)
    expect(manifest.permissions).toEqual(["extension:ui", "session:read"])
  })

  it("stays opt-in: a demo backend must not switch itself on for every user", () => {
    expect(manifest.activationEvents).toBeUndefined()
  })

  it("says 'demo corpus' in the manifest wherever the agent or a user reads it", () => {
    expect(manifest.description).toMatch(/demo corpus/i)
    for (const tool of manifest.tools ?? []) {
      if (tool.name === "sre_validate_timeline") continue
      expect(tool.description).toMatch(/^DEMO CORPUS ONLY/)
    }
    const [subagent] = manifest.subagents ?? []
    expect(subagent.description).toMatch(/demo corpus/i)
    expect(subagent.prompt).toContain("EVIDENCE SOURCE")
    expect(subagent.prompt).toMatch(/never present it as live production evidence/)
    expect(manifest.runtimeCompatibility?.browser?.reason).toMatch(/demo corpus/)
  })

  it("registers all tools on activate", async () => {
    const tools: PluginToolRegistration[] = []
    await definition.activate(fakeContext(tools).ctx)

    expect(tools.map((tool) => tool.name)).toEqual([
      "sre_query_logs",
      "sre_query_trace",
      "sre_query_metrics",
      "sre_validate_timeline",
    ])
    expect(tools.map((tool) => tool.definition)).toEqual(manifest.tools)
  })

  it("registers the panel with a localized label and parks confirm for it", async () => {
    const { ctx, register, showConfirmDialog } = fakeContext()
    await definition.activate(ctx)
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: PANEL_ID,
        activity: PANEL_ACTIVITY,
        label: "SRE incidents",
        labelKey: "plugin.sre-agent.panel.title",
      })
    )
    const bridge = peekSrePanelRuntime()
    await bridge?.confirm({ title: "t", message: "m" })
    expect(showConfirmDialog).toHaveBeenCalledWith({ title: "t", message: "m" })
  })

  it("keeps the tools when the panel registration is refused, and says so", async () => {
    const tools: PluginToolRegistration[] = []
    const { ctx, register, error } = fakeContext(tools)
    register.mockImplementation(() => {
      throw new Error("extension:ui not granted")
    })
    await definition.activate(ctx)
    expect(tools).toHaveLength(4)
    expect(error).toHaveBeenCalledWith(expect.stringContaining("extension:ui not granted"))
  })

  it("aborts tools from a previous activation when reactivated or deactivated", async () => {
    const firstTools: PluginToolRegistration[] = []
    await definition.activate(fakeContext(firstTools).ctx)

    const secondTools: PluginToolRegistration[] = []
    await definition.activate(fakeContext(secondTools).ctx)

    await expect(firstTools[0].execute(WINDOW_ARGS, { config: {} })).rejects.toThrow(
      "sre tool execution aborted"
    )
    await expect(secondTools[0].execute(WINDOW_ARGS, { config: {} })).resolves.toMatchObject({
      ok: true,
      dataSource: "demo-corpus",
    })

    await definition.deactivate?.({} as PluginContext)
    await expect(secondTools[0].execute(WINDOW_ARGS, { config: {} })).rejects.toThrow(
      "sre tool execution aborted"
    )
    expect(peekSrePanelRuntime()).toBeNull()
  })
})
