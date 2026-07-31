import { extractHttpStatus, classifySearchError, backoffDelay, sleep } from "./retry"

describe("extractHttpStatus", () => {
  it("reads structured status fields first", () => {
    expect(extractHttpStatus({ status: 429 })).toBe(429)
    expect(extractHttpStatus({ statusCode: 503 })).toBe(503)
    expect(extractHttpStatus({ response: { status: 404 } })).toBe(404)
  })

  it("parses the status embedded in adapter messages", () => {
    expect(extractHttpStatus(new Error("Tavily API error: 429 - rate limited"))).toBe(429)
    expect(
      extractHttpStatus(new Error("Tavily search failed: Tavily API error: 401 - bad key"))
    ).toBe(401)
    expect(extractHttpStatus(new Error("Google API error: 500 - server"))).toBe(500)
  })

  it("falls back to keyword detection", () => {
    expect(extractHttpStatus(new Error("Rate limit exceeded"))).toBe(429)
    expect(extractHttpStatus(new Error("Unauthorized: invalid api key"))).toBe(401)
  })

  it("returns undefined when nothing recognizable", () => {
    expect(extractHttpStatus(new Error("boom"))).toBeUndefined()
    expect(extractHttpStatus("plain string")).toBeUndefined()
    expect(extractHttpStatus(undefined)).toBeUndefined()
  })

  it("ignores out-of-range numbers", () => {
    expect(extractHttpStatus({ status: 42 })).toBeUndefined()
    expect(extractHttpStatus({ status: 999 })).toBeUndefined()
  })
})

describe("classifySearchError", () => {
  it("marks 429/401/403 as retryable and prefers key rotation", () => {
    for (const s of [429, 401, 403]) {
      expect(classifySearchError(new Error(`API error: ${s} - x`))).toEqual({
        retryable: true,
        rotateKey: true,
        status: s,
      })
    }
  })

  it("retries 408 and 5xx on the same key", () => {
    expect(classifySearchError(new Error("API error: 500 - x"))).toEqual({
      retryable: true,
      rotateKey: false,
      status: 500,
    })
    expect(classifySearchError({ status: 408 })).toEqual({
      retryable: true,
      rotateKey: false,
      status: 408,
    })
  })

  it("does not retry other 4xx", () => {
    expect(classifySearchError(new Error("API error: 400 - bad request"))).toEqual({
      retryable: false,
      rotateKey: false,
      status: 400,
    })
    expect(classifySearchError({ status: 404 }).retryable).toBe(false)
  })

  it("retries recognizable network/timeout failures", () => {
    expect(classifySearchError(new TypeError("Failed to fetch")).retryable).toBe(true)
    expect(classifySearchError(new Error("fetch failed")).retryable).toBe(true)
    expect(classifySearchError(new Error("request timed out")).retryable).toBe(true)
    expect(classifySearchError(new Error("ECONNRESET")).retryable).toBe(true)
  })

  it("does not retry unknown errors or aborts (fallback handles those)", () => {
    expect(classifySearchError(new Error("boom")).retryable).toBe(false)
    expect(classifySearchError(new Error("The operation was aborted")).retryable).toBe(false)
  })
})

describe("backoffDelay", () => {
  it("grows exponentially and caps at maxMs (no jitter)", () => {
    const opts = { baseMs: 100, factor: 2, maxMs: 1000, jitter: false }
    expect(backoffDelay(0, opts)).toBe(100)
    expect(backoffDelay(1, opts)).toBe(200)
    expect(backoffDelay(2, opts)).toBe(400)
    expect(backoffDelay(10, opts)).toBe(1000) // capped
  })

  it("applies full jitter within [capped/2, capped]", () => {
    const base = { baseMs: 400, factor: 2, maxMs: 5000 }
    expect(backoffDelay(1, { ...base, random: () => 0 })).toBe(400) // 800 * 0.5
    expect(backoffDelay(1, { ...base, random: () => 1 })).toBe(800) // 800 * 1.0
  })
})

describe("sleep", () => {
  it("resolves after the delay", async () => {
    await expect(sleep(1)).resolves.toBeUndefined()
    await expect(sleep(0)).resolves.toBeUndefined()
  })

  it("rejects immediately for an already-aborted signal", async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(sleep(1000, ac.signal)).rejects.toMatchObject({ name: "AbortError" })
  })

  it("rejects when aborted mid-wait", async () => {
    const ac = new AbortController()
    const p = sleep(1000, ac.signal)
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: "AbortError" })
  })
})
