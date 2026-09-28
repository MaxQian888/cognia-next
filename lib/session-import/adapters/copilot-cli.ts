import { joinPath } from "@/lib/claude/instructions/paths"

import { createPortableAgentSessionSource } from "./portable-agent-source"

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

function normalizeCopilotDocument(document: unknown, locatorSessionId: string): unknown[] {
  const root = object(document)
  const raw = root.events ?? root.messages
  if (
    !Array.isArray(raw) ||
    !raw.some((item) => {
      const event = object(item)
      return (
        typeof event.type === "string" &&
        event.type.includes(".") &&
        Object.keys(object(event.data)).length > 0
      )
    })
  )
    return [document]
  const messages = raw.map((item) => {
    const event = object(item)
    const data = object(event.data)
    if (!event.type || !Object.keys(data).length) return item
    const base = { ...event, ...data, data: undefined }
    // Ephemeral chunks are not complete turns. Retain them as diagnostics if a
    // caller provides a live event capture instead of the persisted transcript.
    if (event.ephemeral === true)
      return { ...base, type: `copilot.${String(event.type)}`, role: "diagnostic" }
    if (event.type === "assistant.message") {
      return {
        ...base,
        role: "assistant",
        content: [
          ...(typeof data.reasoningText === "string"
            ? [{ type: "reasoning", text: data.reasoningText }]
            : []),
          ...(typeof data.content === "string" ? [{ type: "text", text: data.content }] : []),
        ],
        toolCalls: Array.isArray(data.toolRequests)
          ? data.toolRequests.map((request) => {
              const call = object(request)
              return { ...call, id: call.toolCallId }
            })
          : data.toolCalls,
      }
    }
    if (event.type === "assistant.reasoning") {
      return { ...base, role: "assistant", content: [{ type: "reasoning", text: data.content }] }
    }
    if (event.type === "tool.execution_complete") {
      return {
        ...base,
        type: "tool_result",
        toolCallId: data.toolCallId,
        output: data.success === false ? data.error : data.result,
        isError: data.success === false,
      }
    }
    // Start/progress and unknown SDK events remain diagnostic; the authoritative
    // assistant tool request supplies the call, preventing duplicate invocations.
    return event.type === "user.message" ? base : { ...base, role: "diagnostic" }
  })
  const start = raw.map(object).find((event) => event.type === "session.start")
  const startData = object(start?.data)
  const sessionId =
    root.sessionId ??
    root.session_id ??
    root.conversationId ??
    root.id ??
    startData.sessionId ??
    locatorSessionId
  const main: unknown[] = []
  const children = new Map<string, unknown[]>()
  for (const message of messages) {
    const agentId = object(message).agentId
    if (typeof agentId !== "string" || !agentId) main.push(message)
    else {
      const child = children.get(agentId)
      if (child) child.push(message)
      else children.set(agentId, [message])
    }
  }
  const common = { ...root, cwd: root.cwd ?? object(startData.context).cwd }
  return [
    { ...common, sessionId, messages: main },
    ...[...children].map(([agentId, childMessages]) => ({
      ...common,
      sessionId: `${sessionId}:agent:${agentId}`,
      parentSessionId: sessionId,
      archiveOnly: true,
      kind: "subagent",
      title: `Copilot agent ${agentId}`,
      messages: childMessages,
    })),
  ]
}

/** GitHub Copilot CLI's authoritative session-state artifacts (local only). */
export const copilotCliSessionSource = createPortableAgentSessionSource({
  id: "copilot-cli",
  displayName: "Copilot CLI",
  verifiedVersion: "0.0.350",
  presetId: "copilot-cli",
  acceptedExtensions: [".json", ".jsonl"],
  roots: (home) => (home ? [joinPath(home, ".copilot/session-state")] : []),
  pathHints: ["/.copilot/session-state/", "\\.copilot\\session-state\\"],
  contentHints: ["copilot", "session-state", "chronicle"],
  storeSource: "copilot-cli",
  defaultTitle: "Copilot CLI session",
  normalizeDocument: normalizeCopilotDocument,
})
