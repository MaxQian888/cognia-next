const getSecret = jest.fn()
const setSecret = jest.fn()
const clearSecret = jest.fn()

jest.mock("@/lib/keyring", () => ({
  getSecret: (...args: unknown[]) => getSecret(...args),
  setSecret: (...args: unknown[]) => setSecret(...args),
  clearSecret: (...args: unknown[]) => clearSecret(...args),
}))

import {
  clearRemoteHostCredential,
  loadRemoteHostCredential,
  remoteHostCredentialRef,
  saveRemoteHostCredential,
} from "./credential-vault"

beforeEach(() => {
  jest.clearAllMocks()
})

it("stores only the secret payload behind a stable credential reference", async () => {
  await expect(
    saveRemoteHostCredential("host-1", {
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
      signalingPrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
    })
  ).resolves.toBe("remote-host:host-1")

  expect(setSecret).toHaveBeenCalledWith(
    { namespace: "remote-host", key: "host-1" },
    JSON.stringify({
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
      signalingPrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
    })
  )
  expect(remoteHostCredentialRef("host-1")).toBe("remote-host:host-1")
})

it("loads valid credentials and rejects malformed records", async () => {
  getSecret.mockResolvedValueOnce(
    JSON.stringify({
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
      signalingPrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
    })
  )
  await expect(loadRemoteHostCredential("host-1")).resolves.toEqual({
    devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
    signalingPrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
  })

  getSecret.mockResolvedValueOnce(JSON.stringify({ signalingPrivateKeyJwk: { kty: "EC" } }))
  await expect(loadRemoteHostCredential("host-1")).resolves.toBeNull()
  getSecret.mockResolvedValueOnce("not-json")
  await expect(loadRemoteHostCredential("host-1")).resolves.toBeNull()
})

it("clears the credential by host id", async () => {
  await clearRemoteHostCredential("host-1")
  expect(clearSecret).toHaveBeenCalledWith({ namespace: "remote-host", key: "host-1" })
})
