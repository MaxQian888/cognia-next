import { base64UrlToText, textToBase64Url } from "./base64url"
import { createCompanionSession, type CompanionFetch } from "./session"
import { CompanionApiError } from "./errors"
import type { DeviceSigner } from "./device-signer"

const SIGNER: DeviceSigner = {
  deviceId: "device-a",
  sign: async () => new Uint8Array([9]),
}

function accessToken(jti: string): string {
  return `${textToBase64Url('{"alg":"HS256"}')}.${textToBase64Url(JSON.stringify({ jti }))}.sig`
}

interface Harness {
  fetchImpl: CompanionFetch
  calls: { url: string; body: Record<string, unknown> }[]
  challenges: number
  tokens: number
}

function harness(options: { expiresIn?: number } = {}): Harness {
  const state: Harness = {
    calls: [],
    challenges: 0,
    tokens: 0,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      state.calls.push({ url, body })
      if (url.endsWith("/api/auth/device/challenge")) {
        state.challenges += 1
        return jsonResponse({ challengeId: `c${state.challenges}`, nonce: `n${state.challenges}` })
      }
      if (url.endsWith("/api/auth/token")) {
        state.tokens += 1
        return jsonResponse({
          accessToken: accessToken(`jti-${state.tokens}`),
          expiresIn: options.expiresIn ?? 300,
        })
      }
      throw new Error(`unexpected ${url}`)
    },
  }
  return state
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function proofPayload(proof: string): Record<string, unknown> {
  return JSON.parse(base64UrlToText(proof.split(".")[1])) as Record<string, unknown>
}

describe("createCompanionSession", () => {
  it("exchanges a challenge for a token and binds the proof to that token's jti", async () => {
    const h = harness()
    const session = createCompanionSession({
      baseUrl: "http://127.0.0.1:27891",
      tenantId: "tenant-a",
      signer: SIGNER,
      fetchImpl: h.fetchImpl,
    })
    const headers = await session.authorizationHeaders("POST", "/api/_rpc/browser_context_submit")

    expect(headers.Authorization).toBe(`Bearer ${accessToken("jti-1")}`)
    // The nonce's second role: after a token exists it is that token's jti,
    // which is what binds a proof to one token rather than to the device.
    expect(proofPayload(headers.DPoP).nonce).toBe("jti-1")
    expect(proofPayload(headers.DPoP).htu).toBe("/api/_rpc/browser_context_submit")
    // The token exchange's own proof quotes the challenge nonce instead.
    const tokenCall = h.calls.find((call) => call.url.endsWith("/api/auth/token"))
    expect(proofPayload(String(tokenCall?.body.proof)).nonce).toBe("n1")
  })

  it("reuses a live token instead of burning a challenge per request", async () => {
    const h = harness()
    const session = createCompanionSession({
      baseUrl: "http://127.0.0.1:27891/",
      tenantId: "tenant-a",
      signer: SIGNER,
      fetchImpl: h.fetchImpl,
    })
    await session.authorizationHeaders("GET", "/a")
    await session.authorizationHeaders("GET", "/b")
    expect(h.challenges).toBe(1)
    expect(h.tokens).toBe(1)
  })

  it("collapses concurrent first requests onto one token exchange", async () => {
    // Without the in-flight guard a panel that fires its capability call and
    // its first poll together mints two tokens and burns two challenges, and
    // the second proof can end up verified against the first token.
    const h = harness()
    const session = createCompanionSession({
      baseUrl: "http://127.0.0.1:27891",
      tenantId: "tenant-a",
      signer: SIGNER,
      fetchImpl: h.fetchImpl,
    })
    const [one, two] = await Promise.all([
      session.authorizationHeaders("GET", "/a"),
      session.authorizationHeaders("GET", "/b"),
    ])
    expect(h.tokens).toBe(1)
    expect(one.Authorization).toBe(two.Authorization)
  })

  it("refreshes before expiry rather than after it", async () => {
    // 20s of life left is inside the 30s margin: a proof minted against a
    // token that dies in transit fails for a reason the client could have
    // avoided.
    const h = harness({ expiresIn: 20 })
    const session = createCompanionSession({
      baseUrl: "http://127.0.0.1:27891",
      tenantId: "tenant-a",
      signer: SIGNER,
      fetchImpl: h.fetchImpl,
    })
    await session.authorizationHeaders("GET", "/a")
    await session.authorizationHeaders("GET", "/b")
    expect(h.tokens).toBe(2)
  })

  it("re-authenticates after invalidate()", async () => {
    const h = harness()
    const session = createCompanionSession({
      baseUrl: "http://127.0.0.1:27891",
      tenantId: "tenant-a",
      signer: SIGNER,
      fetchImpl: h.fetchImpl,
    })
    await session.authorizationHeaders("GET", "/a")
    session.invalidate()
    await session.authorizationHeaders("GET", "/b")
    expect(h.tokens).toBe(2)
  })

  it("surfaces a refusal code, not just an HTTP status", async () => {
    const session = createCompanionSession({
      baseUrl: "http://127.0.0.1:27891",
      tenantId: "tenant-a",
      signer: SIGNER,
      fetchImpl: async () =>
        jsonResponse({ error: { code: "device_origin_mismatch", message: "wrong origin" } }, 403),
    })
    await expect(session.authorizationHeaders("GET", "/a")).rejects.toMatchObject({
      code: "device_origin_mismatch",
      status: 403,
    })
    await expect(session.authorizationHeaders("GET", "/a")).rejects.toBeInstanceOf(
      CompanionApiError
    )
  })

  it("does not cache a failed exchange as if it had succeeded", async () => {
    let fail = true
    let tokens = 0
    const session = createCompanionSession({
      baseUrl: "http://127.0.0.1:27891",
      tenantId: "tenant-a",
      signer: SIGNER,
      fetchImpl: async (url) => {
        if (url.endsWith("/api/auth/device/challenge")) {
          if (fail) return jsonResponse({ error: { code: "boom", message: "no" } }, 500)
          return jsonResponse({ challengeId: "c", nonce: "n" })
        }
        tokens += 1
        return jsonResponse({ accessToken: accessToken("jti-1"), expiresIn: 300 })
      },
    })
    await expect(session.authorizationHeaders("GET", "/a")).rejects.toBeInstanceOf(
      CompanionApiError
    )
    fail = false
    await expect(session.authorizationHeaders("GET", "/a")).resolves.toHaveProperty("DPoP")
    expect(tokens).toBe(1)
  })
})
