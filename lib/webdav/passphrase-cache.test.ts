// Session cache semantics + the opt-in keyring persistence layer. The keyring
// and settings are mocked; the contract under test is: persistence happens
// ONLY when rememberPassphrase === true, hydration never throws, and
// forget wipes both copies.

import type { AppSettings } from "@cognia/agent-config-types"

let settings: Partial<AppSettings> = {}

jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn(async () => settings),
}))

jest.mock("./config", () => ({
  setStoredSyncPassphrase: jest.fn(async () => undefined),
  getStoredSyncPassphrase: jest.fn(async () => null),
  clearStoredSyncPassphrase: jest.fn(async () => undefined),
}))

import { getSettings } from "@/lib/db/settings"
import {
  clearStoredSyncPassphrase,
  getStoredSyncPassphrase,
  setStoredSyncPassphrase,
} from "./config"
import {
  clearSyncPassphrase,
  forgetSyncPassphrase,
  getSyncPassphrase,
  hasSyncPassphrase,
  loadPersistedSyncPassphrase,
  persistSyncPassphrase,
  setSyncPassphrase,
} from "./passphrase-cache"

const mockSet = setStoredSyncPassphrase as jest.Mock
const mockGet = getStoredSyncPassphrase as jest.Mock
const mockClear = clearStoredSyncPassphrase as jest.Mock
const mockGetSettings = getSettings as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  settings = {}
  mockGet.mockResolvedValue(null)
})

afterEach(() => {
  clearSyncPassphrase()
})

describe("session cache", () => {
  it("starts empty", () => {
    expect(hasSyncPassphrase()).toBe(false)
    expect(getSyncPassphrase()).toBeNull()
  })

  it("stores and reads a passphrase", () => {
    setSyncPassphrase("secret")
    expect(hasSyncPassphrase()).toBe(true)
    expect(getSyncPassphrase()).toBe("secret")
  })

  it("treats empty string / null as cleared", () => {
    setSyncPassphrase("x")
    setSyncPassphrase("")
    expect(hasSyncPassphrase()).toBe(false)
    setSyncPassphrase("x")
    setSyncPassphrase(null)
    expect(hasSyncPassphrase()).toBe(false)
  })

  it("clears", () => {
    setSyncPassphrase("x")
    clearSyncPassphrase()
    expect(getSyncPassphrase()).toBeNull()
  })
})

describe("persistSyncPassphrase", () => {
  it("writes to the keyring only when rememberPassphrase is true", async () => {
    settings = { webdavSync: { rememberPassphrase: true } }
    await persistSyncPassphrase("pass")
    expect(mockSet).toHaveBeenCalledWith("pass")
  })

  it("is a no-op when the user did not opt in (default)", async () => {
    settings = { webdavSync: { enabled: true } }
    await persistSyncPassphrase("pass")
    expect(mockSet).not.toHaveBeenCalled()

    settings = {}
    await persistSyncPassphrase("pass")
    expect(mockSet).not.toHaveBeenCalled()
  })

  it("ignores empty passphrases", async () => {
    settings = { webdavSync: { rememberPassphrase: true } }
    await persistSyncPassphrase("")
    expect(mockSet).not.toHaveBeenCalled()
    expect(mockGetSettings).not.toHaveBeenCalled()
  })

  it("never throws when the keyring write fails", async () => {
    settings = { webdavSync: { rememberPassphrase: true } }
    mockSet.mockRejectedValueOnce(new Error("keyring locked"))
    await expect(persistSyncPassphrase("pass")).resolves.toBeUndefined()
  })
})

describe("loadPersistedSyncPassphrase", () => {
  it("hydrates the session cache when opted in and stored", async () => {
    settings = { webdavSync: { rememberPassphrase: true } }
    mockGet.mockResolvedValue("stored-pass")
    expect(await loadPersistedSyncPassphrase()).toBe(true)
    expect(getSyncPassphrase()).toBe("stored-pass")
  })

  it("returns true immediately when the cache is already warm (no keyring read)", async () => {
    setSyncPassphrase("warm")
    expect(await loadPersistedSyncPassphrase()).toBe(true)
    expect(mockGet).not.toHaveBeenCalled()
  })

  it("returns false when not opted in", async () => {
    settings = { webdavSync: { enabled: true } }
    mockGet.mockResolvedValue("stored-pass")
    expect(await loadPersistedSyncPassphrase()).toBe(false)
    expect(hasSyncPassphrase()).toBe(false)
  })

  it("returns false when nothing is stored", async () => {
    settings = { webdavSync: { rememberPassphrase: true } }
    expect(await loadPersistedSyncPassphrase()).toBe(false)
  })

  it("never throws when the keyring read fails (web auto-key not injected yet)", async () => {
    settings = { webdavSync: { rememberPassphrase: true } }
    mockGet.mockRejectedValueOnce(new Error("auto-key missing"))
    expect(await loadPersistedSyncPassphrase()).toBe(false)
  })
})

describe("forgetSyncPassphrase", () => {
  it("wipes both the session cache and the keyring copy", async () => {
    setSyncPassphrase("pass")
    await forgetSyncPassphrase()
    expect(hasSyncPassphrase()).toBe(false)
    expect(mockClear).toHaveBeenCalled()
  })

  it("never throws when the keyring clear fails", async () => {
    mockClear.mockRejectedValueOnce(new Error("nope"))
    await expect(forgetSyncPassphrase()).resolves.toBeUndefined()
  })
})
