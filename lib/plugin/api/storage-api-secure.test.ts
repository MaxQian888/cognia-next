/** @jest-environment jsdom */
/**
 * setSecure/getSecure with the REAL crypto-helpers (W2.5): per-install key
 * derivation, legacy-blob migration, and SSR failure mode.
 */

import { webcrypto } from "node:crypto"
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from "node:util"

Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  writable: true,
  configurable: true,
})
if (typeof globalThis.TextEncoder === "undefined") {
  Object.defineProperty(globalThis, "TextEncoder", { value: NodeTextEncoder })
}
if (typeof globalThis.TextDecoder === "undefined") {
  Object.defineProperty(globalThis, "TextDecoder", { value: NodeTextDecoder })
}

const mockPassphrase = jest.fn<Promise<string | null>, []>()
jest.mock("@/lib/data/backup-key", () => ({
  getDefaultBackupPassphrase: () => mockPassphrase(),
}))

import { createStorageAPI } from "./storage-api"
import { deriveKey, deriveInstallKey, encrypt, decrypt } from "./crypto-helpers"

const PLUGIN = "secure-plugin"
const STORAGE_KEY = `cognia:plugin:storage:${PLUGIN}:token`

describe("setSecure / getSecure with per-install key", () => {
  beforeEach(() => {
    localStorage.clear()
    mockPassphrase.mockResolvedValue("device-master-key")
  })

  it("round-trips a value under the install key", async () => {
    const api = createStorageAPI(PLUGIN)
    await api.setSecure("token", { secret: "s3cr3t" })
    await expect(api.getSecure("token")).resolves.toEqual({ secret: "s3cr3t" })
  })

  it("does NOT decrypt with the legacy public-id key alone", async () => {
    const api = createStorageAPI(PLUGIN)
    await api.setSecure("token", "value")
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) as string) as string
    const blob = raw.slice("__encrypted:".length)
    const legacyKey = await deriveKey(PLUGIN)
    await expect(decrypt(blob, legacyKey)).rejects.toBeDefined()
  })

  it("migrates a legacy blob to the install key on first read", async () => {
    // Simulate a pre-W2.5 write: encrypted with the public-id key.
    const legacyKey = await deriveKey(PLUGIN)
    const legacyBlob = await encrypt(JSON.stringify("legacy-value"), legacyKey)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(`__encrypted:${legacyBlob}`))

    const api = createStorageAPI(PLUGIN)
    await expect(api.getSecure("token")).resolves.toBe("legacy-value")

    // The stored blob must now decrypt with the install key.
    const migrated = (JSON.parse(localStorage.getItem(STORAGE_KEY) as string) as string).slice(
      "__encrypted:".length
    )
    const installKey = await deriveInstallKey(PLUGIN)
    await expect(decrypt(migrated, installKey)).resolves.toBe(JSON.stringify("legacy-value"))
  })

  it("setSecure throws when no master key is available", async () => {
    mockPassphrase.mockResolvedValue(null)
    const api = createStorageAPI(PLUGIN)
    await expect(api.setSecure("token", "v")).rejects.toThrow(/master key/)
  })
})
