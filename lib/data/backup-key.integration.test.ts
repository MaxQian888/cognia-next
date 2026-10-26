/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { webcrypto } from "node:crypto"
import { TextEncoder, TextDecoder } from "node:util"

const runtime = { desktop: false, failBackupRead: false, failStore: false, failInstallSave: false }
const desktopStore = new Map<string, string>()
const savedFiles: string[] = []
const diskFiles = new Map<string, Map<string, string>>()
const nativeSecrets = new Map<string, string>()

jest.mock("@/lib/platform/detect", () => ({ isHeadlessHost: () => false }))
jest.mock("@/lib/tauri", () => ({
  isTauri: () => runtime.desktop,
  isCapacitor: () => false,
  transport: { call: jest.fn() },
}))
jest.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    constructor(private readonly file: string) {}
    async get(key: string) {
      if (runtime.failStore) throw new Error("plugin unavailable")
      if (runtime.failBackupRead && key === "backup.encryption.key.v1")
        throw new Error("native store unavailable")
      if (!desktopStore.has(key) && diskFiles.get(this.file)?.has(key))
        desktopStore.set(key, diskFiles.get(this.file)!.get(key)!)
      return desktopStore.get(key) ?? null
    }
    async set(key: string, value: string) {
      desktopStore.set(key, value)
    }
    async reload() {
      const disk = diskFiles.get(this.file)
      if (!disk) throw new Error("file missing")
      for (const [key, value] of disk) desktopStore.set(key, value)
    }
    async save() {
      if (runtime.failInstallSave && this.file === "cognia-install-key.json")
        throw new Error("disk full")
      const key =
        this.file === "cognia-install-key.json"
          ? "install.encryption.key.v1"
          : "backup.encryption.key.v1"
      diskFiles.set(this.file, new Map([[key, desktopStore.get(key)!]]))
      savedFiles.push(this.file)
    }
  },
}))
jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(
    async (
      command: string,
      { input }: { input: { namespace: string; key: string; value?: string } }
    ) => {
      const id = `${input.namespace}:${input.key}`
      if (command === "secret_store_set") nativeSecrets.set(id, input.value!)
      if (command === "secret_store_delete") nativeSecrets.delete(id)
      return command === "secret_store_get" ? (nativeSecrets.get(id) ?? null) : undefined
    }
  ),
}))
jest.mock("@/lib/accounts/active-account-id", () => ({
  getActiveAccountId: () => "audit-rotation",
}))

import { getDefaultBackupPassphrase, rotateBackupKey } from "@/lib/data/backup-key"
import { deriveInstallKey, encrypt, decrypt, deriveKey } from "@/lib/plugin/api/crypto-helpers"
import { setWebKeyringPassphrase, getSecret, clearSecret } from "@/lib/keyring"
import {
  saveLogtoSession,
  loadLogtoSession,
  logtoKeyringFor,
  __resetLogtoWebPassphraseForTests,
} from "@/lib/logto/session-store"
import type { LogtoSession } from "@/lib/logto/client"

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true })
Object.defineProperty(globalThis, "TextEncoder", { value: TextEncoder, configurable: true })
Object.defineProperty(globalThis, "TextDecoder", { value: TextDecoder, configurable: true })

const session = {
  issuer: "https://audit.invalid",
  clientId: "audit",
  accessToken: "fixture-token",
  refreshToken: "fixture-refresh",
  expiresAt: 1,
  scopes: ["openid"],
} as LogtoSession

beforeEach(async () => {
  runtime.desktop = false
  runtime.failBackupRead = false
  runtime.failStore = false
  runtime.failInstallSave = false
  savedFiles.length = 0
  localStorage.clear()
  desktopStore.clear()
  diskFiles.clear()
  nativeSecrets.clear()
  setWebKeyringPassphrase(null)
  __resetLogtoWebPassphraseForTests()
  await clearSecret(logtoKeyringFor())
})

test("desktop rotation preserves existing plugin install-key ciphertext", async () => {
  runtime.desktop = true
  const original = await getDefaultBackupPassphrase()
  const oldKey = await deriveInstallKey("audit-plugin")
  const ciphertext = await encrypt("authored-plugin-value", oldKey)
  await expect(decrypt(ciphertext, await deriveInstallKey("audit-plugin"))).resolves.toBe(
    "authored-plugin-value"
  )
  expect(await rotateBackupKey()).not.toBe(original)
  await expect(decrypt(ciphertext, await deriveInstallKey("audit-plugin"))).resolves.toBe(
    "authored-plugin-value"
  )
  await expect(decrypt(ciphertext, await deriveKey("audit-plugin"))).rejects.toThrow()
  await expect(decrypt(ciphertext, oldKey)).resolves.toBe("authored-plugin-value")
})

test("browser Logto vault remains readable after rotation and next boot", async () => {
  await saveLogtoSession(session)
  await expect(loadLogtoSession()).resolves.toEqual(session)
  await rotateBackupKey()
  await expect(loadLogtoSession()).resolves.toEqual(session)
  // Model a fresh JS boot while retaining the isolated IndexedDB fixture.
  setWebKeyringPassphrase(null)
  __resetLogtoWebPassphraseForTests()
  await expect(loadLogtoSession()).resolves.toEqual(session)
  await expect(getSecret(logtoKeyringFor())).resolves.toBe(JSON.stringify(session))
})

test("desktop Logto native keyring does not use the backup auto-key", async () => {
  runtime.desktop = true
  await saveLogtoSession(session)
  await rotateBackupKey()
  __resetLogtoWebPassphraseForTests()
  await expect(loadLogtoSession()).resolves.toEqual(session)
})

test("native migration never substitutes a browser fallback after a native read failure", async () => {
  runtime.desktop = true
  const before = await getDefaultBackupPassphrase()
  const oldKey = await deriveInstallKey("migration-regression")
  const ciphertext = await encrypt("native-secret", oldKey)
  desktopStore.delete("install.encryption.key.v1") // pre-upgrade state
  diskFiles.delete("cognia-install-key.json")
  localStorage.setItem("cognia-backup-encryption-key-v1", "unrelated-browser-key")
  runtime.failBackupRead = true
  await expect(rotateBackupKey()).rejects.toThrow("native store unavailable")
  expect(desktopStore.get("backup.encryption.key.v1")).toBe(before)
  expect(desktopStore.has("install.encryption.key.v1")).toBe(false)
  runtime.failBackupRead = false
  await expect(decrypt(ciphertext, await deriveInstallKey("migration-regression"))).resolves.toBe(
    "native-secret"
  )
})

test("preserves the native legacy file until the independent credential root has been saved", async () => {
  runtime.desktop = true
  await getDefaultBackupPassphrase()
  savedFiles.length = 0
  await rotateBackupKey()
  expect(savedFiles).toEqual(["cognia-install-key.json", "cognia-backup-key.json"])
})

test("retains web fallback reads during a native plugin outage but refuses rotation", async () => {
  runtime.desktop = false
  const key = await deriveInstallKey("fallback-regression")
  const ciphertext = await encrypt("fallback-value", key)
  runtime.desktop = true
  runtime.failStore = true
  await expect(decrypt(ciphertext, await deriveInstallKey("fallback-regression"))).resolves.toBe(
    "fallback-value"
  )
  await expect(rotateBackupKey()).rejects.toThrow("plugin unavailable")
})

test("dirty native cache cannot bypass failed durable migration before rotation", async () => {
  runtime.desktop = true
  const before = await getDefaultBackupPassphrase()
  runtime.failInstallSave = true
  const key = await deriveInstallKey("dirty-native-cache")
  const ciphertext = await encrypt("preserved", key)
  expect(diskFiles.has("cognia-install-key.json")).toBe(false)
  await expect(rotateBackupKey()).rejects.toThrow("disk full")
  expect(desktopStore.get("backup.encryption.key.v1")).toBe(before)
  runtime.failInstallSave = false
  await rotateBackupKey()
  desktopStore.clear() // Native process restart: discard the shared store cache.
  await expect(decrypt(ciphertext, await deriveInstallKey("dirty-native-cache"))).resolves.toBe(
    "preserved"
  )
})

test("first initialization save failure never returns a root that exists only in memory", async () => {
  runtime.desktop = true
  runtime.failInstallSave = true
  const ciphertext = await encrypt("first write", await deriveInstallKey("first-native-write"))
  expect(diskFiles.has("cognia-install-key.json")).toBe(false)
  desktopStore.clear()
  runtime.failInstallSave = false
  await expect(decrypt(ciphertext, await deriveInstallKey("first-native-write"))).resolves.toBe(
    "first write"
  )
})

test("an established native root is never replaced after its file becomes temporarily unreadable", async () => {
  runtime.desktop = true
  const ciphertext = await encrypt("stable root", await deriveInstallKey("native-read-outage"))
  const root = desktopStore.get("install.encryption.key.v1")
  await rotateBackupKey()
  diskFiles.delete("cognia-install-key.json")
  await expect(decrypt(ciphertext, await deriveInstallKey("native-read-outage"))).resolves.toBe(
    "stable root"
  )
  await expect(rotateBackupKey()).rejects.toThrow("file missing")
  expect(desktopStore.get("install.encryption.key.v1")).toBe(root)
  expect(diskFiles.has("cognia-install-key.json")).toBe(false)
  diskFiles.set("cognia-install-key.json", new Map([["install.encryption.key.v1", root!]]))
  desktopStore.clear()
  await expect(decrypt(ciphertext, await deriveInstallKey("native-read-outage"))).resolves.toBe(
    "stable root"
  )
})
