/**
 * Every URL into the agents console (ADR-0220). Static export: one route,
 * state in the query string, the `/squads` pattern. Callers build links here
 * instead of spelling query keys, so the route state hook and every entry
 * point agree on them.
 */

export const AGENTS_ROUTE = "/agents"

/**
 * An agent's detail is one page in one of three modes. `overview` is the
 * profile (activity, open work, facts, capabilities); `edit` swaps it for the
 * form; `tasks` gives its durable task board the full width a kanban needs.
 */
export const AGENT_DETAIL_MODES = ["overview", "edit", "tasks"] as const
export type AgentDetailMode = (typeof AGENT_DETAIL_MODES)[number]

/** `1` is the starting-point chooser; `blank` and `ai` are its two paths. */
export const AGENT_CREATE_MODES = ["1", "blank", "ai"] as const
export type AgentCreateMode = (typeof AGENT_CREATE_MODES)[number]

export function agentHref(id: string, mode?: AgentDetailMode): string {
  const params = new URLSearchParams({ id })
  if (mode && mode !== "overview") params.set("mode", mode)
  return `${AGENTS_ROUTE}?${params.toString()}`
}

/** An agent's task board: where every "watch this agent task" link lands. */
export function agentTaskBoardHref(agentId: string): string {
  return agentHref(agentId, "tasks")
}

export function newAgentHref(mode: AgentCreateMode = "1"): string {
  return `${AGENTS_ROUTE}?new=${mode}`
}

export function agentBuilderHref(sessionId: string): string {
  return `${AGENTS_ROUTE}?${new URLSearchParams({ builder: sessionId }).toString()}`
}

export function isAgentDetailMode(value: string | null | undefined): value is AgentDetailMode {
  return (AGENT_DETAIL_MODES as readonly string[]).includes(value ?? "")
}

export function isAgentCreateMode(value: string | null | undefined): value is AgentCreateMode {
  return (AGENT_CREATE_MODES as readonly string[]).includes(value ?? "")
}
