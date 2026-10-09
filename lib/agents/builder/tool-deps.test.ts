jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
jest.mock("@/lib/db/skills", () => ({ listSkills: jest.fn() }))
jest.mock("@/lib/db/mcp-servers", () => ({ listMcpServers: jest.fn() }))
jest.mock("@/lib/db/knowledge-bases", () => ({ listKnowledgeBases: jest.fn() }))
jest.mock("@/lib/plugin/registries/skill-registry", () => ({
  ...jest.requireActual("@/lib/plugin/registries/skill-registry"),
  listSkillEntries: jest.fn(),
}))
jest.mock("@/lib/claude/model-presets", () => ({ modelPresetOptions: jest.fn() }))
jest.mock("./builder-session", () => ({
  writeBuilderDraft: jest.fn(),
  createAgentFromBuilder: jest.fn(),
}))

import type { AgentBuilderDraft, AgentBuilderSessionState } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import { listSkills } from "@/lib/db/skills"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { listKnowledgeBases } from "@/lib/db/knowledge-bases"
import { listSkillEntries } from "@/lib/plugin/registries/skill-registry"
import { modelPresetOptions } from "@/lib/claude/model-presets"
import { createAgentFromBuilder, writeBuilderDraft } from "./builder-session"
import type { DraftCatalogs } from "./draft-ops"
import { resolveAgentBuilderToolDeps } from "./tool-deps"

const getDbMock = getDb as jest.Mock
const listSkillsMock = listSkills as jest.Mock
const listMcpMock = listMcpServers as jest.Mock
const listKbMock = listKnowledgeBases as jest.Mock
const listEntriesMock = listSkillEntries as jest.Mock
const writeMock = writeBuilderDraft as jest.Mock

const CATALOGS: DraftCatalogs = {
  skills: [{ id: "sk-1", name: "Review" }],
  pluginSkills: [],
  mcpServers: [],
  knowledgeBases: [],
}

function stateWith(draft: AgentBuilderDraft): AgentBuilderSessionState {
  return { draft, revision: 2, editedBy: "agent", status: "drafting", updatedAt: 1 }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("resolveAgentBuilderToolDeps", () => {
  it("reads a session from the sessions table", async () => {
    const get = jest.fn(async (id: string) => ({ id }))
    getDbMock.mockReturnValue({ sessions: { get } })
    expect(await resolveAgentBuilderToolDeps().getSession("s1")).toEqual({ id: "s1" })
    expect(get).toHaveBeenCalledWith("s1")
  })

  it("projects every catalog to the fields the builder may see", async () => {
    listSkillsMock.mockResolvedValue([
      {
        id: "sk-1",
        name: "Review",
        description: "Reviews diffs",
        content: "secret body",
        tags: ["x"],
      },
    ])
    listMcpMock.mockResolvedValue([
      {
        id: "m1",
        name: "GitHub",
        enabled: false,
        transport: "stdio",
        command: "gh",
        env: { TOKEN: "t" },
      },
    ])
    listKbMock.mockResolvedValue([
      { id: "kb1", name: "Docs", description: "Handbook", documents: [1, 2] },
    ])
    listEntriesMock.mockReturnValue([
      { id: "p:zeta", entry: { name: "Zeta", description: "z", scope: "global" }, pluginId: "p" },
      { id: "p:team", entry: { name: "Team only", scope: "team" }, pluginId: "p" },
      { id: "p:alpha", entry: { name: "", description: "", scope: "character" }, pluginId: "p" },
    ])

    const catalogs = await resolveAgentBuilderToolDeps().catalogs()

    expect(catalogs).toEqual({
      skills: [{ id: "sk-1", name: "Review", description: "Reviews diffs" }],
      pluginSkills: [
        { id: "p:alpha", name: "p:alpha", description: undefined, pluginId: "p" },
        { id: "p:zeta", name: "Zeta", description: "z", pluginId: "p" },
      ],
      mcpServers: [{ id: "m1", name: "GitHub", enabled: false, transport: "stdio" }],
      knowledgeBases: [{ id: "kb1", name: "Docs", description: "Handbook" }],
    })
  })

  it("propagates a catalog read failure", async () => {
    listSkillsMock.mockRejectedValue(new Error("db closed"))
    listMcpMock.mockResolvedValue([])
    listKbMock.mockResolvedValue([])
    listEntriesMock.mockReturnValue([])
    await expect(resolveAgentBuilderToolDeps().catalogs()).rejects.toThrow("db closed")
  })

  it("uses the model preset list as the model source", () => {
    const deps = resolveAgentBuilderToolDeps()
    expect(deps.models).toBe(modelPresetOptions)
  })

  it("creates the agent through the builder session", () => {
    expect(resolveAgentBuilderToolDeps().createAgent).toBe(createAgentFromBuilder)
  })

  it("writes the patch as the agent and reports changed and rejected fields", async () => {
    let written: AgentBuilderDraft | undefined
    writeMock.mockImplementation(
      async (_id: string, update: (draft: AgentBuilderDraft) => AgentBuilderDraft) => {
        written = update({ name: "Old", skillIds: ["sk-1"] })
        return stateWith(written)
      }
    )

    const result = await resolveAgentBuilderToolDeps().writeDraft(
      "b1",
      { name: "New", skill_ids: ["sk-missing"] },
      CATALOGS
    )

    expect(writeMock).toHaveBeenCalledWith("b1", expect.any(Function), "agent")
    expect(written).toEqual({ name: "New", skillIds: ["sk-1"] })
    expect(result.state).toEqual(stateWith({ name: "New", skillIds: ["sk-1"] }))
    expect(result.changed).toEqual(["name"])
    expect(result.rejected).toEqual([
      {
        field: "skill_ids",
        reason: "unknown id(s): sk-missing. Call agent_builder_list_catalog for the valid ids.",
      },
    ])
  })

  it("reports no changes when the writer never ran the update", async () => {
    writeMock.mockResolvedValue(stateWith({}))
    const result = await resolveAgentBuilderToolDeps().writeDraft("b1", { name: "X" }, CATALOGS)
    expect(result).toEqual({ state: stateWith({}), changed: [], rejected: [] })
  })

  it("propagates a refused write", async () => {
    writeMock.mockRejectedValue(new Error("This draft was already created as an agent."))
    await expect(
      resolveAgentBuilderToolDeps().writeDraft("b1", { name: "X" }, CATALOGS)
    ).rejects.toThrow("already created")
  })
})
