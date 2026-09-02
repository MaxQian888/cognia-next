/**
 * Saved chat templates to paired clients (ADR-0027).
 *
 * The `/` menu in the mobile composer offers whatever `listChatTemplates()`
 * finds in the local Dexie, and nothing ever filled that table on a phone: a
 * template saved on the desktop was simply not there, on the one surface a
 * thin client spends all its time in. This handler is the whole difference.
 * The reader on the Host is `readChatTemplatesDelta` in
 * `desktop-sync-source.ts`, and the composer needs no change at all.
 *
 * Host-authoritative and read-only, like every other companion table: the
 * phone applies rows and tombstones, and a template CREATED on the phone is
 * still a local row the Host never learns about. Editing across the wire would
 * need a mutating RPC, which is a different piece of work.
 *
 * Cursored on `updatedAt` (indexed, stamped by `createChatTemplate` and
 * `updateChatTemplate`). `recordChatTemplateUse` deliberately does NOT stamp
 * it: usage counters change on every send and carry nothing the phone renders
 * differently, so leaving them out of the cursor keeps a chatty write off the
 * wire entirely.
 *
 * Deletion rides a tombstone rather than ageing out. A template the user
 * deleted must stop being offered, and an offer that inserts text is not
 * something a stale mirror gets to keep making.
 */

import { getDb } from "@/lib/db/schema"
import type { ChatTemplateRow } from "@/lib/db/chat-templates"
import type { Transport } from "@/lib/tauri/transport-types"
import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

export function syncChatTemplates(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<ChatTemplateRow>(
    {
      table: "chatTemplates",
      getTable: () => getDb().chatTemplates,
    },
    transport,
    cursor
  )
}
