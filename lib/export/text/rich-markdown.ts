// Markdown export for a single chat session. Walks the AI SDK UIMessage parts
// and renders text / reasoning / tool-call blocks as fenced markdown that
// round-trips through any standard renderer (GitHub, Obsidian, etc).

import type { UIMessage } from "ai"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"

export interface RichExportData {
  session: ChatSession
  messages: StoredMessage[]
  exportedAt: Date
  includeMetadata?: boolean
  includeTokens?: boolean
}

/** Convert a session + its messages to a portable Markdown string. */
export function exportToRichMarkdown(data: RichExportData): string {
  const { session, messages, exportedAt, includeMetadata = true, includeTokens = false } = data
  const lines: string[] = []

  lines.push(`# ${session.title}`)
  lines.push("")

  if (includeMetadata) {
    lines.push("## Conversation Info")
    lines.push("")
    lines.push("| Property | Value |")
    lines.push("|----------|-------|")
    lines.push(`| **Date** | ${new Date(session.createdAt).toLocaleDateString()} |`)
    lines.push(`| **Kind** | ${session.kind ?? "direct"} |`)
    if (session.model) lines.push(`| **Model** | ${session.model} |`)
    if (session.workingDir) lines.push(`| **Working dir** | \`${session.workingDir}\` |`)
    lines.push(`| **Messages** | ${messages.length} |`)
    lines.push(`| **Exported** | ${exportedAt.toLocaleString()} |`)
    lines.push("")
  }

  if (session.systemPrompt) {
    lines.push("## System Prompt")
    lines.push("")
    lines.push("```")
    lines.push(session.systemPrompt)
    lines.push("```")
    lines.push("")
  }

  lines.push("## Conversation")
  lines.push("")
  lines.push("---")
  lines.push("")

  for (const message of messages) {
    lines.push(`### ${roleLabel(message.role)}`)
    lines.push(`<sub>${new Date(message.createdAt).toLocaleString()}</sub>`)
    lines.push("")

    if (includeTokens && message.metadata?.usage) {
      lines.push("<details><summary>Token Usage</summary>")
      lines.push("")
      lines.push("```json")
      lines.push(JSON.stringify(message.metadata.usage, null, 2))
      lines.push("```")
      lines.push("")
      lines.push("</details>")
      lines.push("")
    }

    lines.push(renderMessageParts(message.parts))
    lines.push("")
    lines.push("---")
    lines.push("")
  }

  lines.push("")
  lines.push(`*Exported from Cognia on ${exportedAt.toLocaleString()}*`)
  return lines.join("\n")
}

/** A pretty-printed JSON snapshot — full lossless dump of session + messages. */
export function exportToRichJSON(data: RichExportData): string {
  const { session, messages, exportedAt } = data
  return JSON.stringify(
    {
      version: "cognia-next-1.0",
      exportedAt: exportedAt.toISOString(),
      session,
      messages,
      statistics: {
        totalMessages: messages.length,
        userMessages: messages.filter((m) => m.role === "user").length,
        assistantMessages: messages.filter((m) => m.role === "assistant").length,
        hasToolCalls: messages.some((m) =>
          m.parts.some((p) => p.type.startsWith("tool-") || p.type === "dynamic-tool")
        ),
      },
    },
    null,
    2
  )
}

/** Pure plain-text fallback — strips formatting. Useful for diffing. */
export function exportToPlainText(data: RichExportData): string {
  const { session, messages } = data
  const lines: string[] = [session.title, ""]
  for (const message of messages) {
    lines.push(`[${message.role}] ${new Date(message.createdAt).toLocaleString()}`)
    for (const part of message.parts) {
      const text = textOfPart(part)
      if (text) lines.push(text)
    }
    lines.push("")
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------

function roleLabel(role: string): string {
  switch (role) {
    case "user":
      return "👤 **You**"
    case "assistant":
      return "🤖 **Assistant**"
    case "system":
      return "⚙️ **System**"
    default:
      return `**${role}**`
  }
}

function renderMessageParts(parts: UIMessage["parts"]): string {
  const out: string[] = []
  for (const part of parts) {
    out.push(renderPart(part))
  }
  return out.filter(Boolean).join("\n\n")
}

function renderPart(part: UIMessage["parts"][number]): string {
  // Text & reasoning are the common cases — render verbatim. Tool calls and
  // file parts collapse into <details> blocks so the markdown stays readable.
  if (part.type === "text") {
    return (part as { text: string }).text
  }
  if (part.type === "reasoning") {
    const text = (part as { text: string }).text ?? ""
    const quoted = text.split("\n").join("\n> ")
    return [
      "<details>",
      "<summary>💭 Thinking</summary>",
      "",
      "> " + quoted,
      "",
      "</details>",
    ].join("\n")
  }
  if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
    const tp = part as {
      type: string
      toolCallId?: string
      state?: string
      input?: unknown
      output?: unknown
      errorText?: string
    }
    const name = tp.type === "dynamic-tool" ? "tool" : tp.type.slice("tool-".length)
    const lines: string[] = ["<details>"]
    lines.push(`<summary>🔧 Tool: ${formatToolName(name)} [${tp.state ?? "unknown"}]</summary>`)
    lines.push("")
    if (tp.input !== undefined) {
      lines.push("**Parameters:**")
      lines.push("```json")
      lines.push(safeJSON(tp.input))
      lines.push("```")
    }
    if (tp.output !== undefined) {
      lines.push("")
      lines.push("**Result:**")
      lines.push("```json")
      lines.push(typeof tp.output === "string" ? tp.output : safeJSON(tp.output))
      lines.push("```")
    }
    if (tp.errorText) {
      lines.push("")
      lines.push("**Error:**")
      lines.push(`> ❌ ${tp.errorText}`)
    }
    lines.push("")
    lines.push("</details>")
    return lines.join("\n")
  }
  if (part.type === "file") {
    const fp = part as { url?: string; mediaType?: string; filename?: string }
    const name = fp.filename ?? fp.mediaType ?? "file"
    return fp.url ? `📎 [${name}](${fp.url})` : `📎 ${name}`
  }
  if (part.type === "source-url") {
    const sp = part as { url: string; title?: string }
    return `🔗 [${sp.title ?? sp.url}](${sp.url})`
  }
  if (part.type === "source-document") {
    const sp = part as { title?: string; mediaType?: string }
    return `📄 ${sp.title ?? sp.mediaType ?? "source"}`
  }
  if (part.type === "step-start") {
    return ""
  }
  // Fallback for unknown / data-* parts.
  return ""
}

function textOfPart(part: UIMessage["parts"][number]): string {
  if (part.type === "text" || part.type === "reasoning") {
    return (part as { text?: string }).text ?? ""
  }
  return ""
}

function formatToolName(name: string): string {
  return name
    .split(/[-_]/)
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ")
}

function safeJSON(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
