/**
 * Initial-state factory for the TUI reducer. Pure: no environment reads, no
 * clock — the caller passes `sessionId` and `config`.
 */
import { emptySessionTotals } from "../format/usage"
import type { ResolvedConfig } from "../../config/schema"
import type { InputState, TuiState } from "./types"

export function emptyInputState(): InputState {
  return {
    buffer: { lines: [""], cursorRow: 0, cursorCol: 0 },
    history: { entries: [], index: -1, draft: "" },
    pastes: {},
    undo: [],
    redo: [],
  }
}

export function createInitialState(
  config: ResolvedConfig,
  sessionId: string,
  /**
   * Whether `config.cwd` is already trusted. When false the app opens in the
   * `"startup"` phase (welcome banner + trust gate); when true it goes straight
   * to chat. Injected so tests don't read the real `~/.cognia` store.
   */
  trusted = true,
  /**
   * Composer history to seed (oldest → newest), loaded from the persisted store
   * so ↑ recalls lines from previous sessions. Defaults to empty.
   */
  history: string[] = []
): TuiState {
  const input = emptyInputState()
  return {
    sessionId,
    config,
    phase: trusted ? "chat" : "startup",
    cells: [],
    inflight: { text: "", thinking: "", tools: [] },
    overlay: { kind: "none" },
    input: { ...input, history: { ...input.history, entries: history } },
    sessionTotals: emptySessionTotals(),
    modelTotals: {},
    usageHistory: [],
    costHistory: [],
    toolStats: {},
    usageSeenThisTurn: false,
    turnStatus: "idle",
    planCapturedThisTurn: false,
    // Start in expand-all (verbose) mode when the render pref asks for it.
    verbose: config.render?.verboseByDefault === true,
    steerQueue: [],
    renderEpoch: 0,
    exit: false,
    seq: 0,
    streamSeq: 0,
  }
}
