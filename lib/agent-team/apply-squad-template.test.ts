import { TemplateCatalog } from "@/lib/templates/catalog"
import { createTemplateDefinition } from "@/lib/templates/contracts"
import type { TemplateRuntime } from "@/lib/templates/runtime"
import type { AgentTeamTemplate } from "@/types/agent/agent-team"

import { SquadTemplateBlockedError, applySquadTemplate } from "./apply-squad-template"

const template: AgentTeamTemplate = {
  id: "user-1",
  name: "Mine",
  description: "A squad",
  category: "general",
  teammates: [{ name: "Helper", description: "" }],
  isBuiltIn: false,
}

function storeActions() {
  const createTeam = jest.fn(() => ({ id: "legacy-team" }))
  const addTeammate = jest.fn(() => ({ id: "legacy-mate" }))
  const createTask = jest.fn(() => ({ id: "legacy-task" }))
  return {
    calls: { createTeam, addTeammate, createTask },
    actions: {
      createTeam,
      addTeammate,
      createTask,
    } as unknown as Parameters<typeof applySquadTemplate>[0]["actions"],
  }
}

async function catalogWithDraft() {
  const catalog = new TemplateCatalog()
  catalog.replaceSource("user", [
    await createTemplateDefinition({
      id: "legacy.agentTeam.user-1",
      domain: "agentTeam",
      status: "draft",
      revision: 1,
      version: null,
      metadata: { name: "Mine" },
      payload: { team: { name: "Mine" } },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop", "web", "mobile"] },
      provenance: { source: "user", trust: "unsigned" },
    }),
  ])
  return catalog
}

function runtimeWith(overrides: {
  preflight?: jest.Mock
  instantiate?: jest.Mock
}): TemplateRuntime {
  return {
    catalog: new TemplateCatalog(),
    repository: {} as TemplateRuntime["repository"],
    service: {
      preflight: overrides.preflight ?? jest.fn(),
      instantiate: overrides.instantiate ?? jest.fn(),
    } as unknown as TemplateRuntime["service"],
  }
}

describe("applySquadTemplate", () => {
  it("preflights and instantiates through the platform, returning the created squad", async () => {
    const preflight = jest.fn(async () => ({ status: "ready", issues: [] }))
    const instantiate = jest.fn(async () => ({
      resources: [{ domain: "agentTeam", id: "team-42" }],
      rollbackToken: null,
    }))
    const { actions, calls } = storeActions()

    const result = await applySquadTemplate({
      template,
      platform: "desktop",
      actions,
      runtime: runtimeWith({ preflight, instantiate }),
      catalog: await catalogWithDraft(),
      platformEnabled: () => true,
    })

    expect(result).toEqual({ teamId: "team-42", via: "platform" })
    expect(preflight).toHaveBeenCalledWith({
      definitionId: "legacy.agentTeam.user-1",
      platform: "desktop",
      bindings: {},
    })
    expect(instantiate).toHaveBeenCalledWith({
      plan: { status: "ready", issues: [] },
      confirmed: true,
    })
    // The adapter's port owns the writes. Calling the store here as well would
    // create the squad twice.
    expect(calls.createTeam).not.toHaveBeenCalled()
  })

  it("names the version when the definition is a release", async () => {
    const catalog = new TemplateCatalog()
    catalog.replaceSource("built-in", [
      await createTemplateDefinition({
        id: "builtin.agentTeam.parallel-review",
        domain: "agentTeam",
        status: "published",
        revision: 1,
        version: "1.0.0",
        metadata: { name: "Parallel review" },
        payload: { team: { name: "Parallel review" } },
        inputs: [],
        dependencies: [],
        capabilities: [],
        compatibility: { platforms: ["desktop", "web", "mobile"] },
        provenance: { source: "built-in", trust: "built-in" },
      }),
    ])
    const preflight = jest.fn(async () => ({ status: "ready", issues: [] }))
    const instantiate = jest.fn(async () => ({
      resources: [{ domain: "agentTeam", id: "team-7" }],
      rollbackToken: null,
    }))
    const { actions } = storeActions()

    await applySquadTemplate({
      template: { ...template, id: "parallel-review", isBuiltIn: true },
      platform: "web",
      actions,
      runtime: runtimeWith({ preflight, instantiate }),
      catalog,
      platformEnabled: () => true,
    })

    expect(preflight).toHaveBeenCalledWith(
      expect.objectContaining({
        definitionId: "builtin.agentTeam.parallel-review",
        version: "1.0.0",
      })
    )
  })

  it("raises the preflight issues rather than instantiating a blocked plan", async () => {
    const preflight = jest.fn(async () => ({
      status: "blocked",
      issues: [{ code: "dependency.required-missing", message: "Required dependency x" }],
    }))
    const instantiate = jest.fn()
    const { actions } = storeActions()

    await expect(
      applySquadTemplate({
        template,
        platform: "desktop",
        actions,
        runtime: runtimeWith({ preflight, instantiate }),
        catalog: await catalogWithDraft(),
        platformEnabled: () => true,
      })
    ).rejects.toBeInstanceOf(SquadTemplateBlockedError)
    expect(instantiate).not.toHaveBeenCalled()
  })

  it("falls back to the direct writer when the platform is switched off", async () => {
    const preflight = jest.fn()
    const { actions, calls } = storeActions()

    const result = await applySquadTemplate({
      template,
      platform: "desktop",
      actions,
      runtime: runtimeWith({ preflight }),
      catalog: await catalogWithDraft(),
      platformEnabled: () => false,
    })

    expect(result).toEqual({ teamId: "legacy-team", via: "legacy" })
    expect(preflight).not.toHaveBeenCalled()
    expect(calls.addTeammate).toHaveBeenCalledTimes(1)
  })

  it("falls back to the direct writer when the catalog does not hold the definition", async () => {
    const preflight = jest.fn()
    const { actions, calls } = storeActions()

    const result = await applySquadTemplate({
      template,
      platform: "desktop",
      actions,
      runtime: runtimeWith({ preflight }),
      catalog: new TemplateCatalog(),
      platformEnabled: () => true,
    })

    expect(result).toEqual({ teamId: "legacy-team", via: "legacy" })
    expect(preflight).not.toHaveBeenCalled()
    expect(calls.createTeam).toHaveBeenCalledTimes(1)
  })

  it("refuses an instantiation that produced no squad resource", async () => {
    const preflight = jest.fn(async () => ({ status: "ready", issues: [] }))
    const instantiate = jest.fn(async () => ({ resources: [], rollbackToken: null }))
    const { actions } = storeActions()

    await expect(
      applySquadTemplate({
        template,
        platform: "desktop",
        actions,
        runtime: runtimeWith({ preflight, instantiate }),
        catalog: await catalogWithDraft(),
        platformEnabled: () => true,
      })
    ).rejects.toThrow(/no squad/)
  })
})
