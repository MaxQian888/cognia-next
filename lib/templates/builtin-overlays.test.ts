import { TemplateCatalog } from "./catalog"
import { refreshBuiltInTemplateOverlays } from "./builtin-overlays"
import type { FullDomainTemplatePorts } from "./adapters"

jest.mock("@/types/agent/agent-team", () => ({
  BUILT_IN_TEAM_TEMPLATES: [
    {
      id: "team",
      name: "Team",
      description: "Team",
      category: "general",
      teammates: [],
      isBuiltIn: true,
    },
  ],
}))
jest.mock("@/types/agent/sub-agent", () => ({
  BUILT_IN_SUBAGENT_TEMPLATES: [],
}))
jest.mock("@/stores/agent/custom-mode-store", () => ({ MODE_TEMPLATES: [] }))
jest.mock("@/lib/db/workflows", () => ({ listTemplateWorkflows: async () => [] }))
jest.mock("@/lib/db/characters", () => ({ listCharacters: async () => [] }))
jest.mock("@/lib/db/skills", () => ({ listSkills: async () => [] }))

const crud = { create: async () => ({ id: "x" }), snapshot: async () => ({}) }
const ports: FullDomainTemplatePorts = {
  agentTeam: {
    createTeam: async () => ({ id: "team" }),
    addTeammate: async () => ({ id: "member" }),
    createTask: async () => ({ id: "task" }),
    deleteTeam: async () => undefined,
    snapshot: async () => ({}),
  },
  workflow: crud,
  subagent: crud,
  customMode: crud,
  character: crud,
  skill: crud,
}

describe("built-in template overlays", () => {
  it("keeps built-ins immutable and out of user Dexie definitions", async () => {
    const catalog = new TemplateCatalog()
    expect(await refreshBuiltInTemplateOverlays({ catalog, ports })).toBe(1)
    expect(catalog.get("builtin.agent-team.team", "1.0.0")).toMatchObject({
      status: "published",
      provenance: { source: "built-in", trust: "built-in" },
    })
  })
})
