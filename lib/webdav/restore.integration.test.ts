/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createProfileDekStore } from "@/lib/rag/profile-dek-store"
import { attachPortableRetrievalKeys } from "@/lib/data/retrieval-key-backup"
import { decryptBackupPackage, encryptBackupPackage, sha256Hex } from "@/lib/data/crypto"
import { migrateEnvelope, canonicalStringify } from "@/lib/data/migrate"
import { restoreFromWebDav } from "@/lib/webdav/restore"
import type { BackupPackageV3, BackupPayloadV3 } from "@/lib/data/types"

// Keep the real DEK codec/importer; isolate only its persistent key store and
// vault-unlock boundary so this integration test never uses live credentials.
jest.mock("@/lib/rag/profile-dek-store", () => {
  const actual = jest.requireActual("@/lib/rag/profile-dek-store")
  const values = new Map<string, string>()
  return {
    ...actual,
    createProfileDekStore: (dependencies?: unknown) =>
      actual.createProfileDekStore(
        dependencies ?? {
          secretStore: {
            isPersistent: () => true,
            save: async (key: string, value: string) => void values.set(key, value),
            load: async (key: string) => values.get(key) ?? null,
            delete: async (key: string) => void values.delete(key),
          },
          requireUnlocked: () => true,
        }
      ),
  }
})

let remoteBody = ""
const getFile = jest.fn(async (..._args: unknown[]) => remoteBody)
jest.mock("@/lib/webdav/config", () => ({
  makeWebDavClient: async () => ({
    client: { getFile: (...args: unknown[]) => getFile(...args) },
    config: { remoteDir: "/audit-backups" },
  }),
}))

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

function memoryDekStore() {
  const values = new Map<string, string>()
  return createProfileDekStore({
    secretStore: {
      isPersistent: () => true,
      save: async (key, value) => void values.set(key, value),
      load: async (key) => values.get(key) ?? null,
      delete: async (key) => void values.delete(key),
    },
    requireUnlocked: () => true,
  })
}

function makePackage(payload: BackupPayloadV3 = {}): BackupPackageV3 {
  return {
    version: "3.0",
    manifest: {
      version: "3.0",
      schemaVersion: 3,
      traceId: "audit-webdav-retrieval-restore",
      exportedAt: "2026-10-21T00:00:00.000Z",
      appVersion: "audit",
      backend: "web-dexie",
      integrity: { algorithm: "SHA-256", checksum: "recomputed-by-attachment" },
    },
    payload,
  }
}

test("WebDAV recovery restores a valid encrypted snapshot carrying portable retrieval keys", async () => {
  const passphrase = "isolated-audit-passphrase"
  const source = memoryDekStore()
  const original = await source.getOrCreate("memory-shared")
  const base = makePackage()
  const pkg = await attachPortableRetrievalKeys(base, passphrase, source)
  expect(pkg.payload.retrievalProfileDeks).toHaveLength(1)
  const envelope = await encryptBackupPackage(JSON.stringify(pkg), passphrase, pkg.manifest)
  remoteBody = JSON.stringify(envelope)

  // Prove both encryption layers and the package checksum are valid first.
  const decoded = await migrateEnvelope(
    JSON.parse(await decryptBackupPackage(envelope, passphrase))
  )
  const target = memoryDekStore()
  await target.importPortableBatch(decoded.payload.retrievalProfileDeks!, passphrase, {
    activate: "if-missing",
  })
  await expect(target.load("memory-shared", original.keyId)).resolves.toMatchObject({
    keyId: original.keyId,
  })

  const before = await getDb().sessions.count()
  const result = await restoreFromWebDav({ passphrase, mergeStrategy: "overwrite" })
  expect(result.summary.restoredRetrievalKeyProfiles).toEqual(["memory-shared"])
  await expect(
    createProfileDekStore().load("memory-shared", original.keyId)
  ).resolves.toMatchObject({ keyId: original.keyId })
  expect(getFile).toHaveBeenCalledWith("/audit-backups/latest.enc.cbk")
  expect(await getDb().sessions.count()).toBe(before)
})

test("WebDAV refuses a wrong outer passphrase without writing content", async () => {
  const base = makePackage()
  remoteBody = JSON.stringify(
    await encryptBackupPackage(JSON.stringify(base), "correct", base.manifest)
  )
  const before = await getDb().sessions.count()
  await expect(
    restoreFromWebDav({ passphrase: "wrong", mergeStrategy: "overwrite" })
  ).rejects.toThrow()
  expect(await getDb().sessions.count()).toBe(before)
})

test("a mismatched nested retrieval passphrase rejects before restoring content", async () => {
  const source = memoryDekStore()
  await source.getOrCreate("memory-wrong-nested")
  const base = makePackage({
    sessions: [
      { id: "must-not-import", kind: "direct", title: "Uncommitted", createdAt: 1, updatedAt: 1 },
    ],
  })
  const pkg = await attachPortableRetrievalKeys(base, "nested-other-passphrase", source)
  remoteBody = JSON.stringify(
    await encryptBackupPackage(JSON.stringify(pkg), "outer-passphrase", pkg.manifest)
  )
  await expect(
    restoreFromWebDav({ passphrase: "outer-passphrase", mergeStrategy: "overwrite" })
  ).rejects.toThrow()
  expect(await getDb().sessions.get("must-not-import")).toBeUndefined()
})

test("WebDAV still restores encrypted legacy packages without portable retrieval keys", async () => {
  const base = makePackage({
    sessions: [
      { id: "legacy-recovery", kind: "direct", title: "Legacy", createdAt: 1, updatedAt: 1 },
    ],
  })
  base.manifest.integrity.checksum = await sha256Hex(canonicalStringify(base.payload))
  remoteBody = JSON.stringify(
    await encryptBackupPackage(JSON.stringify(base), "legacy-passphrase", base.manifest)
  )
  const restored = await restoreFromWebDav({
    passphrase: "legacy-passphrase",
    mergeStrategy: "overwrite",
  })
  expect(restored.summary.restoredRetrievalKeyProfiles).toEqual([])
  expect(await getDb().sessions.get("legacy-recovery")).toMatchObject({ title: "Legacy" })
})
