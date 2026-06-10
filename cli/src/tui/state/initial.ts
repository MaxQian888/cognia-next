/**
 * Initial-state factory for the TUI reducer. Pure: no environment reads, no
 * clock — the caller passes `sessionId` and `config`.
 */
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
    turnStatus: "idle",
    exit: false,
    seq: 0,
  }
}
