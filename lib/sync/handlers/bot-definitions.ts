/**
 * `botDefinitions` companion sync handler.
 *
 * Full rows, because every field of a definition is already rendered on
 * `/bots` and none of them is a secret: a definition names an executor, a set
 * of triggers, a policy ceiling and the credential SLOTS it needs, never a
 * credential.
 *
 * Only the definitions a person wrote are in this table. A plugin's live in
 * the bot registry overlay, which `bots-bridge.ts` fills on enable, so a
 * mirrored device resolves a plugin Bot from its own plugin state or reads it
 * as an orphan. That is the honest answer, and it is why the console keeps an
 * orphan visible instead of dropping the row.
 */

import { getDb } from "@/lib/db/schema"
import type { BotDefinitionRow } from "@/lib/db/bot-types"
import type { Transport } from "@/lib/tauri/transport-types"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

export function syncBotDefinitions(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<BotDefinitionRow>(
    {
      table: "botDefinitions",
      getTable: () => getDb().botDefinitions,
    },
    transport,
    cursor
  )
}
