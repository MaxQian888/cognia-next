import type { PluginToolRegistration } from "@cognia/plugin-sdk"
import definition from "./index"
import { getPipelineDb } from "./db/runtime"
import { ZHIHU_ROLE_PACK } from "./characters/pack"
import { ZHIHU_SKILLS } from "./skills/definitions"
import { STATIC_MCP_PRESETS } from "./mcp/presets"
import { TOPIC_DISCOVERY_TEMPLATE } from "./workflow/template"
import { WRITING_CREW_TEMPLATE } from "./team/template"
import { handleZhihuCommand } from "./commands"
import { PLUGIN_ID } from "./ids"

const mockHandleZhihuCommand = handleZhihuCommand as jest.Mock

jest.mock("./commands", () => ({
  handleZhihuCommand: jest.fn(() => ({ handled: true, message: "opened" })),
}))

function buildCtx(withDexie = true) {
  const disposeNode = jest.fn()
  const registerNode = jest.fn(() => disposeNode)
  const toolDisposers: jest.Mock[] = []
  const registerTool = jest.fn((_tool: PluginToolRegistration) => {
    const d = jest.fn()
    toolDisposers.push(d)
    return d
  })
  const registerMcpServerPreset = jest.fn()
  const unregisterPack = jest.fn()
  const registerPack = jest.fn(() => ({ packId: "zhihu-roles", unregister: unregisterPack }))
  const refreshTemplateWarnings = jest.fn()
  const table = jest.fn(() => ({}))
  return {
    ctx: {
      pluginId: PLUGIN_ID,
      pluginPath: "/plugins/zhihu-content-pipeline",
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      agent: { registerMcpServerPreset, registerTool },
      session: { startSeededSession: jest.fn() },
      characterPacks: { register: registerPack },
      workflow: {
        registerNode,
        registerTrigger: jest.fn(() => jest.fn()),
        refreshTemplateWarnings,
      },
      dexie: withDexie ? { table, rawDb: jest.fn() } : undefined,
    },
    registerNode,
    registerTool,
    registerMcpServerPreset,
    registerPack,
    disposeNode,
    toolDisposers,
    unregisterPack,
    refreshTemplateWarnings,
  }
}

afterEach(() => jest.clearAllMocks())

describe("zhihu-content-pipeline manifest", () => {
  it("declares all Phase-2 capabilities and ships every contribution + dexie + i18n", () => {
    const m = definition.manifest as unknown as {
      id: string
      capabilities: string[]
      characterPacks?: unknown[]
      skills?: unknown[]
      mcpServerPresets?: unknown[]
      workflowTemplates?: unknown[]
      agentTeamTemplates?: unknown[]
      tools?: Array<{ name: string; access?: string }>
      permissions?: string[]
      requires?: { binaries?: Array<{ name: string }> }
      dexie?: { tables: Array<{ name: string }> }
      i18n?: { locales: Record<string, Record<string, string>> }
    }
    expect(m.id).toBe(PLUGIN_ID)
    expect(m.capabilities).toEqual(
      expect.arrayContaining([
        "character-pack",
        "skills",
        "mcp-server-preset",
        "tools",
        "workflow",
        "workflow-template",
        "agent-team-template",
        "commands",
      ])
    )
    expect(m.characterPacks).toEqual([ZHIHU_ROLE_PACK])
    expect(m.skills).toBe(ZHIHU_SKILLS)
    expect(m.mcpServerPresets).toBe(STATIC_MCP_PRESETS)
    expect(m.workflowTemplates).toEqual([TOPIC_DISCOVERY_TEMPLATE])
    expect(m.agentTeamTemplates).toEqual([WRITING_CREW_TEMPLATE])
    expect(m.dexie?.tables.map((x) => x.name)).toEqual(["topics", "research", "drafts"])
    expect(m.i18n?.locales.en).toBeDefined()
    expect(m.i18n?.locales["zh-CN"]).toBeDefined()
  })

  it("declares the two persistence tools + the zget binary on plugin.json fields", () => {
    const m = definition.manifest as unknown as {
      tools?: Array<{ name: string; access?: string }>
      permissions?: string[]
      permissionJustifications?: Record<string, string>
      requires?: { binaries?: Array<{ name: string; documentation?: string }> }
    }
    expect(m.tools?.map((t) => t.name)).toEqual(["zhihu_save_research", "zhihu_save_draft"])
    for (const t of m.tools ?? []) expect(t.access).toBe("write")
    // Every declared permission carries a consent-screen justification.
    expect(Object.keys(m.permissionJustifications ?? {}).sort()).toEqual(
      [...(m.permissions ?? [])].sort()
    )
    // The daily workflow's terminal node shells out to `zget`.
    expect(m.requires?.binaries?.map((b) => b.name)).toEqual(["zget"])
  })
})

describe("zhihu-content-pipeline activate (with dexie)", () => {
  it("registers pack, persist tools, and the save-topics node (presets ride the manifest)", async () => {
    const {
      ctx,
      registerNode,
      registerTool,
      registerMcpServerPreset,
      registerPack,
      refreshTemplateWarnings,
    } = buildCtx(true)
    await definition.activate?.(ctx as never)
    expect(registerPack).toHaveBeenCalledWith(ZHIHU_ROLE_PACK)
    // MCP presets are declarative now (no broken zget wrapper) → no imperative registration.
    expect(registerMcpServerPreset).not.toHaveBeenCalled()
    expect(registerTool).toHaveBeenCalledTimes(2)
    expect(registerTool.mock.calls.map((c) => c[0].name)).toEqual([
      "zhihu_save_research",
      "zhihu_save_draft",
    ])
    expect(registerNode).toHaveBeenCalledTimes(1)
    expect(refreshTemplateWarnings).toHaveBeenCalledTimes(1)
  })

  it("publishes the pipeline DB and returns the /zhihu command hook", async () => {
    const { ctx } = buildCtx(true)
    const hooks = (await definition.activate?.(ctx as never)) as {
      onCommand: (command: string) => unknown
    }
    expect(getPipelineDb()).not.toBeNull()
    // The hook delegates to handleZhihuCommand and surfaces its result.
    await expect(hooks.onCommand("zhihu")).resolves.toEqual({
      handled: true,
      message: "opened",
    })
    expect(mockHandleZhihuCommand).toHaveBeenCalledWith(ctx, "zhihu")
    // A decline (null from the handler) maps to false so the host keeps dispatching.
    mockHandleZhihuCommand.mockReturnValueOnce(null)
    await expect(hooks.onCommand("not-mine")).resolves.toBe(false)
  })

  it("releases every imperative registration and clears the DB on deactivate", async () => {
    const { ctx, disposeNode, toolDisposers, unregisterPack } = buildCtx(true)
    await definition.activate?.(ctx as never)
    await definition.deactivate?.(ctx as never)
    // pack unregister + 2 tool disposers + 1 node disposer — all released.
    expect(unregisterPack).toHaveBeenCalledTimes(1)
    expect(toolDisposers).toHaveLength(2)
    for (const d of toolDisposers) expect(d).toHaveBeenCalledTimes(1)
    expect(disposeNode).toHaveBeenCalledTimes(1)
    expect(getPipelineDb()).toBeNull()
    // Command teardown belongs to the manager for declared commands.
  })

  it("disposes the previous registrations on re-activate (hot-reload safe)", async () => {
    const { ctx, registerNode, disposeNode, toolDisposers, unregisterPack } = buildCtx(true)
    await definition.activate?.(ctx as never)
    await definition.activate?.(ctx as never)
    // Second activation released the first round of registrations before
    // registering replacements, rather than leaking them.
    expect(unregisterPack).toHaveBeenCalledTimes(1)
    expect(disposeNode).toHaveBeenCalledTimes(1)
    expect(toolDisposers.slice(0, 2).every((d) => d.mock.calls.length === 1)).toBe(true)
    expect(toolDisposers).toHaveLength(4)
    expect(registerNode).toHaveBeenCalledTimes(2)
    await definition.deactivate?.(ctx as never)
    expect(disposeNode).toHaveBeenCalledTimes(2)
    expect(unregisterPack).toHaveBeenCalledTimes(2)
  })
})

describe("zhihu-content-pipeline activate (without dexie)", () => {
  it("still registers the pack but skips tools/node and warns", async () => {
    const { ctx, registerNode, registerTool, registerPack, refreshTemplateWarnings } =
      buildCtx(false)
    await definition.activate?.(ctx as never)
    expect(registerPack).toHaveBeenCalledTimes(1)
    expect(registerTool).not.toHaveBeenCalled()
    expect(registerNode).not.toHaveBeenCalled()
    expect(refreshTemplateWarnings).not.toHaveBeenCalled()
    expect(ctx.logger.warn).toHaveBeenCalled()
    // No Dexie → no pipeline DB published, but the /zhihu hook is still returned.
    expect(getPipelineDb()).toBeNull()
  })
})
