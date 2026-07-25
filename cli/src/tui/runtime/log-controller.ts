/**
 * Runtime handler for `/logs` — opens the unified log panel.
 *
 * The panel renders straight off the live buffers (`state.logs` merged with a
 * read-time projection of `state.mcpLogs`) and derives its own header summary
 * from them, so there is nothing to load here: opening is a single dispatch.
 */
import type { Dispatch } from "react"

import type { TuiAction } from "../state/types"

export interface LogDeps {
  dispatch: Dispatch<TuiAction>
}

export function logsPanel(deps: LogDeps): void {
  deps.dispatch({ type: "OVERLAY_OPEN", overlay: { kind: "logs" } })
}
