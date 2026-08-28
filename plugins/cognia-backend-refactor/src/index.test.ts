import {
  registerCharacterPack,
  unregisterCharacterPacksByPlugin,
} from "@cognia/plugin-sdk/api/character-pack"
import definition from "./index"
import { REFACTOR_ROLE_PACK } from "./characters/pack"
import { AGENT_TURN_NODE } from "./nodes/agent-turn"
import { PLUGIN_ID } from "./ids"

// Doubled at the SDK subpath the plugin imports, not the host registry behind it.
jest.mock("@cognia/plugin-sdk/api/character-pack", () => ({
  registerCharacterPack: jest.fn(),
  unregisterCharacterPacksByPlugin: jest.fn(),
}))

const mockRegister = registerCharacterPack as jest.Mock
const mockUnregister = unregisterCharacterPacksByPlugin as jest.Mock

function buildCtx() {
  const disposeNode = jest.fn()
  const registerNode = jest.fn(() => disposeNode)
  return {
    ctx: {
      pluginId: PLUGIN_ID,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      workflow: { registerNode, registerTrigger: jest.fn(() => jest.fn()) },
    },
    registerNode,
    disposeNode,
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
    const { ctx, registerNode } = buildCtx()
    await definition.activate?.(ctx as never)
    expect(mockRegister).toHaveBeenCalledWith(REFACTOR_ROLE_PACK.id, REFACTOR_ROLE_PACK, {
      pluginId: PLUGIN_ID,
    })
    expect(registerNode).toHaveBeenCalledWith(AGENT_TURN_NODE)
  })

  it("disposes the node and drops the packs on deactivate", async () => {
    const { ctx, disposeNode } = buildCtx()
    await definition.activate?.(ctx as never)
    await definition.deactivate?.(ctx as never)
    expect(disposeNode).toHaveBeenCalledTimes(1)
    expect(mockUnregister).toHaveBeenCalledWith(PLUGIN_ID)
  })

  it("deactivate tolerates ctx without pluginId", async () => {
    await definition.deactivate?.(undefined as never)
    expect(mockUnregister).not.toHaveBeenCalled()
  })
})
