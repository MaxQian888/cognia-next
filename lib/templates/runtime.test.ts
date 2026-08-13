import { TemplateCatalog } from "./catalog"
import { InMemoryTemplateRepository, type StoredTemplatePackage } from "./repository"
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

  it("passes the trusted-publisher resolver into catalog hydration", async () => {
    const repository = new InMemoryTemplateRepository()
    const isPublisherTrusted = jest.fn(async () => true)
    await repository.putPackage({
      key: "pack.runtime@1.0.0",
      manifest: {
        id: "pack.runtime",
        version: "1.0.0",
        definitions: [],
        signature: {
          algorithm: "ed25519",
          publicKey: "publisher-public-key",
          signature: "signature",
        },
      } as StoredTemplatePackage["manifest"],
      fingerprint: "fingerprint",
      trust: "signed-unknown",
      importedAt: 1,
      source: "marketplace",
    })
    const runtime = createTemplateRuntime({
      repository,
      catalog: new TemplateCatalog(),
      ports: ports(),
      isPublisherTrusted,
    })

    await runtime.service.hydrateCatalog()

    expect(isPublisherTrusted).toHaveBeenCalledWith("publisher-public-key")
    expect((await repository.listPackages())[0].trust).toBe("verified-publisher")
  })
})
