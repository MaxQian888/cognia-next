import definition from "./index"
import { REFACTOR_ROLE_PACK } from "./characters/pack"
import { PLUGIN_ID } from "./ids"

function buildCtx() {
  const disposeNode = jest.fn()
  const registerNode = jest.fn(() => disposeNode)
  const registerPack = jest.fn()
  const refreshTemplateWarnings = jest.fn()
  return {
    ctx: {
      pluginId: PLUGIN_ID,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      workflow: {
        registerNode,
        registerTrigger: jest.fn(() => jest.fn()),
        refreshTemplateWarnings,
      },
      capabilities: { tauri: true },
      agent: { runCharacterTurn: jest.fn() },
      characterPacks: { register: registerPack },
    },
    registerNode,
    registerPack,
    disposeNode,
    refreshTemplateWarnings,
  }
}

afterEach(() => jest.clearAllMocks())

describe("backend-refactor plugin manifest", () => {
  it("declares all six capabilities and ships every contribution + i18n", () => {
    const m = definition.manifest as unknown as {
      id: string
      capabilities: string[]
      characterPacks?: unknown[]
      skills?: unknown[]
      subagents?: unknown[]
      agentTeamTemplates?: unknown[]
      workflowTemplates?: unknown[]
      i18n?: { locales: Record<string, Record<string, string>> }
    }
    expect(m.id).toBe(PLUGIN_ID)
    expect(m.capabilities).toEqual(
      expect.arrayContaining([
        "character-pack",
        "workflow",
        "skills",
        "subagent",
        "agent-team-template",
        "workflow-template",
      ])
    )
    expect(m.characterPacks).toHaveLength(1)
    expect(m.skills).toHaveLength(5)
    expect(m.subagents).toHaveLength(2)
    expect(m.agentTeamTemplates).toHaveLength(1)
    expect(m.workflowTemplates).toHaveLength(1)
    expect(m.i18n?.locales.en).toBeDefined()
    expect(m.i18n?.locales["zh-CN"]).toBeDefined()
  })
})

describe("backend-refactor activate/deactivate", () => {
  it("registers the role pack and the agent.turn node on activate", async () => {
    const { ctx, registerNode, registerPack, refreshTemplateWarnings } = buildCtx()
    await definition.activate?.(ctx as never)
    expect(registerPack).toHaveBeenCalledWith(REFACTOR_ROLE_PACK)
    expect(registerNode).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent.turn" }))
    expect(refreshTemplateWarnings).toHaveBeenCalledTimes(1)
  })

  it("disposes the node on deactivate", async () => {
    const { ctx, disposeNode } = buildCtx()
    await definition.activate?.(ctx as never)
    await definition.deactivate?.(ctx as never)
    expect(disposeNode).toHaveBeenCalledTimes(1)
  })
})
