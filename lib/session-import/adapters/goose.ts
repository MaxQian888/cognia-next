import { createPortableAgentSessionSource } from "./portable-agent-source"
import { joinPath } from "@/lib/claude/instructions/paths"

type Row = Record<string, unknown>
const row = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {}

function visibleToUser(value: unknown): boolean {
  const audience = row(row(value).annotations).audience
  return audience == null || (Array.isArray(audience) && audience.includes("user"))
}

/** Goose's Session export differs from the portable message envelope. */
function normalize(document: unknown): unknown[] {
  const session = row(document)
  if (
    !Array.isArray(session.conversation) ||
    typeof session.id !== "string" ||
    typeof session.working_dir !== "string"
  )
    return []
  // Native stores allocate IDs independently; identical IDs in two configurations
  // must never merge into one imported conversation or cross-link their children.
  const scopedId = (id: string) =>
    typeof session._cognia_store === "string" ? JSON.stringify([session._cognia_store, id]) : id
  const messages: unknown[] = []
  for (const [index, value] of session.conversation.entries()) {
    const message = row(value)
    const metadata = row(message.metadata)
    if (metadata.userVisible === false) {
      messages.push({
        type: "goose.hidden_context",
        id: message.id ?? index,
        note: "Model-only content omitted from the user-visible transcript.",
      })
      continue
    }
    if (
      !Array.isArray(message.content) ||
      (message.metadata != null &&
        (typeof message.metadata !== "object" || Array.isArray(message.metadata))) ||
      (metadata.userVisible !== undefined && typeof metadata.userVisible !== "boolean")
    ) {
      messages.push({
        type: "goose.invalid_content",
        note: "Malformed Goose message content was omitted.",
      })
      continue
    }
    const content: unknown[] = []
    const toolCalls: unknown[] = []
    for (const item of message.content) {
      const block = row(item)
      if ((block.type === "text" || block.type === "image") && !visibleToUser(block)) continue
      if (block.type === "text") content.push(block)
      else if (block.type === "thinking") content.push({ type: "reasoning", text: block.thinking })
      else if (block.type === "image")
        content.push({ type: "image", source: { mimeType: block.mimeType, data: block.data } })
      else if (block.type === "toolRequest") {
        const call = row(block.toolCall)
        if (call.status === "success") {
          const tool = row(call.value)
          toolCalls.push({ id: block.id, name: tool.name, arguments: row(tool.arguments) })
        } else content.push({ type: "text", text: String(call.error ?? "Tool request failed") })
      } else if (block.type === "toolResponse") {
        const result = row(block.toolResult)
        const tool = row(result.value)
        content.push({
          type: "tool_result",
          callId: block.id,
          output:
            result.status === "success" && Array.isArray(tool.content)
              ? tool.content.filter(visibleToUser)
              : result.error,
          isError: result.status === "error" || tool.isError === true,
        })
      } else
        messages.push({
          type: "goose.unsupported_block",
          id: block.type,
          note: "Unsupported Goose content was omitted.",
        })
    }
    const usage = row(metadata.usage)
    messages.push({
      ...message,
      content,
      toolCalls,
      timestamp: typeof message.created === "number" ? message.created * 1000 : undefined,
      ...(Object.keys(usage).length
        ? {
            usage: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
              cacheReadInputTokens: usage.cacheReadTokens,
              cacheCreationInputTokens: usage.cacheWriteTokens,
              totalCostUsd: usage.cost,
            },
          }
        : {}),
    })
  }
  return [
    {
      id: scopedId(session.id),
      sessionId: scopedId(session.id),
      title: session.name,
      cwd: session.working_dir,
      model: row(session.model_config).model,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      parentSessionId:
        typeof session.parent_session_id === "string"
          ? scopedId(session.parent_session_id)
          : undefined,
      kind: session.parent_session_id ? "subagent" : "direct",
      // File imports are passive archives; native resume needs a live configuration binding.
      archiveOnly: true,
      messages,
    },
  ]
}

export const gooseSessionSource = createPortableAgentSessionSource({
  id: "goose",
  displayName: "Goose",
  verifiedVersion: "1.56.0",
  verifiedAt: "2026-10-25",
  acceptedExtensions: [".json"],
  storeSource: "goose",
  roots: (home) =>
    home
      ? [
          joinPath(home, ".local/share/goose/sessions"),
          joinPath(home, "Library/Application Support/Block/goose/sessions"),
        ]
      : [],
  pathHints: ["/goose/", "\\goose\\"],
  defaultTitle: "Goose session",
  fidelity: "structured",
  normalizeDocument: normalize,
  detectContent: (content) => {
    try {
      const value = row(JSON.parse(content))
      return (
        typeof value.id === "string" &&
        typeof value.working_dir === "string" &&
        typeof value.session_type === "string" &&
        Array.isArray(value.conversation)
      )
    } catch {
      return false
    }
  },
})
