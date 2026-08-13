import { canonicalStringify } from "./migrate"
import { sha256Hex } from "./crypto"
import { attachPortableRetrievalKeys, importPortableRetrievalKeys } from "./retrieval-key-backup"
import type { BackupPackageV3 } from "./types"

function pkg(): BackupPackageV3 {
  return {
    version: "3.0",
    manifest: {
      version: "3.0",
      schemaVersion: 3,
      traceId: "trace",
      exportedAt: "2026-08-13T00:00:00.000Z",
      appVersion: "test",
      backend: "web-dexie",
      integrity: { algorithm: "SHA-256", checksum: "stale" },
    },
    payload: {},
  }
}

describe("portable retrieval keys in backups", () => {
  it("wraps every provisioned profile and recomputes package integrity", async () => {
    const envelopes = [
      {
        version: 1 as const,
        profileId: "memory-shared",
        keyId: "dek-memory",
        encryption: {
          enabled: true as const,
          format: "aes-gcm-chunks-v1" as const,
          algorithm: "AES-GCM" as const,
          kdf: {
            algorithm: "PBKDF2" as const,
            hash: "SHA-256" as const,
            iterations: 600_000,
            salt: "salt",
          },
          noncePrefix: "iv",
        },
        ciphertext: "ciphertext",
      },
    ]
    const store = {
      listProfileIds: jest.fn(async () => ["memory-shared"]),
      exportPortable: jest.fn(async () => envelopes[0]),
    }

    const next = await attachPortableRetrievalKeys(pkg(), "backup-passphrase", store)

    expect(store.listProfileIds).toHaveBeenCalledWith(["chat-shared", "memory-shared"])
    expect(store.exportPortable).toHaveBeenCalledWith("memory-shared", "backup-passphrase")
    expect(next.payload.retrievalProfileDeks).toEqual(envelopes)
    expect(next.manifest.integrity.checksum).toBe(await sha256Hex(canonicalStringify(next.payload)))
  })

  it("fails closed without a passphrase and delegates batch import without replacing active keys", async () => {
    const envelope = {
      version: 1 as const,
      profileId: "chat-shared",
      keyId: "dek-chat",
      encryption: {
        enabled: true as const,
        format: "aes-gcm-chunks-v1" as const,
        algorithm: "AES-GCM" as const,
        kdf: {
          algorithm: "PBKDF2" as const,
          hash: "SHA-256" as const,
          iterations: 600_000,
          salt: "salt",
        },
        noncePrefix: "iv",
      },
      ciphertext: "ciphertext",
    }
    const store = { importPortableBatch: jest.fn(async () => undefined) }

    await expect(importPortableRetrievalKeys([envelope], "", store)).rejects.toThrow(
      "backup passphrase"
    )
    await importPortableRetrievalKeys([envelope], "backup-passphrase", store)
    expect(store.importPortableBatch).toHaveBeenCalledWith([envelope], "backup-passphrase", {
      activate: "if-missing",
    })
  })
})
