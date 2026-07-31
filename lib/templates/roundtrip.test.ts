import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"
import { createFullDomainAdapters, type FullDomainTemplatePorts } from "./adapters"
import { TemplateCatalog } from "./catalog"
import type { TemplateDomain, TemplateJson } from "./contracts"
import { InMemoryTemplateRepository } from "./repository"
import { TemplateService } from "./service"

function createPorts(created: Array<{ domain: TemplateDomain; payload: TemplateJson }>) {
  let counter = 0
  const crud = (domain: Exclude<TemplateDomain, "agentTeam">) => ({
    create: async (payload: TemplateJson) => {
      created.push({ domain, payload })
      counter += 1
      return { id: `${domain}-${counter}` }
    },
    snapshot: async () => ({ domain, snapshot: true }),
  })
  return {
    agentTeam: {
      createTeam: async (payload: Record<string, unknown>) => {
        created.push({ domain: "agentTeam", payload: payload as TemplateJson })
        counter += 1
        return { id: `agentTeam-${counter}`, leadId: `lead-${counter}` }
      },
      addTeammate: async () => {
        counter += 1
        return { id: `teammate-${counter}` }
      },
      createTask: async () => {
        counter += 1
        return { id: `task-${counter}` }
      },
      deleteTeam: async () => undefined,
      updateTeammate: async () => undefined,
      snapshot: async () => ({ domain: "agentTeam", snapshot: true }),
    },
    workflow: crud("workflow"),
    subagent: crud("subagent"),
    customMode: crud("customMode"),
    character: crud("character"),
    skill: crud("skill"),
  } satisfies FullDomainTemplatePorts
}

function agentTeamResource() {
  const team = {
    id: "local-team",
    name: "Portable team",
    description: "Round-trip team",
    task: "Review",
    leadId: "local-lead",
    teammateIds: ["local-lead", "local-worker"],
    taskIds: ["local-task"],
    config: { knowledgeTwinIds: ["private-twin"], executionMode: "coordinated" },
  } as unknown as AgentTeam
  const teammates = [
    {
      id: "local-lead",
      teamId: team.id,
      name: "Lead",
      description: "Coordinates",
      role: "lead",
      config: { twinId: "private-lead-twin", systemPrompt: "Coordinate" },
    },
    {
      id: "local-worker",
      teamId: team.id,
      name: "Worker",
      description: "Reviews",
      role: "teammate",
      config: { twinId: "private-worker-twin", systemPrompt: "Review" },
    },
  ] as unknown as AgentTeammate[]
  const tasks = [
    {
      id: "local-task",
      teamId: team.id,
      title: "Review",
      description: "Review changes",
      priority: "normal",
      assignedTo: "local-worker",
      dependencies: [],
      tags: [],
      order: 0,
    },
  ] as unknown as AgentTeamTask[]
  return { team, teammates, tasks }
}

describe("full template domain round trips", () => {
  it("projects, releases, packages, imports, and instantiates all six domains", async () => {
    const sourceCreated: Array<{ domain: TemplateDomain; payload: TemplateJson }> = []
    const sourceAdapters = createFullDomainAdapters(createPorts(sourceCreated))
    const sourceRepository = new InMemoryTemplateRepository()
    const sourceService = new TemplateService({
      repository: sourceRepository,
      catalog: new TemplateCatalog(),
      adapters: sourceAdapters,
    })
    const resources: Record<TemplateDomain, unknown> = {
      agentTeam: agentTeamResource(),
      workflow: {
        id: "local-workflow",
        name: "Workflow",
        nodes: [{ id: "schedule", type: "trigger.schedule", data: { params: { enabled: true } } }],
        edges: [],
      },
      subagent: {
        id: "local-subagent",
        name: "Subagent",
        taskTemplate: "Review",
        config: { model: "provider/model", tools: ["Read"] },
      },
      customMode: {
        id: "local-mode",
        name: "Custom mode",
        systemPrompt: "Be precise",
        tools: ["Read"],
      },
      character: {
        id: "local-character",
        name: "Character",
        systemPrompt: "Be helpful",
        twinId: "private-character-twin",
      },
      skill: {
        id: "local-skill",
        name: "Skill",
        content: "Portable instructions",
        localPath: "/private/path",
      },
      a2ui: {},
      goal: {},
      scheduler: {},
      prompt: {},
      subscription: {},
      document: {},
    }
    const releases = []
    for (const adapter of sourceAdapters) {
      const payload = await adapter.project(resources[adapter.domain])
      const draft = await sourceService.createDraft({
        id: `roundtrip.${adapter.domain.toLocaleLowerCase()}`,
        domain: adapter.domain,
        metadata: { name: `${adapter.domain} round trip` },
        payload,
        inputs: [],
        dependencies: [],
        capabilities: [],
        compatibility: { platforms: ["desktop"] },
      })
      releases.push(
        await sourceService.publish(draft.id, {
          expectedRevision: draft.revision,
          confirmedBump: "minor",
        })
      )
    }
    const packaged = await sourceService.exportPackage({
      id: "dev.cognia.roundtrip",
      version: "1.0.0",
      name: "Six domain round trip",
      definitionIds: releases.map((release) => ({
        id: release.id,
        version: release.version!,
      })),
    })

    const targetCreated: Array<{ domain: TemplateDomain; payload: TemplateJson }> = []
    const targetRepository = new InMemoryTemplateRepository()
    let id = 0
    const targetService = new TemplateService({
      repository: targetRepository,
      catalog: new TemplateCatalog(),
      adapters: createFullDomainAdapters(createPorts(targetCreated)),
      id: () => `generated-${++id}`,
    })
    await targetService.importPackage(packaged.bytes, { source: "file", confirmed: true })

    const imported = await targetRepository.listDefinitions()
    expect(imported).toHaveLength(6)
    for (const release of releases) {
      const restored = imported.find(
        (definition) => definition.id === release.id && definition.version === release.version
      )
      expect(restored?.payload).toEqual(release.payload)
      const plan = await targetService.preflight({
        definitionId: release.id,
        version: release.version!,
        platform: "desktop",
        bindings: {},
      })
      await expect(targetService.instantiate({ plan, confirmed: true })).resolves.toEqual(
        expect.objectContaining({
          resources: [expect.objectContaining({ domain: release.domain })],
        })
      )
    }

    expect(targetCreated.map((entry) => entry.domain)).toEqual([
      "agentTeam",
      "workflow",
      "subagent",
      "customMode",
      "character",
      "skill",
    ])
    expect(JSON.stringify(imported)).not.toContain("private-twin")
    expect(JSON.stringify(imported)).not.toContain("/private/path")
  })
})
