import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { Memory } from "@/types/memory/memory"
import { createProfileDekStore, ProfileDekProtocolError } from "@/lib/rag/profile-dek-store"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"
import { openMemorySyncRowV1, type EncryptedMemorySyncRowV1 } from "../memory-content-protocol"

interface ProfileDekPairingResponseV1 {
  protocolVersion: 1
  profileId: string
  keyId: string
  rawKey: string
}

export const MOBILE_MEMORY_CACHE_LIMIT = 1_000

export async function pruneMobileMemoryCache(limit = MOBILE_MEMORY_CACHE_LIMIT): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Memory cache limit must be positive")
  const rows = await getDb().memories.toArray()
  if (rows.length <= limit) return 0
  rows.sort(
    (left, right) =>
      Number(right.pinned) - Number(left.pinned) ||
      right.lastAccessedAt - left.lastAccessedAt ||
      right.updatedAt - left.updatedAt ||
      left.id.localeCompare(right.id)
  )
  const deleteIds = rows.slice(limit).map((row) => row.id)
  await getDb().memories.bulkDelete(deleteIds)
  return deleteIds.length
}

function decodeBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  }
  return new Uint8Array(Buffer.from(value, "base64"))
}

export async function ensurePairedMemoryDek(
  transport: Transport,
  profileId: string,
  keyId: string,
  store: Pick<
    ReturnType<typeof createProfileDekStore>,
    "load" | "importPaired"
  > = createProfileDekStore()
): Promise<CryptoKey> {
  const existing = await store.load(profileId, keyId)
  if (existing) return existing.key
  const response = await transport.call<ProfileDekPairingResponseV1>(
    "retrieval_profile_dek_export",
    { profileId, contentProtocolVersion: 1 }
  )
  if (
    response.protocolVersion !== 1 ||
    response.profileId !== profileId ||
    response.keyId !== keyId
  ) {
    throw new ProfileDekProtocolError()
  }
  const rawKey = decodeBase64(response.rawKey)
  try {
    await store.importPaired(profileId, keyId, rawKey, {
      authenticated: true,
      protocolVersion: response.protocolVersion,
    })
  } finally {
    rawKey.fill(0)
  }
  const imported = await store.load(profileId, keyId)
  if (!imported) throw new ProfileDekProtocolError()
  return imported.key
}

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
    loadDek: (profileId, keyId) => ensurePairedMemoryDek(transport, profileId, keyId),
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
        await pruneMobileMemoryCache()
      },
    },
    transport,
    cursor
  )
}
