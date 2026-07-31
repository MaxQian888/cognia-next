import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"
import {
  createAgentTeamTemplateAdapter,
  createFullDomainAdapters,
  createWorkflowTemplateAdapter,
  type AgentTeamTemplatePayload,
} from "./adapters"
import { createTemplateDefinition } from "./contracts"

describe("template domain adapters", () => {
  it("projects a complete AgentTeam while converting Twin ids to portable slots", async () => {
    const adapter = createAgentTeamTemplateAdapter({
      createTeam: jest.fn(),
      addTeammate: jest.fn(),
      createTask: jest.fn(),
      deleteTeam: jest.fn(),
      snapshot: jest.fn(),
    })
    const team = {
      id: "team-1",
      name: "Review",
      description: "Review changes",
      task: "Review this repository",
      status: "idle",
      config: {
        executionMode: "coordinated",
        knowledgeTwinIds: ["team-twin"],
        capabilities: { tools: { allow: ["Read"] } },
        governancePolicy: { requirePlanApproval: true },
      },
      leadId: "lead",
      teammateIds: ["lead", "worker"],
      taskIds: ["task-1"],
      messageIds: [],
      progress: 0,
      totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      createdAt: new Date(1),
    } as unknown as AgentTeam
    const teammates = [
      {
        id: "lead",
        teamId: team.id,
        name: "Lead",
        role: "lead",
        description: "Coordinates",
        status: "idle",
        config: { systemPrompt: "Coordinate carefully", twinId: "lead-local-twin" },
      },
      {
        id: "worker",
        teamId: team.id,
        name: "Security",
        role: "teammate",
        description: "Reviews security",
        status: "idle",
        config: {
          twinId: "local-twin",
          systemPrompt: "Review security",
          allowedTools: ["Read"],
          specialization: "security",
        },
        capabilities: { tools: { allow: ["Grep"] } },
      },
    ] as unknown as AgentTeammate[]
    const tasks = [
      {
        id: "task-1",
        teamId: team.id,
        title: "Threat model",
        description: "Find threats",
        status: "pending",
        priority: "high",
        assignedTo: "worker",
        dependencies: [],
        tags: ["security"],
        expectedOutput: "Report",
        order: 0,
        createdAt: new Date(2),
      },
    ] as AgentTeamTask[]

    const payload = (await adapter.project({ team, teammates, tasks })) as AgentTeamTemplatePayload
    expect(payload.team.config).toMatchObject({
      executionMode: "coordinated",
      capabilities: { tools: { allow: ["Read"] } },
      governancePolicy: { requirePlanApproval: true },
    })
    expect(JSON.stringify(payload)).not.toContain("local-twin")
    expect(JSON.stringify(payload)).not.toContain("team-twin")
    expect(payload.twinSlots.map((slot) => slot.id)).toEqual([
      "teammate.lead.twin",
      "team.knowledge.1",
      "teammate.worker.twin",
    ])
    expect(payload.lead.twinSlotId).toBe("teammate.lead.twin")
    expect(payload.teammates[0]).toMatchObject({
      localId: "worker",
      config: {
        systemPrompt: "Review security",
        allowedTools: ["Read"],
        specialization: "security",
      },
      twinSlotId: "teammate.worker.twin",
    })
    expect(payload.tasks[0]).toMatchObject({
      assignedToLocalId: "worker",
      expectedOutput: "Report",
      tags: ["security"],
    })
  })

  it("rolls back a partially-created AgentTeam when task creation fails", async () => {
    const createTeam = jest.fn(() => ({ id: "created-team" }))
    const addTeammate = jest.fn(() => ({ id: "created-worker" }))
    const createTask = jest.fn(() => {
      throw new Error("task failed")
    })
    const deleteTeam = jest.fn()
    const adapter = createAgentTeamTemplateAdapter({
      createTeam,
      addTeammate,
      createTask,
      deleteTeam,
      snapshot: jest.fn(async () => ({})),
    })
    const definition = await createTemplateDefinition({
      id: "team.review",
      domain: "agentTeam",
      status: "draft",
      revision: 1,
      metadata: { name: "Review" },
      payload: {
        team: { name: "Review", description: "", task: "Review", config: {} },
        lead: { localId: "lead", name: "Lead", description: "", config: {} },
        teammates: [
          {
            localId: "worker",
            name: "Worker",
            description: "",
            config: {},
            twinSlotId: "teammate.worker.twin",
          },
        ],
        tasks: [
          {
            localId: "task",
            title: "Review",
            description: "",
            priority: "normal",
            assignedToLocalId: "worker",
            dependencies: [],
            tags: [],
            order: 0,
          },
        ],
        twinSlots: [
          { id: "teammate.worker.twin", label: "Worker Twin", required: false, scope: "teammate" },
        ],
      },
      inputs: [
        { id: "teammate.worker.twin", kind: "twinSlot", label: "Worker Twin", required: false },
      ],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop"] },
      provenance: { source: "user" },
    })
    const plan = await adapter.preflight({
      definition,
      platform: "desktop",
      bindings: { "teammate.worker.twin": "twin-local" },
    })

    await expect(adapter.instantiate({ definition, plan, idempotencyKey: "once" })).rejects.toThrow(
      "task failed"
    )
    expect(addTeammate).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.objectContaining({ twinId: "twin-local" }) })
    )
    expect(deleteTeam).toHaveBeenCalledWith("created-team")
  })

  it("projects workflows without callable publication, credentials, or enabled triggers", async () => {
    const adapter = createWorkflowTemplateAdapter({
      create: jest.fn(),
      snapshot: jest.fn(),
    })
    const payload = (await adapter.project({
      id: "wf-1",
      schemaVersion: 2,
      name: "Inbox",
      nodes: [
        {
          id: "trigger",
          type: "trigger.schedule",
          data: { label: "Schedule", params: { enabled: true, credentialId: "cred-1" } },
        },
      ],
      edges: [],
      credentials: { mail: "cred-1" },
      published: { at: 1, toolName: "wf_inbox" },
      createdAt: 1,
      updatedAt: 2,
    })) as Record<string, unknown>

    expect(payload).not.toHaveProperty("published")
    expect(payload).not.toHaveProperty("credentials")
    expect(JSON.stringify(payload)).not.toContain("cred-1")
    expect(payload.nodes).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          disabled: true,
          params: expect.objectContaining({ enabled: false }),
        }),
      }),
    ])
  })

  it("provides all six full-domain adapters", () => {
    const adapters = createFullDomainAdapters({
      agentTeam: {
        createTeam: jest.fn(),
        addTeammate: jest.fn(),
        createTask: jest.fn(),
        deleteTeam: jest.fn(),
        snapshot: jest.fn(),
      },
      workflow: { create: jest.fn(), snapshot: jest.fn() },
      subagent: { create: jest.fn(), snapshot: jest.fn() },
      customMode: { create: jest.fn(), snapshot: jest.fn() },
      character: { create: jest.fn(), snapshot: jest.fn() },
      skill: { create: jest.fn(), snapshot: jest.fn() },
    })
    expect(adapters.map((adapter) => adapter.domain)).toEqual([
      "agentTeam",
      "workflow",
      "subagent",
      "customMode",
      "character",
      "skill",
    ])
  })
})
