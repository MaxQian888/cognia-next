import type { ChatSession } from "@cognia/agent-config-types"
import { getSession } from "@/lib/db/sessions"
import { listMessages } from "@/lib/db/messages"
import { branchSessionAtMessage } from "@/lib/chat/branch-session"

export interface AgentThreadNode {
  session: ChatSession
  children: AgentThreadNode[]
  running: boolean
}

export function buildAgentThreadForest(
  sessions: readonly ChatSession[],
  runningSessionIds: ReadonlySet<string> = new Set()
): AgentThreadNode[] {
  const byId = new Map<string, AgentThreadNode>(
    sessions.map((session): [string, AgentThreadNode] => [
      session.id,
      { session, children: [], running: runningSessionIds.has(session.id) },
    ])
  )
  const roots: AgentThreadNode[] = []
  for (const node of byId.values()) {
    const parent = node.session.parentSessionId ? byId.get(node.session.parentSessionId) : undefined
    if (node.session.kind === "subagent" && parent) parent.children.push(node)
    else if (node.session.kind === "subagent") roots.push(node)
  }
  for (const node of byId.values()) {
    if (node.session.kind !== "subagent" && node.children.length > 0) roots.push(node)
    node.children.sort((a, b) => +new Date(a.session.createdAt) - +new Date(b.session.createdAt))
  }
  return roots.sort((a, b) => +new Date(b.session.updatedAt) - +new Date(a.session.updatedAt))
}

/** Snapshot promotion: clone the completed child transcript into a new direct
 * task. The hidden child remains owned by its parent and is never transferred. */
export async function promoteSubagentSession(
  sourceSessionId: string,
  running: boolean
): Promise<ChatSession> {
  if (running) throw new Error("A running agent thread cannot be promoted")
  const source = await getSession(sourceSessionId)
  if (!source || source.kind !== "subagent") throw new Error("Agent thread was not found")
  const messages = await listMessages(sourceSessionId)
  const last = messages.at(-1)
  if (!last) throw new Error("An empty agent thread cannot be promoted")
  return branchSessionAtMessage({
    sourceId: sourceSessionId,
    visibleMessages: messages,
    messageId: last.id,
    mode: "direct",
  })
}
