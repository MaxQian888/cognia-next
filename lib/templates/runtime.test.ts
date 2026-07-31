import { TemplateCatalog } from "./catalog"
import { InMemoryTemplateRepository } from "./repository"
import { createTemplateRuntime } from "./runtime"
import type { FullDomainTemplatePorts } from "./adapters"

function ports(): FullDomainTemplatePorts {
  const crud = {
    create: async () => ({ id: "created" }),
    snapshot: async () => ({}),
  }
  return {
    agentTeam: {
      createTeam: async () => ({ id: "team" }),
      addTeammate: async () => ({ id: "teammate" }),
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
}

describe("template runtime", () => {
  it("wires all six domain adapters into one service and catalog", async () => {
    const catalog = new TemplateCatalog()
    const runtime = createTemplateRuntime({
      repository: new InMemoryTemplateRepository(),
      catalog,
      ports: ports(),
    })

    const draft = await runtime.service.createDraft({
      id: "skill.runtime",
      domain: "skill",
      metadata: { name: "Runtime skill" },
      payload: { name: "Runtime skill", content: "content" },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop"] },
    })

    expect(runtime.catalog.get(draft.id, null)).toEqual(draft)
  })
})
