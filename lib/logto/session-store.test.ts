jest.mock("@/lib/keyring", () => ({
  getSecret: jest.fn(),
  setSecret: jest.fn(),
  clearSecret: jest.fn(),
  setWebKeyringPassphrase: jest.fn(),
}))
jest.mock("@/lib/data/backup-key", () => ({ getDefaultBackupPassphrase: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
// The default profile is derived from the open Dexie database name; mocking it
// keeps this suite off the 700-table schema and makes the key deterministic.
jest.mock("@/lib/accounts/active-account-id", () => ({
  getActiveAccountId: jest.fn(() => "acct_active"),
}))

import { getSecret, setSecret, clearSecret, setWebKeyringPassphrase } from "@/lib/keyring"
import { getDefaultBackupPassphrase } from "@/lib/data/backup-key"
import { isTauri } from "@/lib/tauri"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"

import type { LogtoSession } from "./client"
import {
  saveLogtoSession,
  loadLogtoSession,
  clearLogtoSession,
  discardLegacyGlobalLogtoSession,
  logtoKeyringFor,
  LEGACY_LOGTO_KEYRING,
  __resetLogtoWebPassphraseForTests,
} from "./session-store"

const getMock = getSecret as jest.Mock
const setMock = setSecret as jest.Mock
const clearMock = clearSecret as jest.Mock
const setPassphraseMock = setWebKeyringPassphrase as jest.Mock
const backupKeyMock = getDefaultBackupPassphrase as jest.Mock
const isTauriMock = isTauri as jest.Mock
const activeAccountMock = getActiveAccountId as jest.Mock

const sampleSession: LogtoSession = {
  issuer: "https://logto.test/oidc",
  clientId: "cli-1",
  resource: "https://brain.test/api",
  organizationId: "org_9",
  accessToken: "at",
  refreshToken: "rt",
  idToken: "idt",
  expiresAt: 123,
  scopes: ["openid", "brain:rpc"],
}

const ref = logtoKeyringFor("acct_active")

beforeEach(() => {
  jest.clearAllMocks()
  __resetLogtoWebPassphraseForTests()
  isTauriMock.mockReturnValue(true)
  activeAccountMock.mockReturnValue("acct_active")
})

describe("logto session store", () => {
  it("saves the session as JSON under the logto keyring ref", async () => {
    await saveLogtoSession(sampleSession)
    expect(setMock).toHaveBeenCalledWith(ref, JSON.stringify(sampleSession))
  })

  it("loads and parses a stored session", async () => {
    getMock.mockResolvedValue(JSON.stringify(sampleSession))
    const loaded = await loadLogtoSession()
    expect(loaded).toEqual(sampleSession)
    expect(getMock).toHaveBeenCalledWith(ref)
  })

  it("returns null when nothing is stored", async () => {
    getMock.mockResolvedValue(null)
    expect(await loadLogtoSession()).toBeNull()
  })

  it("returns null on corrupt JSON", async () => {
    getMock.mockResolvedValue("{not json")
    expect(await loadLogtoSession()).toBeNull()
  })

  it("clears the stored session", async () => {
    await clearLogtoSession()
    expect(clearMock).toHaveBeenCalledWith(ref)
  })
})

describe("encrypted-vault passphrase provisioning", () => {
  // Off the desktop the keyring falls back to an AES-GCM IndexedDB vault that
  // refuses writes until a passphrase is injected. Nothing injected it for
  // Logto, so signing in on a phone or in a browser failed at the moment the
  // token was persisted — after a successful browser round-trip.
  beforeEach(() => {
    isTauriMock.mockReturnValue(false)
    backupKeyMock.mockResolvedValue("auto-key")
  })

  it("provisions the vault key before persisting a session", async () => {
    await saveLogtoSession(sampleSession)
    expect(setPassphraseMock).toHaveBeenCalledWith("auto-key")
    expect(setMock).toHaveBeenCalledWith(ref, JSON.stringify(sampleSession))
  })

  it("provisions before reading, so a stored session is decryptable", async () => {
    getMock.mockResolvedValue(JSON.stringify(sampleSession))
    await loadLogtoSession()
    expect(setPassphraseMock).toHaveBeenCalledWith("auto-key")
  })

  it("provisions before clearing", async () => {
    await clearLogtoSession()
    expect(setPassphraseMock).toHaveBeenCalledWith("auto-key")
  })

  it("provisions once across many calls", async () => {
    await saveLogtoSession(sampleSession)
    await loadLogtoSession()
    await clearLogtoSession()
    expect(setPassphraseMock).toHaveBeenCalledTimes(1)
    expect(backupKeyMock).toHaveBeenCalledTimes(1)
  })

  it("never touches the vault key on the desktop, which has a real keyring", () => {
    isTauriMock.mockReturnValue(true)
    return saveLogtoSession(sampleSession).then(() => {
      expect(setPassphraseMock).not.toHaveBeenCalled()
      expect(backupKeyMock).not.toHaveBeenCalled()
    })
  })

  it("still attempts the write when no backup key exists, so the keyring reports the real reason", async () => {
    backupKeyMock.mockResolvedValue(null)
    await saveLogtoSession(sampleSession)
    expect(setPassphraseMock).not.toHaveBeenCalled()
    expect(setMock).toHaveBeenCalled()
  })
})

describe("one session per LocalProfile (ADR-0149)", () => {
  it("scopes the key by profile, so two profiles never share a login", () => {
    expect(logtoKeyringFor("acct_work")).toEqual({
      namespace: "logto",
      key: "session:acct_work",
    })
    expect(logtoKeyringFor("acct_work")).not.toEqual(logtoKeyringFor("acct_personal"))
  })

  it("defaults to the profile this runtime is serving", async () => {
    activeAccountMock.mockReturnValue("acct_personal")
    await saveLogtoSession(sampleSession)
    expect(setMock).toHaveBeenCalledWith(
      logtoKeyringFor("acct_personal"),
      JSON.stringify(sampleSession)
    )
  })

  it("acts on an explicitly named profile when one is given", async () => {
    await saveLogtoSession(sampleSession, "acct_other")
    expect(setMock).toHaveBeenCalledWith(logtoKeyringFor("acct_other"), expect.any(String))

    getMock.mockResolvedValue(JSON.stringify(sampleSession))
    await loadLogtoSession("acct_other")
    expect(getMock).toHaveBeenCalledWith(logtoKeyringFor("acct_other"))

    await clearLogtoSession("acct_other")
    expect(clearMock).toHaveBeenCalledWith(logtoKeyringFor("acct_other"))
  })

  it("never reuses the pre-ADR-0149 global key for a profile", () => {
    expect(LEGACY_LOGTO_KEYRING.key).toBe("session")
    expect(logtoKeyringFor("acct_active").key).not.toBe(LEGACY_LOGTO_KEYRING.key)
  })
})

describe("discardLegacyGlobalLogtoSession", () => {
  it("deletes a blob left at the global key rather than adopting it", async () => {
    // Adopting would show one person's token inside another person's profile,
    // and nothing in the blob records who it belonged to.
    getMock.mockResolvedValue(JSON.stringify(sampleSession))
    expect(await discardLegacyGlobalLogtoSession()).toBe(true)
    expect(clearMock).toHaveBeenCalledWith(LEGACY_LOGTO_KEYRING)
    expect(setMock).not.toHaveBeenCalled()
  })

  it("is a no-op when there is nothing to discard", async () => {
    getMock.mockResolvedValue(null)
    expect(await discardLegacyGlobalLogtoSession()).toBe(false)
    expect(clearMock).not.toHaveBeenCalled()
  })
})
