import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { TerminalHistoryRow } from "@/lib/db/terminal-history"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Pull durable terminal command history from the desktop (ADR-0039 phase 2).
 *
 * Powers the mobile `/me/command-history` browse/search viewer. The phone has
 * no shell, so `terminalHistory` is authored solely by the desktop terminal
 * spawn-orchestrator — this is a one-way, read-only mirror. Re-running a
 * command bumps the row's `ts` on the desktop, so it re-crosses the wire and
 * `bulkPut` overwrites in place (the desktop projector cursors on `ts`; see
 * `readTerminalHistoryDelta`).
 */
export function syncTerminalHistory(
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return runSyncHandler<TerminalHistoryRow>(
    {
      table: "terminalHistory",
      getTable: () => getDb().terminalHistory,
    },
    transport,
    cursor
  )
}
