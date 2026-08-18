import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import { pendingOverrideConversationKeys } from "@/lib/connectors/inbox-writes/pending-overrides"
import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Apply pulled override rows, SKIPPING any conversation that has an in-flight
 * relayed mutation from this client (ADR-0131). The client wrote that row
 * optimistically and shipped the authoritative change through the durable
 * queue; a delta that predates the host applying it would revert the UI for
 * a second. Once the queue row is `sent`, the key drops out of the pending
 * set and the host's (newer) row lands on the next pull.
 */
export async function applyConversationOverrideRows(
  rows: ConversationOverrideRow[]
): Promise<void> {
  const pending = await pendingOverrideConversationKeys()
  const writable = pending.size === 0 ? rows : rows.filter((row) => !pending.has(row.conversationKey))
  if (writable.length > 0) await getDb().conversationOverrides.bulkPut(writable)
}

export function syncConversationOverrides(
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return runSyncHandler<ConversationOverrideRow>(
    {
      table: "conversationOverrides",
      getTable: () => getDb().conversationOverrides,
      applyRows: applyConversationOverrideRows,
    },
    transport,
    cursor
  )
}
