import { joinPath } from "@/lib/claude/instructions/paths"

import { createPortableAgentSessionSource } from "./portable-agent-source"

/** Qwen Code official JSON/JSONL exports and local session-service artifacts. */
export const qwenCodeSessionSource = createPortableAgentSessionSource({
  id: "qwen-code",
  displayName: "Qwen Code",
  verifiedVersion: "0.16-alpha",
  presetId: "qwen-code",
  acceptedExtensions: [".json", ".jsonl"],
  roots: (home) => (home ? [joinPath(home, ".qwen/sessions"), joinPath(home, ".qwen/tmp")] : []),
  pathHints: ["/.qwen/", "\\.qwen\\"],
  contentHints: ["qwen", "qwen-code"],
  defaultTitle: "Qwen Code session",
})
