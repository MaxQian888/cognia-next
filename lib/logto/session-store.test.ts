jest.mock("@/lib/keyring", () => ({
  getSecret: jest.fn(),
  setSecret: jest.fn(),
  clearSecret: jest.fn(),
  setWebKeyringPassphrase: jest.fn(),
}))
jest.mock("@/lib/data/backup-key", () => ({ getDefaultBackupPassphrase: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))

import { getSecret, setSecret, clearSecret, setWebKeyringPassphrase } from "@/lib/keyring"
import { getDefaultBackupPassphrase } from "@/lib/data/backup-key"
import { isTauri } from "@/lib/tauri"

import type { LogtoSession } from "./client"
import {
  saveLogtoSession,
  loadLogtoSession,
  clearLogtoSession,
  LOGTO_KEYRING,
  __resetLogtoWebPassphraseForTests,
} from "./session-store"

const getMock = getSecret as jest.Mock
const setMock = setSecret as jest.Mock
const clearMock = clearSecret as jest.Mock
const setPassphraseMock = setWebKeyringPassphrase as jest.Mock
const backupKeyMock = getDefaultBackupPassphrase as jest.Mock
const isTauriMock = isTauri as jest.Mock

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

const ref = { namespace: LOGTO_KEYRING.namespace, key: LOGTO_KEYRING.key }

beforeEach(() => {
  jest.clearAllMocks()
  __resetLogtoWebPassphraseForTests()
  isTauriMock.mockReturnValue(true)
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
