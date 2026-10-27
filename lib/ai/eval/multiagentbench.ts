/** Pinned public research tasks and rubric protocol; no network or model calls. */
import type { AppSettings } from "@cognia/agent-config-types"
import type { ProviderName } from "@cognia/provider-types/provider"
import { DEFAULT_TEAM_CONFIG, type AgentTeamTask } from "@/types/agent/agent-team"
import type { TeamEvalDefinition } from "./team-execution"

export const MULTIAGENTBENCH_PROFILE = "multiagentbench-research-text-v1" as const
/** Solver graph is unchanged; judge evidence and acceptance are versioned separately. */
export const MULTIAGENTBENCH_EVALUATION_PROTOCOL = "structured-research-evidence-v3" as const
export const MULTIAGENTBENCH_SOURCE = {
  repository: "https://github.com/ulab-uiuc/MARBLE",
  revision: "8d60fa17b5596b44458a52d4296061b9fc13d6f2",
  research: {
    path: "multiagentbench/research/research_main.jsonl",
    sha256: "1c7583f1ee0583ac12a625fb5c19de7b5983344dde89a2254c1782d6309310e9",
    records: 100,
  },
  rubrics: {
    path: "marble/evaluator/evaluator_prompts.json",
    sha256: "2820345a34dddd3b05d102b5d059eb25dad6e158ce384a8a4622864fff31360b",
  },
  license: {
    path: "LICENSE",
    sha256: "389d00652aaea7a870e1128c95df7171580f347856b3993f8a0890f1a1cf09ae",
  },
} as const

export interface ResearchTask {
  taskId: string
  content: string
  outputFormat: string
  agents: Array<{ agentId: string; profile: string }>
}
export interface ResearchRubrics {
  research: string
  communication: string
  milestones: string
}
export interface ResearchRatings {
  innovation: number
  safety: number
  feasibility: number
}
export interface ResearchMilestone {
  milestone: string
  agents: string[]
}
export class MultiAgentBenchValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MultiAgentBenchValidationError"
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MultiAgentBenchValidationError("Expected an object")
  return value as Record<string, unknown>
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new MultiAgentBenchValidationError(`Missing ${label}`)
  return value
}
function identity(value: unknown): string {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value
  if (typeof id !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(id))
    throw new MultiAgentBenchValidationError("Invalid task or agent identity")
  return id
}

export function parseResearchTasks(source: string): ResearchTask[] {
  if (source.length > 8_000_000)
    throw new MultiAgentBenchValidationError("Research split exceeds the import limit")
  const ids = new Set<string>()
  const tasks: ResearchTask[] = []
  for (const [lineIndex, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try {
      const row = object(JSON.parse(line))
      if (row.scenario !== "research")
        throw new MultiAgentBenchValidationError("Unsupported scenario; expected research")
      const taskId = identity(row.task_id)
      if (ids.has(taskId)) throw new MultiAgentBenchValidationError(`Duplicate task ${taskId}`)
      ids.add(taskId)
      const task = object(row.task)
      if (!Array.isArray(row.agents) || row.agents.length < 1 || row.agents.length > 31)
        throw new MultiAgentBenchValidationError(
          "Research requires one to thirty-one role profiles"
        )
      const agents = row.agents.map((value) => {
        const agent = object(value)
        if (agent.type !== "BaseAgent")
          throw new MultiAgentBenchValidationError("Unsupported research agent type")
        return { agentId: identity(agent.agent_id), profile: text(agent.profile, "agent profile") }
      })
      if (new Set(agents.map((agent) => agent.agentId)).size !== agents.length)
        throw new MultiAgentBenchValidationError("Duplicate agent identity")
      tasks.push({
        taskId,
        content: text(task.content, "task content"),
        outputFormat: text(task.output_format, "output format"),
        agents,
      })
      if (tasks.length > MULTIAGENTBENCH_SOURCE.research.records)
        throw new MultiAgentBenchValidationError("Too many research tasks")
    } catch (error) {
      throw new MultiAgentBenchValidationError(
        `Research line ${lineIndex + 1}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  if (!tasks.length) throw new MultiAgentBenchValidationError("Research split is empty")
  return tasks
}

export function parseResearchRubrics(source: string): ResearchRubrics {
  const value = object(JSON.parse(source))
  const graph = object(value.Graph)
  return {
    research: text(object(object(value.research).task_evaluation).prompt, "research rubric"),
    communication: text(object(graph.Communication).prompt, "communication rubric"),
    milestones: text(object(graph.KPI).prompt, "milestone rubric"),
  }
}

export function selectResearchTasks(
  tasks: readonly ResearchTask[],
  limit: number,
  taskIds?: readonly string[]
): ResearchTask[] {
  if (!taskIds) return tasks.slice(0, limit)
  if (!taskIds.length || new Set(taskIds).size !== taskIds.length)
    throw new MultiAgentBenchValidationError("Explicit task IDs must be nonempty and unique")
  const selected = tasks.filter((task) => taskIds.includes(task.taskId))
  if (selected.length !== taskIds.length)
    throw new MultiAgentBenchValidationError(
      "An explicit research task ID does not exist in the pinned split"
    )
  return selected
}

/** Substitute only known fields once; JSON braces and model-supplied text are data. */
export function renderResearchRubric(template: string, values: Record<string, string>): string {
  return template.replace(
    /\{\{|\}\}|\{(task|result|communications|agent_results)\}/g,
    (match, key: string) => {
      if (match === "{{") return "{"
      if (match === "}}") return "}"
      if (values[key] === undefined)
        throw new MultiAgentBenchValidationError(`Missing rubric binding ${key}`)
      return values[key]
    }
  )
}

function judgeJson(source: string): unknown {
  const stripped = source
    .trim()
    .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, "$1")
    .trim()
  try {
    return JSON.parse(stripped)
  } catch {
    throw new MultiAgentBenchValidationError("Judge did not return valid JSON")
  }
}
function rating(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5)
    throw new MultiAgentBenchValidationError("Judge rating must be an integer from one to five")
  return value
}
export function parseResearchRatings(source: string): ResearchRatings {
  const value = object(judgeJson(source))
  if (Object.keys(value).sort().join(",") !== "feasibility,innovation,safety")
    throw new MultiAgentBenchValidationError("Judge must return exactly three research ratings")
  return {
    innovation: rating(value.innovation),
    safety: rating(value.safety),
    feasibility: rating(value.feasibility),
  }
}
export function parseResearchAssessment(source: string, proposal: string) {
  const row = object(judgeJson(source))
  if (Object.keys(row).sort().join(",") !== "evidence,ratings")
    throw new MultiAgentBenchValidationError(
      "Research assessment requires exactly ratings and evidence"
    )
  const ratings = parseResearchRatings(JSON.stringify(row.ratings))
  const rawEvidence = object(row.evidence)
  if (Object.keys(rawEvidence).sort().join(",") !== "feasibility,innovation,safety")
    throw new MultiAgentBenchValidationError("Research evidence requires all three criteria")
  const evidence = Object.fromEntries(
    (["innovation", "safety", "feasibility"] as const).map((kind) => {
      const entry = object(rawEvidence[kind])
      if (Object.keys(entry).sort().join(",") !== "quote,reason")
        throw new MultiAgentBenchValidationError(
          "Research evidence requires exactly quote and reason"
        )
      const reason = text(entry.reason, "research reason")
      const quote = text(entry.quote, "research evidence quote")
      if (reason.length > 1500 || quote.length > 500 || !proposal.includes(quote))
        throw new MultiAgentBenchValidationError(
          "Research evidence exceeds bounds or quotes text absent from the proposal"
        )
      return [kind, { reason, quote }]
    })
  ) as Record<keyof ResearchRatings, { reason: string; quote: string }>
  return { ratings, evidence }
}
export function parseCommunicationRating(source: string): number {
  const value = object(judgeJson(source))
  if (Object.keys(value).join(",") !== "rating")
    throw new MultiAgentBenchValidationError("Judge must return one communication rating")
  return rating(value.rating)
}
export function parseResearchMilestones(
  source: string,
  agentIds: readonly string[]
): ResearchMilestone[] {
  const value = judgeJson(source)
  if (!Array.isArray(value) || value.length > 100)
    throw new MultiAgentBenchValidationError("Judge must return a milestone array")
  return value.map((item) => {
    const row = object(item)
    if (Object.keys(row).sort().join(",") !== "agents,milestone")
      throw new MultiAgentBenchValidationError(
        "Milestone must contain exactly milestone and agents"
      )
    const milestone = text(row.milestone, "milestone")
    if (milestone.length > 100)
      throw new MultiAgentBenchValidationError("Milestone description exceeds 100 characters")
    if (!Array.isArray(row.agents) || !row.agents.length)
      throw new MultiAgentBenchValidationError("Milestone agents must be a nonempty array")
    if (row.agents.some((id) => typeof id !== "string" || !agentIds.includes(id)))
      throw new MultiAgentBenchValidationError("Milestone references an unknown agent ID")
    return { milestone, agents: [...new Set(row.agents as string[])] }
  })
}

export function researchStructure(output: string) {
  const headers = [...output.matchAll(/^\s*(?:#{1,6}\s*)?(?:\*\*)?\[Question ([1-5])\][^\n]*$/gm)]
  const questions = headers.map((row) => Number(row[1]))
  const emptySections = headers.flatMap((row, index) => {
    const from = row.index! + row[0].length
    const body = output
      .slice(from, headers[index + 1]?.index ?? output.length)
      .replace(/[\s*_#-]/g, "")
    return body ? [] : [Number(row[1])]
  })
  return {
    policy: "five-question-headings-v1" as const,
    passed: questions.join(",") === "1,2,3,4,5" && emptySections.length === 0,
    questions,
    emptySections,
    grounding: "not_independently_verified" as const,
  }
}

export function researchJudgeEvidence(
  agentIds: readonly string[],
  contributions: ReadonlyArray<{ agentId: string; taskId: string; output: string }>,
  deliveries: ReadonlyArray<{
    callId: string
    agentId: string
    taskId: string
    dependencies: Array<{ agentId: string; taskId: string; output: string }>
  }>,
  kind: "communication" | "milestones" = "milestones"
) {
  return JSON.stringify({
    protocol: MULTIAGENTBENCH_EVALUATION_PROTOCOL,
    allowedAgentIds: agentIds,
    contributions,
    communicationEvidence: {
      basis: "dependency-payloads-in-prompts-with-returned-samples",
      limitation:
        "Payload inclusion does not prove information uptake or useful collaboration. No message exchange beyond these dependency payloads is observed.",
      deliveries,
    },
    outputSchema:
      kind === "communication"
        ? {
            type: "object",
            additionalProperties: false,
            required: ["rating"],
            properties: { rating: { type: "integer", minimum: 1, maximum: 5 } },
          }
        : {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["milestone", "agents"],
              properties: {
                milestone: { type: "string", minLength: 1, maxLength: 100 },
                agents: { type: "array", minItems: 1, items: { type: "string", enum: agentIds } },
              },
            },
          },
  })
}

export function researchSolverPrompt(task: ResearchTask, includeAllProfiles: boolean): string {
  return [
    task.content,
    task.outputFormat,
    includeAllProfiles
      ? task.agents.map((agent) => `Researcher ${agent.agentId}:\n${agent.profile}`).join("\n\n")
      : "",
    "Experiment profile: use only the supplied introduction and role knowledge. External literature tools are disabled. Do not claim to have retrieved papers or conducted experiments.",
  ]
    .filter(Boolean)
    .join("\n\n")
}

export interface ResearchExecutionOptions {
  settings: AppSettings | null
  providerId: ProviderName
  modelId: string
  timeoutMs: number
  tokenBudget: number
}
export function buildResearchSquad(
  task: ResearchTask,
  variant: "serial-squad" | "parallel-squad",
  options: ResearchExecutionOptions
): TeamEvalDefinition {
  const teamId = `mab-research-${task.taskId}`
  const createdAt = new Date(0)
  const usage = () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })
  const tasks: AgentTeamTask[] = task.agents.map((agent, index) => ({
    id: `contribution-${agent.agentId}`,
    teamId,
    title: `Research contribution ${agent.agentId}`,
    description:
      "Analyze the supplied introduction from your research profile. Propose a concrete research direction, identify limitations and make your contribution useful to the final 5q proposal. Incorporate any dependency contributions you receive. Keep this contribution under 300 words and leave final synthesis to the final task.",
    assignedTo: agent.agentId,
    dependencies:
      variant === "serial-squad" && index
        ? [`contribution-${task.agents[index - 1]!.agentId}`]
        : [],
    status: "pending",
    priority: "normal",
    tags: [MULTIAGENTBENCH_PROFILE],
    createdAt,
    order: index,
  }))
  tasks.push({
    id: "final-proposal",
    teamId,
    title: "Synthesize the final 5q research proposal",
    description:
      "Synthesize all dependency contributions into one coherent final research proposal. Resolve disagreements, preserve useful evidence and follow the original five-question output format. Return the proposal itself.",
    assignedTo: task.agents[0]!.agentId,
    dependencies: tasks.map((row) => row.id),
    status: "pending",
    priority: "normal",
    tags: [MULTIAGENTBENCH_PROFILE],
    createdAt,
    order: tasks.length,
  })
  return {
    team: {
      id: teamId,
      name: `MultiAgentBench research ${task.taskId}`,
      description: MULTIAGENTBENCH_PROFILE,
      task: researchSolverPrompt(task, false),
      status: "idle",
      leadId: task.agents[0]!.agentId,
      teammateIds: task.agents.map((agent) => agent.agentId),
      taskIds: tasks.map((row) => row.id),
      messageIds: [],
      progress: 0,
      totalTokenUsage: usage(),
      createdAt,
      config: {
        ...structuredClone(DEFAULT_TEAM_CONFIG),
        defaultProvider: options.providerId,
        defaultModel: options.modelId,
        defaultTemperature: 0,
        defaultTimeout: options.timeoutMs,
        tokenBudget: options.tokenBudget,
        maxTeammates: task.agents.length,
        maxConcurrentTeammates: variant === "serial-squad" ? 1 : Math.min(5, task.agents.length),
        riskGating: false,
        maxRetries: 0,
        enableTaskRetry: false,
      },
    },
    members: task.agents.map((agent) => ({
      id: agent.agentId,
      teamId,
      name: agent.agentId,
      description: agent.profile,
      role: "teammate",
      status: "idle",
      completedTaskIds: [],
      tokenUsage: usage(),
      progress: 0,
      createdAt,
      config: { provider: options.providerId, model: options.modelId, systemPrompt: agent.profile },
    })),
    tasks,
    settings: options.settings,
  }
}
