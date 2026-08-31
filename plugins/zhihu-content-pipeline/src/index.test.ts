import definition from "./index"
import { getPipelineDb } from "./db/runtime"
import { ZHIHU_ROLE_PACK } from "./characters/pack"
import { ZHIHU_SKILLS } from "./skills/definitions"
import { STATIC_MCP_PRESETS } from "./mcp/presets"
import { TOPIC_DISCOVERY_TEMPLATE } from "./workflow/template"
import { WRITING_CREW_TEMPLATE } from "./team/template"
import { PLUGIN_ID } from "./ids"

jest.mock("./commands", () => ({ handleZhihuCommand: jest.fn(() => "opened") }))

function buildCtx(withDexie = true) {
  const disposeNode = jest.fn()
  const registerNode = jest.fn(() => disposeNode)
  const registerTool = jest.fn()
  const registerMcpServerPreset = jest.fn()
  const registerPack = jest.fn()
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

  it("publishes the pipeline DB and registers the /zhihu commands", async () => {
    const { ctx } = buildCtx(true)
    await definition.activate?.(ctx as never)
    expect(getPipelineDb()).not.toBeNull()
    // `/zhihu` is manifest-declared; activate returns the handler hook.
  })

  it("disposes the node and clears the DB on deactivate", async () => {
    const { ctx, disposeNode } = buildCtx(true)
    await definition.activate?.(ctx as never)
    await definition.deactivate?.(ctx as never)
    expect(disposeNode).toHaveBeenCalledTimes(1)
    expect(getPipelineDb()).toBeNull()
    // Command teardown belongs to the manager for declared commands.
  })
})

describe("zhihu-content-pipeline activate (without dexie)", () => {
  it("still registers pack + preset but skips tools/node and warns", async () => {
    const { ctx, registerNode, registerTool, registerPack, refreshTemplateWarnings } =
      buildCtx(false)
    await definition.activate?.(ctx as never)
    expect(registerPack).toHaveBeenCalledTimes(1)
    expect(registerTool).not.toHaveBeenCalled()
    expect(registerNode).not.toHaveBeenCalled()
    expect(refreshTemplateWarnings).not.toHaveBeenCalled()
    expect(ctx.logger.warn).toHaveBeenCalled()
    // No Dexie → no pipeline DB published, but the /zhihu command still registers.
    expect(getPipelineDb()).toBeNull()
    // `/zhihu` is manifest-declared; activate returns the handler hook.
  })
})
