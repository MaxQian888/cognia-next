import { createLegacyTemplateSources } from "./legacy-sources"
import type { FullDomainTemplatePorts } from "./adapters"

const crud = {
  create: async () => ({ id: "created" }),
  snapshot: async () => ({}),
}

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

describe("legacy template sources", () => {
  it("converts local AgentTeam Twin ids into portable role slots", async () => {
    const [source] = createLegacyTemplateSources({
      ports,
      readers: {
        agentTeams: () => [
          {
            id: "legacy-team",
            name: "Legacy team",
            description: "Portable",
            category: "general",
            config: { knowledgeTwinIds: ["private-team-twin"] },
            teammates: [
              {
                name: "Researcher",
                description: "Research",
                config: { twinId: "private-member-twin", model: "m" },
              },
            ],
          },
        ],
        subagents: () => [],
        customModes: () => [],
        workflows: () => [],
        characters: () => [],
        skills: () => [],
      },
    })

    const row = (await source.read())[0]
    const converted = await source.convert(row)
    const serialized = JSON.stringify(converted)

    expect(converted.inputs.map((slot) => slot.id)).toEqual(["team.knowledge.1", "teammate-1.twin"])
    expect(serialized).not.toContain("private-team-twin")
    expect(serialized).not.toContain("private-member-twin")
  })
})
