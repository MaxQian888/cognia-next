import { createMemorySyncRowV1, openMemorySyncRowV1 } from "./memory-content-protocol"
import type { Memory } from "@/types/memory/memory"

async function key() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
}

function memory(): Memory {
  return {
    id: "memory-1",
    scope: "workspace",
    projectId: "project-1",
    type: "semantic",
    text: "The private canonical statement.",
    tags: ["preference"],
    importance: 8,
    createdAt: 1,
    updatedAt: 2,
    lastAccessedAt: 3,
    accessCount: 4,
    version: 5,
    status: "active",
    pinned: true,
    provenance: "user",
    confidence: 0.8,
    sensitivity: "sensitive",
  }
}

it("serializes memory sync as metadata plus ciphertext without canonical text", async () => {
  const row = await createMemorySyncRowV1(memory(), {
    profileId: "memory-shared",
    keyId: "dek-1",
    key: await key(),
  })
  const serialized = JSON.stringify(row)

  expect(row.protocolVersion).toBe(1)
  expect(row.metadata).not.toHaveProperty("text")
  expect(row.metadata).not.toHaveProperty("vectorDocId")
  expect(serialized).not.toContain("private canonical")
  expect(row.envelope).toMatchObject({ algorithm: "AES-256-GCM", keyId: "dek-1" })
})

it("decrypts only with the matching profile DEK and rejects metadata tampering", async () => {
  const cryptoKey = await key()
  const row = await createMemorySyncRowV1(memory(), {
    profileId: "memory-shared",
    keyId: "dek-1",
    key: cryptoKey,
  })

  await expect(openMemorySyncRowV1(row, cryptoKey)).resolves.toMatchObject({
    id: "memory-1",
    text: "The private canonical statement.",
    projectId: "project-1",
  })
  await expect(
    openMemorySyncRowV1({ ...row, metadata: { ...row.metadata, updatedAt: 99 } }, cryptoKey)
  ).rejects.toBeDefined()
  await expect(openMemorySyncRowV1(row, await key())).rejects.toBeDefined()
})
