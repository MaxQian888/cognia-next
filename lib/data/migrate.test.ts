// Coverage for the v1 → v3 migration boundary. The migrator must:
//   • detect EncryptedEnvelopeV1 and throw IsEncryptedError
//   • accept v3 packages and validate the integrity checksum
//   • wrap v1 envelopes in a synthetic v3 manifest
//   • reject anything else with UnsupportedSchemaVersionError

import { sha256Hex } from "./crypto"
import { migrateEnvelope, canonicalStringify, isEncryptedEnvelope, __TESTING__ } from "./migrate"
import {
  IntegrityCheckFailedError,
  IsEncryptedError,
  UnsupportedSchemaVersionError,
  type BackupPackageV3,
  type BackupPayloadV3,
  type EncryptedEnvelopeV1,
} from "./types"

describe("canonicalStringify", () => {
  it("sorts keys recursively and is stable for equivalent objects", () => {
    const a = canonicalStringify({ b: 1, a: { y: 2, x: 1 }, c: [3, { d: 4, c: 3 }] })
    const b = canonicalStringify({ a: { x: 1, y: 2 }, c: [3, { c: 3, d: 4 }], b: 1 })
    expect(a).toBe(b)
  })

  it("preserves array order (arrays are not key-collections)", () => {
    expect(canonicalStringify([3, 1, 2])).toBe("[3,1,2]")
  })

  it("handles primitives and null", () => {
    expect(canonicalStringify(null)).toBe("null")
    expect(canonicalStringify(7)).toBe("7")
    expect(canonicalStringify("x")).toBe('"x"')
  })
})

describe("isEncryptedEnvelope", () => {
  it("matches the enc-v1 shape", () => {
    expect(
      isEncryptedEnvelope({
        version: "enc-v1",
        ciphertext: "abc",
        kdf: { algorithm: "PBKDF2" },
      })
    ).toBe(true)
  })
  it("rejects anything missing required fields", () => {
    expect(isEncryptedEnvelope(null)).toBe(false)
    expect(isEncryptedEnvelope({ version: "enc-v1" })).toBe(false)
    expect(isEncryptedEnvelope({ version: "3.0", ciphertext: "x", kdf: {} })).toBe(false)
  })
})

describe("migrateEnvelope", () => {
  it("returns a v3 package when given a valid v3 input with matching checksum", async () => {
    const payload: BackupPayloadV3 = { settings: undefined, characters: [] }
    const checksum = await sha256Hex(canonicalStringify(payload))
    const pkg: BackupPackageV3 = {
      version: "3.0",
      manifest: {
        version: "3.0",
        schemaVersion: 3,
        traceId: "t-1",
        exportedAt: "2024-01-01T00:00:00.000Z",
        appVersion: "0.1.0",
        backend: "web-dexie",
        integrity: { algorithm: "SHA-256", checksum },
      },
      payload,
    }
    const out = await migrateEnvelope(pkg)
    expect(out).toBe(pkg)
  })

  it("accepts manifests with and without the optional device provenance", async () => {
    // Pre-2026-06 files have no `manifest.device`; newer files do. Both must
    // validate identically — the checksum covers the payload only, and the
    // shape guard checks version fields only (no schemaVersion bump).
    const payload: BackupPayloadV3 = { settings: undefined, characters: [] }
    const checksum = await sha256Hex(canonicalStringify(payload))
    const base: BackupPackageV3 = {
      version: "3.0",
      manifest: {
        version: "3.0",
        schemaVersion: 3,
        traceId: "t-dev",
        exportedAt: "2024-01-01T00:00:00.000Z",
        appVersion: "0.1.0",
        backend: "web-dexie",
        integrity: { algorithm: "SHA-256", checksum },
      },
      payload,
    }
    await expect(migrateEnvelope(base)).resolves.toBe(base)

    const withDevice: BackupPackageV3 = {
      ...base,
      manifest: {
        ...base.manifest,
        device: { id: "dev-1", label: "Windows desktop", platform: "desktop" },
      },
    }
    const out = await migrateEnvelope(withDevice)
    expect(out.manifest.device).toEqual({
      id: "dev-1",
      label: "Windows desktop",
      platform: "desktop",
    })
  })

  it("throws IntegrityCheckFailedError when the v3 checksum is wrong", async () => {
    const payload: BackupPayloadV3 = { characters: [{ id: "c1" } as never] }
    const pkg: BackupPackageV3 = {
      version: "3.0",
      manifest: {
        version: "3.0",
        schemaVersion: 3,
        traceId: "t-2",
        exportedAt: "2024-01-01T00:00:00.000Z",
        appVersion: "0.1.0",
        backend: "web-dexie",
        integrity: { algorithm: "SHA-256", checksum: "0".repeat(64) },
      },
      payload,
    }
    await expect(migrateEnvelope(pkg)).rejects.toBeInstanceOf(IntegrityCheckFailedError)
  })

  it("wraps a legacy v1 envelope as a v3 package and synthesizes a manifest", async () => {
    const v1 = {
      schemaVersion: 1,
      exportedAt: 1_700_000_000_000,
      appVersion: "0.0.9",
      promptPresets: [{ id: "p1", name: "x", content: "y", createdAt: 1, updatedAt: 1 }],
    }
    const out = await migrateEnvelope(v1)
    expect(out.version).toBe("3.0")
    expect(out.manifest.schemaVersion).toBe(3)
    expect(out.manifest.appVersion).toBe("0.0.9")
    expect(out.manifest.exportedAt).toBe(new Date(v1.exportedAt).toISOString())
    expect(out.payload.promptPresets).toEqual(v1.promptPresets)
    // Checksum is now valid for the freshly built payload.
    const expectedChecksum = await sha256Hex(canonicalStringify(out.payload))
    expect(out.manifest.integrity.checksum).toBe(expectedChecksum)
  })

  it("falls back to a numeric appVersion default when missing on v1", async () => {
    const out = await migrateEnvelope({ schemaVersion: 1, exportedAt: 0 })
    expect(out.manifest.appVersion).toBe("0.0.0")
  })

  it("throws IsEncryptedError when given an encrypted envelope", async () => {
    const env: EncryptedEnvelopeV1 = {
      version: "enc-v1",
      algorithm: "AES-GCM",
      kdf: { algorithm: "PBKDF2", hash: "SHA-256", iterations: 1, salt: "s" },
      iv: "iv",
      ciphertext: "ct",
      manifest: {
        version: "3.0",
        schemaVersion: 3,
        traceId: "t",
        exportedAt: "2024-01-01T00:00:00.000Z",
        appVersion: "0.1.0",
        backend: "web-dexie",
      },
      checksum: "x",
    }
    try {
      await migrateEnvelope(env)
      fail("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(IsEncryptedError)
      expect((err as IsEncryptedError).envelope).toBe(env)
    }
  })

  it("throws UnsupportedSchemaVersionError on completely foreign input", async () => {
    await expect(migrateEnvelope({ schemaVersion: 99 })).rejects.toBeInstanceOf(
      UnsupportedSchemaVersionError
    )
    await expect(migrateEnvelope("not json")).rejects.toBeInstanceOf(UnsupportedSchemaVersionError)
    await expect(migrateEnvelope(null)).rejects.toBeInstanceOf(UnsupportedSchemaVersionError)
  })

  it("rejects v3 packages with the wrong outer version field", async () => {
    const pkg = {
      version: "2.0",
      manifest: { schemaVersion: 3, version: "3.0", integrity: { checksum: "x" } },
      payload: {},
    }
    await expect(migrateEnvelope(pkg)).rejects.toBeInstanceOf(UnsupportedSchemaVersionError)
  })
})

describe("internal helpers (smoke)", () => {
  it("isExportEnvelopeV1 / isBackupPackageV3 differentiate shapes", () => {
    expect(__TESTING__.isExportEnvelopeV1({ schemaVersion: 1 })).toBe(true)
    expect(__TESTING__.isExportEnvelopeV1({ schemaVersion: 2 })).toBe(false)
    expect(__TESTING__.isBackupPackageV3({ version: "3.0", manifest: {}, payload: {} })).toBe(false)
    expect(
      __TESTING__.isBackupPackageV3({
        version: "3.0",
        manifest: { schemaVersion: 3, version: "3.0" },
        payload: {},
      })
    ).toBe(true)
  })
})
