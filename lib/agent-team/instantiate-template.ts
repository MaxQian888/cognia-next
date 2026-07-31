import type {
  AddTeammateInput,
  AgentTeam,
  AgentTeamTask,
  AgentTeamTemplate,
  AgentTeammate,
  CreateTaskInput,
  CreateTeamInput,
} from "@/types/agent/agent-team"

interface TemplateActions {
  createTeam(input: CreateTeamInput): AgentTeam
  addTeammate(input: AddTeammateInput): AgentTeammate
  createTask(input: CreateTaskInput): AgentTeamTask
}

/** Instantiate one team template, including its roster and pre-seeded tasks. */
export function instantiateAgentTeamTemplate(
  template: AgentTeamTemplate,
  actions: TemplateActions
): AgentTeam {
  const team = actions.createTeam({
    name: template.name,
    description: template.description,
    task: template.description,
    config: template.config,
  })
  const teammateIds = template.teammates.map((teammate) =>
    actions.addTeammate({
      teamId: team.id,
      name: teammate.name,
      description: teammate.description,
      role: "teammate",
      config: {
        ...teammate.config,
        systemPrompt: teammate.systemPrompt ?? teammate.config?.systemPrompt,
        capabilities: teammate.capabilities ?? teammate.config?.capabilities,
        specialization: teammate.specialization ?? teammate.config?.specialization,
      },
    })
  )

  for (const [order, task] of (template.taskTemplates ?? []).entries()) {
    const assignedTo =
      task.assignedToIndex === undefined ? undefined : teammateIds[task.assignedToIndex]?.id
    actions.createTask({
      teamId: team.id,
      title: task.title,
      description: task.description,
      priority: task.priority,
      order,
      ...(assignedTo ? { assignedTo } : {}),
    })
  }

  return team
}
