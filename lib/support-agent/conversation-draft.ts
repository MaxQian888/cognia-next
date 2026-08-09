import type { UIMessage } from "ai"

function visibleText(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text"
    )
    .map((part) => part.text)
    .join("\n")
    .trim()
}

/** Build a local, editable feedback seed without including model reasoning. */
export function buildSupportConversationSummary(
  messages: readonly UIMessage[],
  labels: { user: string; support: string },
  maxChars = 2_000
): string {
  let latestUser = ""
  let latestSupport = ""
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!latestUser && message.role === "user") latestUser = visibleText(message)
    if (!latestSupport && message.role === "assistant") latestSupport = visibleText(message)
    if (latestUser && latestSupport) break
  }
  return [
    latestUser ? `${labels.user}:\n${latestUser}` : "",
    latestSupport ? `${labels.support}:\n${latestSupport}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, maxChars)
}
