/**
 * The one-line capability summary an agent-shaped node shows on its card.
 *
 * Every mature node-graph builder puts the same three or four facts on the
 * node itself and leaves the rest to the inspector: which model, how many
 * tools, how many teammates. This repo had none of them, so an
 * `action.agent.turn` card said "Agent turn" and nothing else, and telling two
 * agent nodes apart meant opening both.
 *
 * Derived from params that are already on the node, so there is no new data
 * source and no fetch: the canvas renders what the graph already carries.
 */

import type { WorkflowNodeKind } from "@/types/workflow/visual"

export interface AgentNodeSummary {
  /** Short model id, with the provider prefix dropped. */
  model?: string
  /** Counts keyed by what they count. Absent keys are simply not rendered. */
  tools?: number
  skills?: number
  members?: number
  steps?: number
  /** A named character or team wins over a raw id in the label. */
  persona?: string
}

/** Kinds that carry an agent-ish configuration worth summarising. */
const SUMMARISED = new Set<string>([
  "action.agent.turn",
  "action.team.run",
  "action.team.create",
  "action.team.compose",
  "action.team.task.dispatch",
  "action.plan.create",
  "action.plan.updateDraft",
  "action.skill.invoke",
  "ai.prompt",
  "ai.classify",
  "ai.extract",
  "ai.council",
  "ai.ensemble",
])

function shortModel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  // Expression references are the author's business, not a model name.
  if (trimmed.includes("{{")) return undefined
  // `anthropic/claude-opus-5` and `openai:gpt-5` both read better as the tail.
  const tail = trimmed.split(/[/:]/).pop() ?? trimmed
  return tail.length > 24 ? `${tail.slice(0, 23)}…` : tail
}

function countList(raw: unknown): number | undefined {
  if (Array.isArray(raw)) return raw.length || undefined
  if (typeof raw === "string") {
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
    return parts.length || undefined
  }
  return undefined
}

/** Length of a JSON array held in a raw-JSON textarea param. */
function countJsonArray(raw: unknown): number | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.length > 0 ? parsed.length : undefined
  } catch {
    return undefined
  }
}

export function agentNodeSummary(
  kind: WorkflowNodeKind | string | undefined,
  params: Record<string, unknown> | undefined
): AgentNodeSummary | null {
  if (!kind || !SUMMARISED.has(kind) || !params) return null
  const summary: AgentNodeSummary = {}

  const model = shortModel(params.model)
  if (model) summary.model = model

  const tools = countList(params.allowedTools)
  if (tools) summary.tools = tools

  const skills = countList(params.skillIds)
  if (skills) summary.skills = skills

  const members = countJsonArray(params.membersJson) ?? countList(params.members)
  if (members) summary.members = members

  const steps = countJsonArray(params.stepsJson)
  if (steps) summary.steps = steps

  const persona = params.characterId ?? params.teamId
  if (typeof persona === "string" && persona.trim() && !persona.includes("{{")) {
    summary.persona = persona.trim()
  }

  return Object.keys(summary).length > 0 ? summary : null
}
