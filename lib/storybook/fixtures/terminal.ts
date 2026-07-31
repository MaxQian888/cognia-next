// Storybook-only fixture builders for the integrated terminal UI. These shape the
// store row + completion suggestion value objects the presentational terminal
// components consume — no xterm, no PTY, no live session required.
import type { TerminalSessionRow, TerminalCommandRecord } from "@/stores/terminal/terminal-store"
import type { TerminalCompletionSuggestion } from "@/lib/terminal/completion/types"

let seq = 0

/** A realistic terminal tab/session row. Override fields for status variants. */
export function makeTerminalSession(over: Partial<TerminalSessionRow> = {}): TerminalSessionRow {
  seq += 1
  return {
    id: `term_${seq}`,
    projectId: "proj_story",
    extensionId: null,
    title: "pwsh",
    customTitle: null,
    shell: "pwsh.exe",
    origin: "local",
    status: "idle",
    exitCode: null,
    cwd: "D:/Project/cognia-next",
    createdAt: Date.UTC(2026, 5, 29, 8, 0),
    agentTrusted: false,
    agentSpawner: null,
    promptBoundaries: [],
    lastCommands: [],
    historyOpen: false,
    ...over,
    hostId: over.hostId ?? null,
    controllerId: over.controllerId ?? null,
  }
}

/** A captured past-command record for the history rail. */
export function makeCommandRecord(
  over: Partial<TerminalCommandRecord> = {}
): TerminalCommandRecord {
  return {
    cmd: "pnpm test",
    exitCode: 0,
    endedAt: Date.now() - 45_000,
    ...over,
  }
}

/** A completion suggestion for the ghost text / candidate popup. */
export function makeSuggestion(
  over: Partial<TerminalCompletionSuggestion> = {}
): TerminalCompletionSuggestion {
  return {
    text: "git status",
    source: "history",
    providerId: "builtin:history",
    score: 0.8,
    ...over,
  }
}
