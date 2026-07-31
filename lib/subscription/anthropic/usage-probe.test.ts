import { probeOnce } from "./usage-probe"
import type { AnthropicCredentialData } from "@/types/subscription"

const credential: AnthropicCredentialData = {
  accessToken: "oat01-test",
  refreshToken: "rt-test",
  expiresAtMs: Date.now() + 3_600_000,
  mode: "subscription",
  storedAtMs: Date.now(),
}

function mockResponse(init: { status?: number; headers?: Record<string, string>; body?: string }) {
  const status = init.status ?? 200
  const headers = new Headers(init.headers ?? {})
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => init.body ?? "",
    json: async () => (init.body ? JSON.parse(init.body) : {}),
  } as unknown as Response
}

describe("probeOnce", () => {
  it("posts to /v1/messages with Bearer auth + required headers", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      mockResponse({
        headers: {
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-5h-utilization": "0.1",
          "anthropic-ratelimit-unified-5h-reset": "1700000000",
        },
      })
    )

    const out = await probeOnce(credential, { fetchImpl })
    expect(out.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("https://api.anthropic.com/v1/messages")
    expect(init.method).toBe("POST")
    expect(init.headers["Authorization"]).toBe(`Bearer ${credential.accessToken}`)
    expect(init.headers["anthropic-version"]).toBe("2023-06-01")
    expect(init.headers["anthropic-beta"]).toMatch(/oauth-2025-04-20/)
    expect(init.headers["anthropic-beta"]).toMatch(/claude-code-20250219/)
    expect(init.headers["x-app"]).toBe("cli")
    expect(init.headers).not.toHaveProperty("User-Agent")

    const body = JSON.parse(init.body as string)
    expect(body.max_tokens).toBe(1)
    expect(body.messages).toEqual([{ role: "user", content: "." }])
  })

  it("returns auth failure on 401", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(mockResponse({ status: 401 }))
    const out = await probeOnce(credential, { fetchImpl })
    expect(out).toEqual({ ok: false, reason: "auth", status: 401 })
  })

  it("returns auth failure on 403 too", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(mockResponse({ status: 403 }))
    const out = await probeOnce(credential, { fetchImpl })
    expect(out.ok).toBe(false)
    expect((out as { reason: string }).reason).toBe("auth")
  })

  it("captures unified-* headers even from a 429", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      mockResponse({
        status: 429,
        headers: {
          "anthropic-ratelimit-unified-status": "rate_limited",
          "anthropic-ratelimit-unified-7d-utilization": "1.0",
          "anthropic-ratelimit-unified-7d-reset": "1700000000",
        },
      })
    )
    const out = await probeOnce(credential, { fetchImpl })
    expect(out.ok).toBe(true)
    expect(out.ok && out.snapshot.status).toBe("rate_limited")
  })

  it("returns rate-limited reason when 429 has no usage headers", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(mockResponse({ status: 429 }))
    const out = await probeOnce(credential, { fetchImpl })
    expect(out).toEqual({ ok: false, reason: "rate-limited", status: 429 })
  })

  it("returns http reason on other non-2xx", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(mockResponse({ status: 500, body: "internal error" }))
    const out = await probeOnce(credential, { fetchImpl })
    expect(out.ok).toBe(false)
    expect((out as { reason: string; status: number }).status).toBe(500)
  })

  it("returns no-headers on a 200 lacking unified-* headers", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(mockResponse({ headers: {} }))
    const out = await probeOnce(credential, { fetchImpl })
    expect(out).toEqual({ ok: false, reason: "no-headers", status: 200 })
  })

  it("returns transport reason on fetch throw", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("connect ECONNREFUSED"))
    const out = await probeOnce(credential, { fetchImpl })
    expect(out.ok).toBe(false)
    expect((out as { reason: string; message: string }).message).toMatch(/ECONNREFUSED/)
  })

  it("uses the injected `now` for fetchedAt", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      mockResponse({
        headers: {
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-5h-utilization": "0.1",
          "anthropic-ratelimit-unified-5h-reset": "1700000000",
        },
      })
    )
    const out = await probeOnce(credential, { fetchImpl, now: () => 42 })
    expect(out.ok).toBe(true)
    expect(out.ok && out.snapshot.fetchedAt).toBe(42)
  })
})
