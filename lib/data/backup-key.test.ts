/** @jest-environment jsdom */
// Behavior of the auto-key fallback. We test both the web (localStorage) path
// and the desktop branch's resilience when the plugin isn't loaded — the
// __mocks__/tauri-plugin-store.js shim returns null from `get`, so the code
// path that *generates* a fresh key is exercised even without a real store.

const headlessState = { enabled: false }
const transportCall = jest.fn()

jest.mock("@/lib/platform/detect", () => ({
  isHeadlessHost: () => headlessState.enabled,
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
  transport: { call: (...args: unknown[]) => transportCall(...args) },
}))

import {
  getDefaultBackupPassphrase,
  rotateBackupKey,
  clearBackupKey,
  __TESTING__,
  getInstallEncryptionPassphrase,
} from "./backup-key"

import { deriveInstallKey, encrypt, decrypt } from "@/lib/plugin/api/crypto-helpers"

const { WEB_BACKUP_KEY_STORAGE } = __TESTING__

beforeEach(() => {
  localStorage.clear()
  headlessState.enabled = false
  transportCall.mockReset()
})

describe("getDefaultBackupPassphrase", () => {
  it("generates and persists a fresh key on first call (web)", async () => {
    expect(localStorage.getItem(WEB_BACKUP_KEY_STORAGE)).toBeNull()
    const key = await getDefaultBackupPassphrase()
    expect(key).toBeTruthy()
    expect(localStorage.getItem(WEB_BACKUP_KEY_STORAGE)).toBe(key)
  })

  it("returns the same key on subsequent calls", async () => {
    const a = await getDefaultBackupPassphrase()
    const b = await getDefaultBackupPassphrase()
    expect(a).toBe(b)
  })

  it("produces a long, high-entropy key (UUID + nanoid suffix)", async () => {
    const key = await getDefaultBackupPassphrase()
    expect(key?.length).toBeGreaterThan(40)
  })
})

describe("rotateBackupKey", () => {
  it("replaces the stored key with a fresh value", async () => {
    const original = await getDefaultBackupPassphrase()
    const rotated = await rotateBackupKey()
    expect(rotated).toBeTruthy()
    expect(rotated).not.toBe(original)
    const next = await getDefaultBackupPassphrase()
    expect(next).toBe(rotated)
  })

  it("rotated value persists across reads", async () => {
    const a = await rotateBackupKey()
    const b = await rotateBackupKey()
    expect(a).not.toBe(b)
    expect(await getDefaultBackupPassphrase()).toBe(b)
  })
})

describe("clearBackupKey", () => {
  it("removes the stored key so the next read regenerates", async () => {
    const before = await getDefaultBackupPassphrase()
    expect(before).toBeTruthy()
    await clearBackupKey()
    expect(localStorage.getItem(WEB_BACKUP_KEY_STORAGE)).toBeNull()
    const after = await getDefaultBackupPassphrase()
    expect(after).toBeTruthy()
    expect(after).not.toBe(before)
  })

  it("is a no-op when nothing is stored", async () => {
    await expect(clearBackupKey()).resolves.toBeUndefined()
  })
})

describe("headless server auto-key", () => {
  beforeEach(() => {
    headlessState.enabled = true
  })

  function statefulSecrets(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial))
    const faults = { failInstallWrite: false }
    transportCall.mockImplementation(
      async (command: string, { input }: { input: { key: string; value?: string } }) => {
        if (command === "secret_store_get") return values.get(input.key) ?? null
        if (command === "secret_store_set") {
          if (faults.failInstallWrite && input.key === __TESTING__.INSTALL_KEY)
            throw new Error("secret store unavailable")
          values.set(input.key, input.value!)
        }
        if (command === "secret_store_delete") values.delete(input.key)
        return undefined
      }
    )
    return { values, faults }
  }

  it("preserves legacy headless ciphertext across repeated rotation", async () => {
    const { values } = statefulSecrets()
    const legacy = await getDefaultBackupPassphrase()
    const ciphertext = await encrypt(
      "headless stored value",
      await deriveInstallKey("headless-plugin")
    )
    await rotateBackupKey()
    await rotateBackupKey()
    expect(values.get(__TESTING__.INSTALL_KEY)).toBe(legacy)
    expect(await getDefaultBackupPassphrase()).not.toBe(legacy)
    await expect(decrypt(ciphertext, await deriveInstallKey("headless-plugin"))).resolves.toBe(
      "headless stored value"
    )
    expect(localStorage.length).toBe(0)
  })

  it("fails closed before rotating when the headless install root cannot be saved", async () => {
    const { values, faults } = statefulSecrets({
      [__TESTING__.SERVER_SECRET_KEY]: "legacy-headless-root",
    })
    faults.failInstallWrite = true
    await expect(rotateBackupKey()).rejects.toThrow("secret store unavailable")
    expect(values.get(__TESTING__.SERVER_SECRET_KEY)).toBe("legacy-headless-root")
    expect(values.has(__TESTING__.INSTALL_KEY)).toBe(false)
  })

  it("prefers an existing independent headless install root", async () => {
    const { values } = statefulSecrets({
      [__TESTING__.SERVER_SECRET_KEY]: "backup-root",
      [__TESTING__.INSTALL_KEY]: "independent-root",
    })
    await rotateBackupKey()
    expect(await getInstallEncryptionPassphrase()).toBe("independent-root")
    expect(values.get(__TESTING__.SERVER_SECRET_KEY)).not.toBe("backup-root")
  })

  it("loads or creates the key through the service-scoped secret store", async () => {
    transportCall.mockResolvedValueOnce(null).mockResolvedValueOnce(undefined)

    const key = await getDefaultBackupPassphrase()

    expect(key).toBeTruthy()
    expect(transportCall).toHaveBeenNthCalledWith(1, "secret_store_get", {
      input: { namespace: "backup", key: "encryption.key.v1" },
    })
    expect(transportCall).toHaveBeenNthCalledWith(2, "secret_store_set", {
      input: { namespace: "backup", key: "encryption.key.v1", value: key },
    })
    expect(localStorage.getItem(WEB_BACKUP_KEY_STORAGE)).toBeNull()
  })

  it("rotates and clears the server-stored key without touching browser storage", async () => {
    transportCall.mockResolvedValue(undefined)

    const rotated = await rotateBackupKey()
    expect(transportCall).toHaveBeenCalledWith("secret_store_set", {
      input: { namespace: "backup", key: "encryption.key.v1", value: rotated },
    })

    await clearBackupKey()
    expect(transportCall).toHaveBeenCalledWith("secret_store_delete", {
      input: { namespace: "backup", key: "encryption.key.v1" },
    })
    expect(localStorage.getItem(WEB_BACKUP_KEY_STORAGE)).toBeNull()
  })
})

describe("credential preservation across backup rotation", () => {
  it("keeps preexisting install-key plugin ciphertext readable across repeated rotation", async () => {
    const oldKey = await deriveInstallKey("rotation-regression")
    const ciphertext = await encrypt("preserve-current-secret", oldKey)
    const before = await getDefaultBackupPassphrase()
    await rotateBackupKey()
    await rotateBackupKey()
    expect(await getDefaultBackupPassphrase()).not.toBe(before)
    await expect(decrypt(ciphertext, await deriveInstallKey("rotation-regression"))).resolves.toBe(
      "preserve-current-secret"
    )
  })
})

it("preserves the legacy root before the first rotation even if no consumer has migrated", async () => {
  const legacy = await getDefaultBackupPassphrase()
  expect(localStorage.getItem(__TESTING__.WEB_INSTALL_KEY_STORAGE)).toBeNull()
  await rotateBackupKey()
  expect(await getInstallEncryptionPassphrase()).toBe(legacy)
})

it("refuses rotation when preserving the credential root fails", async () => {
  const original = await getDefaultBackupPassphrase()
  const setItem = Storage.prototype.setItem
  const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value
  ) {
    if (key === __TESTING__.WEB_INSTALL_KEY_STORAGE) throw new Error("storage full")
    return setItem.call(this, key, value)
  })
  try {
    await expect(rotateBackupKey()).rejects.toThrow("storage full")
    expect(await getDefaultBackupPassphrase()).toBe(original)
  } finally {
    spy.mockRestore()
  }
})
