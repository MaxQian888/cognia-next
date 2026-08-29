import { joinPath } from "@/lib/claude/instructions/paths"

import { createPortableAgentSessionSource } from "./portable-agent-source"

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
})
