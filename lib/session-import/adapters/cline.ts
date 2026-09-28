import { joinPath } from "@/lib/claude/instructions/paths"

import { createPortableAgentSessionSource } from "./portable-agent-source"

/** Cline SDK session artifacts plus the legacy task-folder layout. */
export const clineSessionSource = createPortableAgentSessionSource({
  id: "cline",
  displayName: "Cline",
  verifiedVersion: "3.38",
  acceptedExtensions: [".json", ".jsonl"],
  roots: (home) =>
    home
      ? [
          joinPath(home, ".cline/sessions"),
          joinPath(home, ".cline/data"),
          joinPath(
            home,
            "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev"
          ),
          joinPath(home, ".config/Code/User/globalStorage/saoudrizwan.claude-dev"),
          joinPath(home, "AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev"),
        ]
      : [],
  pathHints: ["/.cline/", "saoudrizwan.claude-dev"],
  contentHints: ["cline", "api_conversation_history", "isSubagent"],
  storeSource: "cline",
  defaultTitle: "Cline session",
  normalizeDocument: (document, locatorSessionId) => {
    if (!document || typeof document !== "object" || Array.isArray(document)) return [document]
    const root = document as Record<string, unknown>
    const raw = root.messages ?? root.events
    if (!Array.isArray(raw)) return [document]
    const isNative =
      locatorSessionId.endsWith(".messages") ||
      raw.some((item) => item && typeof item === "object" && "ts" in item)
    if (!isNative) return [document]
    return [
      {
        ...root,
        sessionId:
          root.sessionId ??
          root.session_id ??
          root.conversationId ??
          root.id ??
          locatorSessionId.replace(/\.messages$/, ""),
        messages: raw.map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return item
          const value = item as Record<string, unknown>
          return { ...value, timestamp: value.timestamp ?? value.ts }
        }),
      },
    ]
  },
})
