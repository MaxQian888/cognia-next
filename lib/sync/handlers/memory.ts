import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { Memory } from "@/types/memory/memory"
import { createProfileDekStore, ProfileDekProtocolError } from "@/lib/rag/profile-dek-store"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"
import { openMemorySyncRowV1, type EncryptedMemorySyncRowV1 } from "../memory-content-protocol"

/**
 * Pull long-term `memories` from the desktop so the mobile companion can show
 * recalled memories offline. Read-mostly mirror — memories are written by the
 * desktop consolidation path; the phone only displays them.
 */
export function syncMemories(
  transport: Transport,
  cursor: SyncCursor,
  deps: {
    loadDek: (profileId: string, keyId: string) => Promise<CryptoKey | null>
  } = {
    loadDek: async (profileId, keyId) =>
      (await createProfileDekStore().load(profileId, keyId))?.key ?? null,
  }
): Promise<SyncOutcome> {
  return runSyncHandler<EncryptedMemorySyncRowV1>(
    {
      table: "memories",
      getTable: () => getDb().memories as never,
      applyRows: async (rows) => {
        const memories: Memory[] = []
        for (const row of rows) {
          const key = await deps.loadDek(row.profileId, row.envelope.keyId)
          if (!key) throw new ProfileDekProtocolError()
          memories.push(await openMemorySyncRowV1(row, key))
        }
        await getDb().memories.bulkPut(memories)
      },
    },
    transport,
    cursor
  )
}
