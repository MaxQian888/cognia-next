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
})
