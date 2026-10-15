import type { UIMessage } from "ai"
import type { SendContent } from "@cognia/agent-config-types"

/**
 * Add private resource context to the provider-bound prompt. Callers must only
 * use this after plugin prompt hooks and visible-message construction so the
 * resource body never becomes part of the persisted user message.
 */
export function attachResourceContext(
  content: SendContent,
  resourceContext: string,
  header = "Current resource context"
): SendContent {
  if (!resourceContext) return content
  const contextBlock = `[${header}]\n${resourceContext}\n\n[User instruction]\n`
  return typeof content === "string"
    ? `${contextBlock}${content}`
    : [{ type: "text", text: contextBlock }, ...content]
}

/** A rebuilding provider reads messages, not SendContent. Keep this copy provider-only. */
export function withWorkbenchMessageContext(
  messages: UIMessage[],
  resourceContext: string,
  header = "Current resource context"
): UIMessage[] {
  if (!resourceContext) return messages
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user")
  return messages.map((message, index) =>
    index === lastUserIndex
      ? {
          ...message,
          parts: [
            { type: "text", text: attachResourceContext("", resourceContext, header) as string },
            ...message.parts,
          ],
        }
      : message
  )
}
