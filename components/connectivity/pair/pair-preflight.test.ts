/** @jest-environment jsdom */

import { preflightPairing } from "./pair-preflight"

const base = {
  hasRelay: false,
  webMode: true,
  credentialStoreReady: true,
  vaultLockedText: "Unlock first",
}

describe("preflightPairing", () => {
  it("refuses a plaintext LAN invitation a browser can never complete", () => {
    const failure = preflightPairing({ ...base, baseUrl: "http://192.168.1.20:8443" })
    expect(failure).toMatchObject({ stage: "transport", kind: "insecure_transport" })
    expect(failure?.invitationSpent).toBe(false)
  })

  it("lets a relay room carry an invitation whatever its direct address", () => {
    expect(
      preflightPairing({ ...base, baseUrl: "http://192.168.1.20:8443", hasRelay: true })
    ).toBeNull()
  })

  it("refuses before anything is sent when the device key cannot be stored", () => {
    expect(
      preflightPairing({
        ...base,
        baseUrl: "https://host.example.com",
        credentialStoreReady: false,
      })
    ).toEqual({
      stage: "persist",
      kind: "vault_locked",
      detail: "Unlock first",
      bodyText: "Unlock first",
      remedies: ["unlockAccount"],
      retryable: true,
      invitationSpent: false,
      baseUrl: "https://host.example.com",
    })
  })

  it("passes an invitation the client can redeem and keep", () => {
    expect(preflightPairing({ ...base, baseUrl: "https://host.example.com" })).toBeNull()
    expect(preflightPairing({ ...base, baseUrl: undefined })).toBeNull()
  })
})
