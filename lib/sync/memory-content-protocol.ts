import {
  decryptContentEnvelope,
  encryptContentEnvelope,
  type EncryptedContentEnvelopeV1,
} from "@cognia/rag"

import type { ProfileDekHandle } from "@/lib/rag/profile-dek-store"
import type { Memory } from "@/types/memory/memory"

export const MEMORY_CONTENT_PROTOCOL_VERSION = 1 as const
export const MEMORY_SYNC_PROFILE_ID = "memory-shared"

export type MemorySyncMetadataV1 = Omit<
  Memory,
  | "text"
  | "vectorDocId"
  | "sourceSessionId"
  | "sourceMessageId"
  | "sourcePluginId"
  | "supersededById"
>

export interface EncryptedMemorySyncRowV1 {
  id: string
  updatedAt: number
  protocolVersion: 1
  profileId: string
  metadata: MemorySyncMetadataV1
  envelope: EncryptedContentEnvelopeV1
}

function toMetadata(memory: Memory): MemorySyncMetadataV1 {
  const {
    text: _text,
    vectorDocId: _vectorDocId,
    sourceSessionId: _sourceSessionId,
    sourceMessageId: _sourceMessageId,
    sourcePluginId: _sourcePluginId,
    supersededById: _supersededById,
    ...metadata
  } = memory
  return metadata
}

function additionalData(row: {
  id: string
  updatedAt: number
  profileId: string
  metadata: MemorySyncMetadataV1
}): string {
  return JSON.stringify({
    protocolVersion: MEMORY_CONTENT_PROTOCOL_VERSION,
    id: row.id,
    updatedAt: row.updatedAt,
    profileId: row.profileId,
    metadata: row.metadata,
  })
}

export async function createMemorySyncRowV1(
  memory: Memory,
  dek: ProfileDekHandle
): Promise<EncryptedMemorySyncRowV1> {
  if (dek.profileId !== MEMORY_SYNC_PROFILE_ID) {
    throw new Error("Memory sync requires the shared memory profile DEK")
  }
  const metadata = toMetadata(memory)
  const identity = {
    id: memory.id,
    updatedAt: memory.updatedAt,
    profileId: dek.profileId,
    metadata,
  }
  return {
    ...identity,
    protocolVersion: MEMORY_CONTENT_PROTOCOL_VERSION,
    envelope: await encryptContentEnvelope(memory.text, {
      key: dek.key,
      keyId: dek.keyId,
      additionalData: additionalData(identity),
    }),
  }
}

export async function openMemorySyncRowV1(
  row: EncryptedMemorySyncRowV1,
  key: CryptoKey
): Promise<Memory> {
  if (row.protocolVersion !== MEMORY_CONTENT_PROTOCOL_VERSION) {
    throw new Error("upgrade_required: unsupported memory content protocol")
  }
  if (row.profileId !== MEMORY_SYNC_PROFILE_ID || row.id !== row.metadata.id) {
    throw new Error("Memory sync row identity mismatch")
  }
  const text = await decryptContentEnvelope(row.envelope, {
    key,
    additionalData: additionalData(row),
  })
  return { ...row.metadata, text }
}
