import type { AgentTeam, AgentTeamTemplate, AgentTeammate } from "@/types/agent/agent-team"
import { instantiateAgentTeamTemplate } from "./instantiate-template"

describe("instantiateAgentTeamTemplate", () => {
  it("creates the roster before tasks and resolves assignedToIndex to teammate ids", () => {
    const template: AgentTeamTemplate = {
      id: "work",
      name: "Work Cell",
      description: "Create a reviewed deliverable",
      category: "analysis",
      teammates: [
        { name: "Planner", description: "Plans" },
        { name: "Editor", description: "Edits" },
      ],
      taskTemplates: [
        { title: "Plan", description: "Write brief", priority: "high", assignedToIndex: 0 },
        { title: "Deliver", description: "Create output", priority: "normal", assignedToIndex: 1 },
        { title: "Unassigned", description: "Open task", priority: "low" },
      ],
    }
    const createTeam = jest.fn(() => ({ id: "team-1" }) as AgentTeam)
    const addTeammate = jest
      .fn()
      .mockReturnValueOnce({ id: "mate-1" } as AgentTeammate)
      .mockReturnValueOnce({ id: "mate-2" } as AgentTeammate)
    const createTask = jest.fn()

    const team = instantiateAgentTeamTemplate(template, { createTeam, addTeammate, createTask })

    expect(team.id).toBe("team-1")
    expect(createTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ teamId: "team-1", title: "Plan", assignedTo: "mate-1", order: 0 })
    )
    expect(createTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ title: "Deliver", assignedTo: "mate-2", order: 1 })
    )
    expect(createTask).toHaveBeenNthCalledWith(
      3,
      expect.not.objectContaining({ assignedTo: expect.anything() })
    )
  })

  it("ignores an out-of-range assignee index instead of creating a dangling id", () => {
    const template: AgentTeamTemplate = {
      id: "bad-index",
      name: "Template",
      description: "Template",
      category: "general",
      teammates: [],
      taskTemplates: [
        { title: "Task", description: "Task", priority: "normal", assignedToIndex: 4 },
      ],
    }
    const createTask = jest.fn()

    instantiateAgentTeamTemplate(template, {
      createTeam: () => ({ id: "team-1" }) as AgentTeam,
      addTeammate: jest.fn(),
      createTask,
    })

    expect(createTask).toHaveBeenCalledWith(
      expect.not.objectContaining({ assignedTo: expect.anything() })
    )
  })

  it("applies teammate overrides, falls back to config values, and allows templates without tasks", () => {
    const template: AgentTeamTemplate = {
      id: "capabilities",
      name: "Capabilities",
      description: "Capabilities",
      category: "general",
      teammates: [
        {
          name: "Fallback",
          description: "Fallback",
          config: {
            systemPrompt: "config prompt",
            specialization: "config specialization",
            capabilities: { skillIds: { add: ["config-skill"] } },
          },
        },
        {
          name: "Override",
          description: "Override",
          systemPrompt: "top prompt",
          specialization: "top specialization",
          capabilities: { skillIds: { add: ["top-skill"] } },
          config: {
            systemPrompt: "ignored prompt",
            specialization: "ignored specialization",
            capabilities: { skillIds: { add: ["ignored-skill"] } },
          },
        },
      ],
    }
    const addTeammate = jest
      .fn()
      .mockReturnValueOnce({ id: "fallback" } as AgentTeammate)
      .mockReturnValueOnce({ id: "override" } as AgentTeammate)
    const createTask = jest.fn()

    instantiateAgentTeamTemplate(template, {
      createTeam: () => ({ id: "team-1" }) as AgentTeam,
      addTeammate,
      createTask,
    })

    expect(addTeammate.mock.calls[0][0].config).toMatchObject({
      systemPrompt: "config prompt",
      specialization: "config specialization",
      capabilities: { skillIds: { add: ["config-skill"] } },
    })
    expect(addTeammate.mock.calls[1][0].config).toMatchObject({
      systemPrompt: "top prompt",
      specialization: "top specialization",
      capabilities: { skillIds: { add: ["top-skill"] } },
    })
    expect(createTask).not.toHaveBeenCalled()
  })
})
