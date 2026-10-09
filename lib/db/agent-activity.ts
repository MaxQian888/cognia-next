/**
 * Index reads behind the agents console (ADR-0220). Every number the console
 * shows about an agent is derived from rows that already carry it — sessions
 * by `characterId`, issues by `[assigneeKind+assigneeId]`, spend by
 * `characterId` — so none of this is stored a second time.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { Issue } from "@/types/issues"
import { getDb } from "./schema"
import type { SessionUsageRow } from "./session-usage"

/** Conversations started with the agent, archived ones included. */
export async function listAgentSessions(agentId: string): Promise<ChatSession[]> {
  return getDb().sessions.where("characterId").equals(agentId).toArray()
}

/** Issues assigned to the agent. Sync/system actors use other ids and never match. */
export async function listAgentIssues(agentId: string): Promise<Issue[]> {
  return getDb().issues.where("[assigneeKind+assigneeId]").equals(["agent", agentId]).toArray()
}

/** The agent's spend rows at or after `since`. */
export async function listAgentUsageSince(
  agentId: string,
  since: number
): Promise<SessionUsageRow[]> {
  const rows = await getDb().sessionUsage.where("characterId").equals(agentId).toArray()
  return rows.filter((row) => row.at >= since)
}

/** The slice of a session the agents table summarises. */
export type AgentSessionSummaryRow = Pick<
  ChatSession,
  "id" | "characterId" | "title" | "createdAt" | "updatedAt" | "lastMessageAt" | "archivedAt"
>

export interface AgentsSummaryInputs {
  sessions: AgentSessionSummaryRow[]
  usage: Pick<SessionUsageRow, "characterId" | "at" | "sessionId">[]
}

/**
 * Everything the agents table needs for every agent at once: each
 * agent-bound conversation, and every agent-attributed spend row since
 * `since`. Two index range reads, regardless of how many agents exist.
 */
export async function listAgentsSummaryInputs(since: number): Promise<AgentsSummaryInputs> {
  const db = getDb()
  const [sessions, usage] = await Promise.all([
    db.sessions.where("characterId").aboveOrEqual("").toArray(),
    db.sessionUsage.where("at").aboveOrEqual(since).toArray(),
  ])
  return {
    sessions: sessions.map((s) => ({
      id: s.id,
      characterId: s.characterId,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      lastMessageAt: s.lastMessageAt,
      archivedAt: s.archivedAt,
    })),
    usage: usage
      .filter((row) => typeof row.characterId === "string" && row.characterId.length > 0)
      .map((row) => ({ characterId: row.characterId, at: row.at, sessionId: row.sessionId })),
  }
}
