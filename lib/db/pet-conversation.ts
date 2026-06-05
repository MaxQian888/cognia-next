// Dexie CRUD for the pet's rolling conversation history (v77). Same small
// data-module pattern as `lib/db/pet.ts`. Only completed `talked` turns are
// stored — proactive speech is skip-memory by design and never lands here.

import { getDb } from "./schema"
import type { PetConversationRow } from "@/types/pet"

/** Newest-N turns kept; older rows are pruned on append. */
export const PET_CONVERSATION_CAP = 200

/** Append one finished talk turn, then prune to the newest `cap` rows. */
export async function appendPetTurn(
  turn: Omit<PetConversationRow, "id">,
  cap = PET_CONVERSATION_CAP
): Promise<number> {
  const db = getDb()
  return db.transaction("rw", db.petConversation, async () => {
    const id = (await db.petConversation.add(turn as PetConversationRow)) as number
    const count = await db.petConversation.count()
    if (count > cap) {
      const overflow = count - cap
      const oldest = await db.petConversation.orderBy("at").limit(overflow).primaryKeys()
      if (oldest.length > 0) await db.petConversation.bulkDelete(oldest as number[])
    }
    return id
  })
}

/** The newest `limit` turns in chronological order (newest LAST). */
export async function listRecentPetTurns(limit: number): Promise<PetConversationRow[]> {
  const rows = await getDb().petConversation.orderBy("at").reverse().limit(limit).toArray()
  return rows.reverse()
}

/** Wipe the pet's conversation memory (settings "clear" action). */
export async function clearPetConversation(): Promise<void> {
  await getDb().petConversation.clear()
}
