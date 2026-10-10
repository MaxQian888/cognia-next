import { encodePairPayload, type PairPayload, type PairRelay } from "@/lib/qr/pair-payload"

import { isPairInvitation, loginWithInvitation } from "./pair-invitation"

const CONFIG = { deploymentMode: "single-user", hostId: "host_1", tenantId: "tnt_1" }

const payload: PairPayload = {
  baseUrl: "https://127.0.0.1:27890",
  mode: "owner-invitation",
  invitation: "owner-invitation",
  hostId: "host_1",
  tenantId: "tnt_1",
  expiresAt: Date.now() + 60_000,
  serverVersion: "1.2.3",
  fingerprint: "ab".repeat(32),
}
const relay: PairRelay = {
  url: "wss://relay.example/signaling",
  room: {
    v: 2,
    roomId: "room-1",
    roomNonce: "nonce",
    desktopSigningKey: "desktop",
    mobileSigningKey: "mobile",
    notAfter: Date.now() + 60_000,
  },
  mobilePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "d", x: "x", y: "y" },
}

function registered() {
  return {
    baseUrl: "https://127.0.0.1:27890",
    deviceId: "dev_1",
    devicePrivateKeyJwk: { kty: "EC", d: "secret" },
    deviceKeyThumbprint: "thumb",
    serverVersion: "1.2.3",
  }
}

describe("isPairInvitation", () => {
  it("tells a full invitation from a bare pairing code", () => {
    expect(isPairInvitation("cgnp4|abc")).toBe(true)
    expect(isPairInvitation("  cgnp3|abc ")).toBe(true)
    expect(isPairInvitation("ABC123")).toBe(false)
  })
})

describe("loginWithInvitation", () => {
  it("pairs directly with the address, fingerprint and tenant the invitation names", async () => {
    const direct = jest.fn()
    const seen: Array<{ url: string; fp?: string; fetcher: unknown }> = []
    const createRelayFetcher = jest.fn()
    const result = await loginWithInvitation({
      invitation: encodePairPayload({ ...payload, relay }),
      fetcher: direct,
      probeDirect: async () => true,
      createRelayFetcher,
      login: {
        fetchConfig: async (url, fp, fetcher) => {
          seen.push({ url, fp, fetcher })
          return CONFIG as never
        },
        register: async (input, fetcher) => {
          expect(input).toMatchObject({ invitation: "owner-invitation", tenantId: "tnt_1" })
          expect(fetcher).toBe(direct)
          return registered() as never
        },
      },
    })
    expect(result).toMatchObject({
      ok: true,
      path: "direct",
      record: { endpoint: "https://127.0.0.1:27890", serverFingerprint: payload.fingerprint },
    })
    expect(seen[0]).toEqual({ url: payload.baseUrl, fp: payload.fingerprint, fetcher: direct })
    expect(createRelayFetcher).not.toHaveBeenCalled()
  })

  it("pairs through the relay room when the host does not answer, then leaves the room", async () => {
    const relayFetcher = jest.fn()
    const close = jest.fn()
    const createRelayFetcher = jest.fn(async () => ({ fetcher: relayFetcher, close }))
    const fetchers: unknown[] = []
    const result = await loginWithInvitation({
      invitation: encodePairPayload({ ...payload, relay }),
      fetcher: jest.fn(),
      probeDirect: async () => false,
      createRelayFetcher,
      login: {
        fetchConfig: async (_url, _fp, fetcher) => {
          fetchers.push(fetcher)
          return CONFIG as never
        },
        register: async (_input, fetcher) => {
          fetchers.push(fetcher)
          return registered() as never
        },
      },
    })
    expect(result).toMatchObject({ ok: true, path: "relay" })
    expect(createRelayFetcher).toHaveBeenCalledWith(relay)
    expect(fetchers).toEqual([relayFetcher, relayFetcher])
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("leaves the relay room even when the host refuses the invitation", async () => {
    const close = jest.fn()
    const result = await loginWithInvitation({
      invitation: encodePairPayload({ ...payload, relay }),
      probeDirect: async () => false,
      createRelayFetcher: async () => ({ fetcher: jest.fn(), close }),
      login: {
        fetchConfig: async () => CONFIG as never,
        register: async () => {
          throw new Error("invitation_consumed")
        },
      },
    })
    expect(result).toMatchObject({ ok: false, failure: { cause: "auth" } })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("says the relay room could not be joined", async () => {
    const result = await loginWithInvitation({
      invitation: encodePairPayload({ ...payload, relay }),
      probeDirect: async () => false,
      createRelayFetcher: async () => {
        throw new Error("no peer joined the rendezvous within the wait window")
      },
    })
    expect(result).toMatchObject({
      ok: false,
      failure: { cause: "network", details: [expect.stringContaining("no peer joined")] },
    })
  })

  it("lets --endpoint override the invitation's address", async () => {
    const urls: string[] = []
    const result = await loginWithInvitation({
      invitation: encodePairPayload(payload),
      endpoint: "https://home.example.com",
      login: {
        fetchConfig: async (url) => {
          urls.push(url)
          return CONFIG as never
        },
        register: async () => registered() as never,
      },
    })
    expect(result).toMatchObject({
      ok: true,
      path: "direct",
      record: { endpoint: "https://home.example.com" },
    })
    expect(urls).toEqual(["https://home.example.com"])
  })

  it("refuses strings that are not usable owner invitations, saying why", async () => {
    const cases: Array<[string, RegExp]> = [
      ["not-an-invitation", /not a Cognia pairing invitation/],
      ["cgnp9|abc", /version cgnp9/],
      [encodePairPayload({ ...payload, expiresAt: Date.now() - 1 }), /cannot be used/],
      [encodePairPayload({ ...payload, mode: "oidc", invitation: undefined }), /OIDC/],
    ]
    for (const [invitation, expected] of cases) {
      const result = await loginWithInvitation({ invitation })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.failure.error).toMatch(expected)
    }
  })
})
