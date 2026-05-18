import { cloudFetch, defaultErrorCodeFor, parseJson, requireSecret } from "./_http"
import { OcrError } from "../types"

describe("defaultErrorCodeFor", () => {
  it("maps auth statuses to missing_credentials", () => {
    expect(defaultErrorCodeFor(401)).toBe("missing_credentials")
    expect(defaultErrorCodeFor(403)).toBe("missing_credentials")
  })
  it("maps 429 to rate_limited", () => {
    expect(defaultErrorCodeFor(429)).toBe("rate_limited")
  })
  it("maps 4xx (non-auth) to invalid_input", () => {
    expect(defaultErrorCodeFor(400)).toBe("invalid_input")
    expect(defaultErrorCodeFor(404)).toBe("invalid_input")
  })
  it("maps 5xx to provider_failed", () => {
    expect(defaultErrorCodeFor(500)).toBe("provider_failed")
    expect(defaultErrorCodeFor(503)).toBe("provider_failed")
  })
})

function mockFetch(
  impl: (init?: RequestInit, url?: string) => Response | Promise<Response>
): typeof fetch {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    return impl(init, url)
  }) as unknown as typeof fetch
}

describe("cloudFetch", () => {
  it("returns body and status on 2xx", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    )
    const res = await cloudFetch({
      providerId: "demo",
      url: "https://api.example.com",
      body: { x: 1 },
      fetchImpl,
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
  })

  it("JSON-encodes object bodies and sets Content-Type", async () => {
    const seen: { headers?: Headers; body?: BodyInit | null } = {}
    const fetchImpl = mockFetch((init) => {
      seen.body = init?.body ?? null
      seen.headers = new Headers(init?.headers)
      return new Response("{}", { status: 200 })
    })
    await cloudFetch({
      providerId: "demo",
      url: "https://api.example.com",
      body: { hello: "world" },
      fetchImpl,
    })
    expect(JSON.parse(seen.body as string)).toEqual({ hello: "world" })
    expect(seen.headers?.get("content-type")).toBe("application/json")
  })

  it("respects caller-supplied Content-Type", async () => {
    const seen: { headers?: Headers } = {}
    const fetchImpl = mockFetch((init) => {
      seen.headers = new Headers(init?.headers)
      return new Response("ok", { status: 200 })
    })
    await cloudFetch({
      providerId: "demo",
      url: "https://api.example.com",
      headers: { "Content-Type": "text/plain" },
      body: "raw payload",
      fetchImpl,
    })
    expect(seen.headers?.get("content-type")).toBe("text/plain")
  })

  it.each([
    [401, "missing_credentials"],
    [403, "missing_credentials"],
    [429, "rate_limited"],
    [422, "invalid_input"],
    [500, "provider_failed"],
  ] as const)("maps HTTP %i to OcrError code %s", async (status, code) => {
    const fetchImpl = mockFetch(() => new Response("err", { status }))
    await expect(
      cloudFetch({ providerId: "demo", url: "https://api.example.com", fetchImpl })
    ).rejects.toMatchObject({ code, providerId: "demo" })
  })

  it("honours a caller-supplied errorCodeFor override", async () => {
    const fetchImpl = mockFetch(() => new Response("x", { status: 500 }))
    await expect(
      cloudFetch({
        providerId: "demo",
        url: "https://api.example.com",
        fetchImpl,
        errorCodeFor: () => "unsupported_language",
      })
    ).rejects.toMatchObject({ code: "unsupported_language" })
  })

  it("wraps network failures into provider_failed", async () => {
    const fetchImpl = mockFetch(() => {
      throw new TypeError("network is down")
    })
    await expect(
      cloudFetch({ providerId: "demo", url: "https://api.example.com", fetchImpl })
    ).rejects.toMatchObject({ code: "provider_failed" })
  })

  it("translates AbortError into aborted", async () => {
    const abortError = Object.assign(new DOMException("aborted", "AbortError"), {})
    const fetchImpl = mockFetch(() => {
      throw abortError
    })
    await expect(
      cloudFetch({ providerId: "demo", url: "https://api.example.com", fetchImpl })
    ).rejects.toMatchObject({ code: "aborted" })
  })

  it("short-circuits when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = mockFetch(() => new Response("ok", { status: 200 }))
    await expect(
      cloudFetch({
        providerId: "demo",
        url: "https://api.example.com",
        signal: controller.signal,
        fetchImpl,
      })
    ).rejects.toMatchObject({ code: "aborted" })
  })

  it("raises provider_failed when fetch is missing entirely", async () => {
    await expect(
      cloudFetch({
        providerId: "demo",
        url: "https://api.example.com",
        fetchImpl: undefined as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ code: "provider_failed" })
  })

  it("sends bytes payloads with octet-stream content type", async () => {
    const seen: { headers?: Headers; body?: BodyInit | null } = {}
    const fetchImpl = mockFetch((init) => {
      seen.headers = new Headers(init?.headers)
      seen.body = init?.body ?? null
      return new Response("ok", { status: 200 })
    })
    await cloudFetch({
      providerId: "demo",
      url: "https://api.example.com",
      body: new Uint8Array([1, 2, 3]),
      fetchImpl,
    })
    expect(seen.headers?.get("content-type")).toBe("application/octet-stream")
  })
})

describe("parseJson", () => {
  it("returns the parsed object on valid JSON", () => {
    expect(parseJson<{ a: number }>("demo", '{"a":1}')).toEqual({ a: 1 })
  })
  it("throws provider_failed on invalid JSON", () => {
    expect(() => parseJson("demo", "not json")).toThrow(
      expect.objectContaining({ code: "provider_failed" }) as unknown as OcrError
    )
  })
})

describe("requireSecret", () => {
  it("returns the value when present", () => {
    expect(requireSecret("demo", { key: "abc" }, "key")).toBe("abc")
  })
  it("throws missing_credentials when absent", () => {
    expect(() => requireSecret("demo", {}, "key")).toThrow(
      expect.objectContaining({ code: "missing_credentials" }) as unknown as OcrError
    )
  })
  it("throws missing_credentials when empty", () => {
    expect(() => requireSecret("demo", { key: "" }, "key")).toThrow(
      expect.objectContaining({ code: "missing_credentials" })
    )
  })
})
