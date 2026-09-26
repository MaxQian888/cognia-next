/**
 * The agent a new conversation starts as when a person opens it in a
 * workspace that names a default agent (`Project.defaultCharacterId`).
 *
 * It only fills a gap: a caller that already named an agent, a team or a squad
 * keeps its choice, and a conversation no person started (`activate: false`,
 * e.g. a workflow step at 3am) keeps the behaviour its caller asked for. A
 * default that no longer resolves (agent deleted, plugin pack disabled) is
 * skipped with a warning so the chat still opens, and the workspace settings
 * show it as missing.
 */

import type { Character } from "@cognia/agent-config-types"
import type { Project } from "@/types"
import { loggers } from "@cognia/logging"

// Resolved on first use: this module is imported by many surfaces, some under
// test doubles of the logging package, and none of them should fail at import.
let cachedLog: ReturnType<typeof loggers.agent.child> | undefined
const log = {
  warn: (...args: Parameters<ReturnType<typeof loggers.agent.child>["warn"]>) =>
    (cachedLog ??= loggers.agent.child("project-default-agent")).warn(...args),
}

export interface ProjectDefaultAgentInput {
  project: Pick<Project, "id" | "defaultCharacterId"> | null | undefined
  seed: { characterId?: string; teamId?: string; squadId?: string }
  /** `false` when no person started the conversation. */
  activate?: boolean
  resolveAgent: (id: string) => Promise<Character | undefined>
}

export async function projectDefaultAgentId(
  input: ProjectDefaultAgentInput
): Promise<string | undefined> {
  const agentId = input.project?.defaultCharacterId?.trim()
  if (!agentId) return undefined
  if (input.activate === false) return undefined
  if (input.seed.characterId || input.seed.teamId || input.seed.squadId) return undefined
  const agent = await input.resolveAgent(agentId).catch(() => undefined)
  if (!agent) {
    log.warn("workspace default agent is missing; starting without it", {
      projectId: input.project?.id,
      agentId,
    })
    return undefined
  }
  return agent.id
}
