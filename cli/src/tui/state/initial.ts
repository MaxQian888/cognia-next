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
  }
}

export function createInitialState(config: ResolvedConfig, sessionId: string): TuiState {
  return {
    sessionId,
    config,
    cells: [],
    inflight: { text: "", thinking: "" },
    overlay: { kind: "none" },
    input: emptyInputState(),
    sessionTotals: emptySessionTotals(),
    usageSeenThisTurn: false,
    turnStatus: "idle",
    exit: false,
    seq: 0,
  }
}
