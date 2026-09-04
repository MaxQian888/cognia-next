// Dexie CRUD for the pet's rolling conversation history. Same small
// data-module pattern as `lib/db/pet.ts`. Only completed `talked` turns are
// stored, because proactive speech is skip-memory by design and never lands
// here.
//
// The primary key is a minted string rather than an auto-increment number.
// This table holds the user's own words and the pet's replies, so it is
// encrypted at rest, and the encryption middleware needs a primary key to
// exist before the row is written. An auto-increment key does not exist until
// Dexie has written it, so every append would have thrown.
//
// That is also why the store is named `petConversationV2`. Dexie refuses to
// open a database whose primary key changed, so the move had to drop the old
// `++id` store and create a new one beside it. Conversation history from
// before v220 is not carried over. The table only ever kept a 200-turn rolling
// window of chatter, and the alternative was a database that would not open.

import { getDb } from "./schema"
import type { PetConversationRow } from "@/types/pet"

/** Newest-N turns kept. Older rows are pruned on append. */
export const PET_CONVERSATION_CAP = 200

function newId(): string {
  return "pc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

/** Append one finished talk turn, then prune to the newest `cap` rows. */
export async function appendPetTurn(
  turn: Omit<PetConversationRow, "id">,
  cap = PET_CONVERSATION_CAP
): Promise<string> {
  const db = getDb()
  const row: PetConversationRow = { ...turn, id: newId() }
  return db.transaction("rw", db.petConversationV2, async () => {
    await db.petConversationV2.add(row)
    const count = await db.petConversationV2.count()
    if (count > cap) {
      const overflow = count - cap
      const oldest = await db.petConversationV2.orderBy("at").limit(overflow).primaryKeys()
      if (oldest.length > 0) await db.petConversationV2.bulkDelete(oldest as string[])
    }
    return row.id
  })
}

/** The newest `limit` turns in chronological order (newest LAST). */
export async function listRecentPetTurns(limit: number): Promise<PetConversationRow[]> {
  const rows = await getDb().petConversationV2.orderBy("at").reverse().limit(limit).toArray()
  return rows.reverse()
}

/** Wipe the pet's conversation memory (settings "clear" action). */
export async function clearPetConversation(): Promise<void> {
  await getDb().petConversationV2.clear()
}
