// Snapshot for the external-agent registry persisted at
// `localStorage["cognia-external-agents"]` (Zustand persist v5). This carries
// every agent the user has wired up — ClaudeCode, Cursor, Cline, Codex,
// Gemini, Roo Code, VS Code, Windsurf, Claude Desktop — so that a "backup →
// restore" round-trip leaves them all intact.

import { createGenericSnapshotModule } from "./factory"

export const EXTERNAL_AGENTS_PERSIST_KEY = "cognia-external-agents"
export const EXTERNAL_AGENTS_LABEL_KEY = "externalAgents"

/** Persist version expected by the live store. Imported indirectly via
 * `createGenericSnapshotModule` so we can detect drift in the migrate hook. */
export const EXTERNAL_AGENTS_STORE_VERSION = 5

export const externalAgentsSnapshot = createGenericSnapshotModule({
  key: EXTERNAL_AGENTS_PERSIST_KEY,
  labelKey: EXTERNAL_AGENTS_LABEL_KEY,
  exposeAsDomain: true,
  // The backup is large (validity maps, benchmark snapshots, lastRunSnapshots
  // include timestamps) but well under 1MB. Warn anyway if anything explodes.
  maxBytesWarn: 1_500_000,
})
