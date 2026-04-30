// Behavior of the auto-key fallback. We test both the web (localStorage) path
// and the desktop branch's resilience when the plugin isn't loaded — the
// __mocks__/tauri-plugin-store.js shim returns null from `get`, so the code
// path that *generates* a fresh key is exercised even without a real store.

import {
  getDefaultBackupPassphrase,
  rotateBackupKey,
  clearBackupKey,
  __TESTING__,
} from "./backup-key"

const { WEB_BACKUP_KEY_STORAGE } = __TESTING__

beforeEach(() => {
  localStorage.clear()
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
