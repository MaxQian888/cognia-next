/** @jest-environment jsdom */
import { createRelayPairFetcher } from "./relay-pair-fetch"
import type { TransportRtc } from "./transport-rtc"
import type { PairRelay } from "@/lib/qr/pair-payload"

jest.mock("@/lib/signaling/crypto", () => ({
  importSigningPrivateKey: jest.fn(async () => ({}) as CryptoKey),
}))

const relay: PairRelay = {
  url: "wss://signaling.test/signaling",
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

class FakeRtc {
  readonly calls: Array<{ method: string; params: Record<string, unknown> | undefined }> = []
  closed = false
  connectError: Error | null = null
  answer: unknown = { status: 200, headers: [["content-type", "application/json"]], body: "{}" }
  constructor(readonly options: Record<string, unknown>) {}
  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError
  }
  async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params })
    return this.answer as T
  }
  close(): void {
    this.closed = true
  }
}

function make(answer?: unknown) {
  let rtc: FakeRtc | null = null
  const fetcherPromise = createRelayPairFetcher(relay, {
    transportFactory: (options) => {
      rtc = new FakeRtc(options as unknown as Record<string, unknown>)
      if (answer !== undefined) rtc.answer = answer
      return rtc as unknown as TransportRtc
    },
  })
  return { fetcherPromise, rtc: () => rtc! }
}

describe("createRelayPairFetcher", () => {
  it("joins the pairing room relay-only with the invitation's identity", async () => {
    const { fetcherPromise, rtc } = make()
    await fetcherPromise
    expect(rtc().options.p2p).toBe(false)
    expect(rtc().options.rendezvousId).toBe("room-1")
    expect(rtc().options.role).toBe("mobile")
  })

  it("turns fetch(url, init) into a pair.http frame and rebuilds the Response", async () => {
    const { fetcherPromise, rtc } = make({
      status: 403,
      headers: [["content-type", "application/json"]],
      body: JSON.stringify({ error: { code: "owner_invitation_required" } }),
    })
    const { fetcher } = await fetcherPromise
    const response = await fetcher("https://10.0.0.1:27890/api/auth/device/challenge?x=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: "t" }),
      serverFingerprint: "abc",
    })
    expect(rtc().calls).toEqual([
      {
        method: "pair.http",
        params: {
          method: "POST",
          path: "/api/auth/device/challenge?x=1",
          headers: [["Content-Type", "application/json"]],
          body: JSON.stringify({ tenantId: "t" }),
        },
      },
    ])
    expect(response.status).toBe(403)
    expect(response.ok).toBe(false)
    await expect(response.json()).resolves.toEqual({
      error: { code: "owner_invitation_required" },
    })
  })

  it("refuses a malformed answer and stops after close()", async () => {
    const { fetcherPromise, rtc } = make({ nope: true })
    const { fetcher, close } = await fetcherPromise
    await expect(fetcher("https://h/api/auth/config")).rejects.toThrow(/malformed/)
    close()
    expect(rtc().closed).toBe(true)
    await expect(fetcher("https://h/api/auth/config")).rejects.toThrow(/closed/)
  })

  it("surfaces a Host that never joins the room as a connect failure", async () => {
    await expect(
      createRelayPairFetcher(relay, {
        transportFactory: (options) => {
          const rtc = new FakeRtc(options as unknown as Record<string, unknown>)
          rtc.connectError = new Error("no peer joined the rendezvous within the wait window")
          return rtc as unknown as TransportRtc
        },
      })
    ).rejects.toThrow(/no peer joined/)
  })
})
