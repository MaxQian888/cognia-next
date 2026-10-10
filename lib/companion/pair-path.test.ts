import type { PairPayload, PairRelay } from "@/lib/qr/pair-payload"
import { fetchCompanionAuthConfig } from "@/lib/tauri/companion-auth"

import { choosePairPath, DIRECT_PAIR_PROBE_TIMEOUT_MS, probeDirectPairPath } from "./pair-path"

jest.mock("@/lib/tauri/companion-auth", () => ({ fetchCompanionAuthConfig: jest.fn() }))

const authConfig = fetchCompanionAuthConfig as jest.MockedFunction<typeof fetchCompanionAuthConfig>

const payload: PairPayload = {
  baseUrl: "https://127.0.0.1:27890",
  mode: "owner-invitation",
  invitation: "owner-invitation",
  hostId: "host-1",
  tenantId: "tenant-1",
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

afterEach(() => {
  authConfig.mockReset()
  jest.useRealTimers()
})

describe("choosePairPath", () => {
  it("goes direct when the invitation carries no relay room, without probing", async () => {
    const probeDirect = jest.fn()
    await expect(choosePairPath(payload, undefined, { probeDirect })).resolves.toBe("direct")
    expect(probeDirect).not.toHaveBeenCalled()
  })

  it("prefers direct when the Host answers, and takes the relay when it does not", async () => {
    const fetcher = jest.fn()
    const answers = jest.fn(async () => true)
    await expect(
      choosePairPath({ ...payload, relay }, fetcher, { probeDirect: answers })
    ).resolves.toBe("direct")
    expect(answers).toHaveBeenCalledWith({ ...payload, relay }, fetcher)
    await expect(
      choosePairPath({ ...payload, relay }, fetcher, { probeDirect: async () => false })
    ).resolves.toBe("relay")
  })

  it("honours a forced path", async () => {
    await expect(choosePairPath(payload, undefined, { path: "relay" })).resolves.toBe("relay")
  })
})

describe("probeDirectPairPath", () => {
  it("is true only when the Host that answers is the one the invitation names", async () => {
    authConfig.mockResolvedValueOnce({ hostId: "host-1" } as never)
    await expect(probeDirectPairPath(payload, undefined)).resolves.toBe(true)
    expect(authConfig).toHaveBeenCalledWith(payload.baseUrl, payload.fingerprint, undefined, {
      signal: expect.any(AbortSignal),
    })
    authConfig.mockResolvedValueOnce({ hostId: "someone-else" } as never)
    await expect(probeDirectPairPath(payload, undefined)).resolves.toBe(false)
    authConfig.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    await expect(probeDirectPairPath(payload, undefined)).resolves.toBe(false)
  })

  it("gives up after the probe window instead of waiting out the platform timeout", async () => {
    jest.useFakeTimers()
    let aborted = false
    authConfig.mockImplementationOnce(
      (_url, _fp, _fetcher, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true
            reject(new Error("aborted"))
          })
        })
    )
    const probe = probeDirectPairPath(payload, undefined)
    jest.advanceTimersByTime(DIRECT_PAIR_PROBE_TIMEOUT_MS)
    await expect(probe).resolves.toBe(false)
    expect(aborted).toBe(true)
  })
})
