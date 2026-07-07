jest.mock("@/lib/keyring", () => ({
  getSecret: jest.fn(),
  setSecret: jest.fn(),
  clearSecret: jest.fn(),
}))

import { getSecret, setSecret, clearSecret } from "@/lib/keyring"

import type { LogtoSession } from "./client"
import {
  saveLogtoSession,
  loadLogtoSession,
  clearLogtoSession,
  LOGTO_KEYRING,
} from "./session-store"

const getMock = getSecret as jest.Mock
const setMock = setSecret as jest.Mock
const clearMock = clearSecret as jest.Mock

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

beforeEach(() => jest.clearAllMocks())

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
