import { joinPath } from "@/lib/claude/instructions/paths"

import { createPortableAgentSessionSource } from "./portable-agent-source"

/** Cursor local history and explicit exports. Cloud/background history is intentionally not fetched. */
export const cursorSessionSource = createPortableAgentSessionSource({
  id: "cursor",
  displayName: "Cursor",
  verifiedVersion: "1.7",
  presetId: "cursor-cli",
  acceptedExtensions: [".json", ".jsonl", ".md"],
  roots: (home) =>
    home
      ? [
          joinPath(home, ".cursor/chats"),
          joinPath(home, ".cursor/subagents"),
          joinPath(home, "Library/Application Support/Cursor/User/workspaceStorage"),
          joinPath(home, ".config/Cursor/User/workspaceStorage"),
          joinPath(home, "AppData/Roaming/Cursor/User/workspaceStorage"),
        ]
      : [],
  pathHints: ["/.cursor/", "/cursor/user/workspacestorage/"],
  contentHints: ["cursor", "composer", "bubbleId"],
  storeSource: "cursor",
  defaultTitle: "Cursor session",
  markdown: true,
})
