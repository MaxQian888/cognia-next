import { defineAdapterExtension } from "@cognia/agent-contracts/adapter-extension"

export interface GooseChildSession {
  id: string
  parentId: string
  title: string
  completed: boolean
  /** Passive export only: never loads a live child or registers its MCP servers. */
  transcript: string
}

export interface GooseSessionControls {
  listChildren(parentId: string): Promise<string[]>
  inspect(parentId: string, childId: string): Promise<GooseChildSession>
  /** The caller sends this through its ordinary parent chat/approval/PII path. */
  recoveryPrompt(parentId: string, childId: string): Promise<string>
}

export const gooseSessionExtension = defineAdapterExtension<GooseSessionControls>(
  "goose.sessions",
  (adapter) =>
    (adapter as unknown as { gooseSessionControls?: GooseSessionControls }).gooseSessionControls
)

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function idValid(id: string): boolean {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 256 &&
    !Array.from(id).some((char) => char.charCodeAt(0) < 32)
  )
}

/** Dedicated passive export operations; ordinary ACP session/load can start runs. */
export function createGooseSessionControls(deps: {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>
  hasParent(id: string): boolean
  isBusy(id: string): boolean
  outboundGate(payload: unknown): boolean
}): GooseSessionControls {
  async function exported(id: string): Promise<Record<string, unknown>> {
    if (!idValid(id)) throw new Error("Invalid Goose session identity")
    const response = await deps.request<{ data: string }>("_goose/unstable/session/export", {
      sessionId: id,
      format: "json",
    })
    if (typeof response?.data !== "string" || response.data.length > 8 * 1024 * 1024)
      throw new Error("Invalid or oversized Goose session export")
    const session = record(JSON.parse(response.data))
    if (session.id !== id || !Array.isArray(session.conversation))
      throw new Error("Goose session export identity mismatch")
    return session
  }
  function parent(id: string) {
    if (!idValid(id) || !deps.hasParent(id)) throw new Error("Unknown Goose parent session")
  }
  function contents(session: Record<string, unknown>): Record<string, unknown>[] {
    return (session.conversation as unknown[]).flatMap((message) => {
      const content = record(message).content
      return Array.isArray(content) ? content.map(record) : []
    })
  }
  return {
    async listChildren(parentId) {
      parent(parentId)
      const session = await exported(parentId)
      const children = new Set<string>()
      for (const block of contents(session)) {
        if (block.type !== "toolResponse") continue
        const value = record(record(block.toolResult).value)
        const id = record(value._meta).subagent_session_id
        if (typeof id === "string" && idValid(id) && id !== parentId) children.add(id)
      }
      if (children.size > 128) throw new Error("Goose child listing exceeds the inspection limit")
      return [...children]
    },
    async inspect(parentId, childId) {
      parent(parentId)
      if (parentId === childId) throw new Error("A Goose parent cannot be inspected as its child")
      const session = await exported(childId)
      if (session.parent_session_id !== parentId)
        throw new Error("Goose child belongs to another parent")
      const blocks = contents(session)
      const successful = new Set(
        blocks
          .filter((block) => {
            const result = record(block.toolResult)
            const value = record(result.value)
            return (
              block.type === "toolResponse" &&
              result.status === "success" &&
              value.isError !== true &&
              Array.isArray(value.content) &&
              value.content.some(
                (item) =>
                  record(item).type === "text" &&
                  record(item).text === "Final output successfully collected."
              )
            )
          })
          .map((block) => block.id)
      )
      const completed = blocks.some(
        (block) =>
          block.type === "toolRequest" &&
          successful.has(block.id) &&
          record(record(block.toolCall).value).name === "recipe__final_output"
      )
      // Goose owns escaping and projection. This request does not install or resume a session.
      const markdown = await deps.request<{ data: string }>("_goose/unstable/session/export", {
        sessionId: childId,
        format: "markdown",
      })
      if (typeof markdown?.data !== "string" || markdown.data.length > 8 * 1024 * 1024)
        throw new Error("Invalid or oversized Goose transcript")
      return {
        id: childId,
        parentId,
        title: typeof session.name === "string" ? session.name : childId,
        completed,
        transcript: markdown.data,
      }
    },
    async recoveryPrompt(parentId, childId) {
      parent(parentId)
      if (deps.isBusy(parentId)) throw new Error("Wait for the Goose parent turn to finish")
      const child = await this.inspect(parentId, childId)
      if (child.completed) throw new Error("Completed Goose children cannot be resumed")
      const session = await exported(childId)
      if (session.parent_session_id !== parentId || !deps.outboundGate(session.conversation))
        throw new Error("Goose recovery context was blocked by the outbound PII gate")
      return `Continue the failed or cancelled delegate by calling delegate with exactly ${JSON.stringify({ resume: childId })}. Resume this existing child; preserve its saved conversation.`
    },
  }
}
