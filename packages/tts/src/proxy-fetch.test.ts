/**
 * Coverage for the package `proxy-fetch`. Drives the browser path and the
 * host-injected native hook (ADR-0068 E3), validating header/body packaging
 * and the lazy text/json accessors of the returned ProxyFetchResult. The
 * Tauri implementation itself is covered app-side in
 * `lib/tts/host-bindings.test.ts`.
 */

import { setTtsHost } from "./host"
import { proxyFetch, type ProxyFetchResult } from "./proxy-fetch"

beforeEach(() => {
  setTtsHost({})
  globalThis.fetch = jest.fn() as unknown as typeof fetch
})

afterAll(() => {
  setTtsHost({})
})

function makeResponse({
  status = 200,
  contentType = "application/octet-stream",
  body = new Uint8Array([1, 2, 3]),
}: {
  status?: number
  contentType?: string
  body?: Uint8Array | string
} = {}): Response {
  const buf = typeof body === "string" ? new TextEncoder().encode(body) : body
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-type": contentType }),
    arrayBuffer: async () =>
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  } as unknown as Response
}

describe("browser path (no host hook installed)", () => {
  it("posts JSON body with default method/content-type", async () => {
    const fetchMock = globalThis.fetch as unknown as jest.Mock
    fetchMock.mockResolvedValueOnce(makeResponse({ body: new Uint8Array([0xff]) }))
    const r = await proxyFetch("https://example.com/api", { json: { hi: "there" } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://example.com/api")
    expect(init.method).toBe("POST")
    expect(init.headers["content-type"]).toBe("application/json")
    expect(init.body).toBe(JSON.stringify({ hi: "there" }))
    expect(r.ok).toBe(true)
    expect(r.status).toBe(200)
  })

  it("preserves caller-provided content-type and method", async () => {
    const fetchMock = globalThis.fetch as unknown as jest.Mock
    fetchMock.mockResolvedValueOnce(makeResponse())
    await proxyFetch("https://example.com/api", {
      method: "PUT",
      headers: { "content-type": "application/x-other" },
      json: {},
    })
    const init = fetchMock.mock.calls[0][1]
    expect(init.method).toBe("PUT")
    expect(init.headers["content-type"]).toBe("application/x-other")
  })

  it("wraps Uint8Array body into a Blob", async () => {
    const fetchMock = globalThis.fetch as unknown as jest.Mock
    fetchMock.mockResolvedValueOnce(makeResponse())
    await proxyFetch("https://example.com/api", {
      body: new Uint8Array([1, 2, 3]),
      headers: { "content-type": "audio/mpeg" },
    })
    const init = fetchMock.mock.calls[0][1]
    expect(init.body).toBeInstanceOf(Blob)
  })

  it("wraps ArrayBuffer body into a Blob", async () => {
    const fetchMock = globalThis.fetch as unknown as jest.Mock
    fetchMock.mockResolvedValueOnce(makeResponse())
    const buf = new ArrayBuffer(4)
    await proxyFetch("https://example.com/api", { body: buf })
    const init = fetchMock.mock.calls[0][1]
    expect(init.body).toBeInstanceOf(Blob)
  })

  it("forwards an existing Blob untouched", async () => {
    const fetchMock = globalThis.fetch as unknown as jest.Mock
    fetchMock.mockResolvedValueOnce(makeResponse())
    const blob = new Blob(["hi"])
    await proxyFetch("https://example.com/api", { body: blob })
    expect(fetchMock.mock.calls[0][1].body).toBe(blob)
  })

  it("falls back to application/octet-stream when no content-type header is sent", async () => {
    const fetchMock = globalThis.fetch as unknown as jest.Mock
    const res = {
      status: 200,
      ok: true,
      headers: new Headers({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response
    fetchMock.mockResolvedValueOnce(res)
    const r = await proxyFetch("https://example.com/api", { json: {} })
    expect(r.mime).toBe("application/octet-stream")
  })

  it("text() decodes the body and json() parses it", async () => {
    const fetchMock = globalThis.fetch as unknown as jest.Mock
    fetchMock.mockResolvedValueOnce(
      makeResponse({ body: '{"a":1}', contentType: "application/json" })
    )
    const r = await proxyFetch("https://example.com/api", { json: {} })
    expect(await r.text()).toBe('{"a":1}')
    expect(await r.json<{ a: number }>()).toEqual({ a: 1 })
  })

  it("propagates non-2xx status", async () => {
    const fetchMock = globalThis.fetch as unknown as jest.Mock
    fetchMock.mockResolvedValueOnce(makeResponse({ status: 500, body: "boom" }))
    const r = await proxyFetch("https://example.com/api", { json: {} })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(500)
  })

  it("forwards cancellation to browser fetch", async () => {
    const controller = new AbortController()
    const fetchMock = globalThis.fetch as unknown as jest.Mock
    fetchMock.mockResolvedValueOnce(makeResponse())
    await proxyFetch("https://example.com/api", { json: {}, signal: controller.signal })
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal)
  })
})

describe("host hook path", () => {
  const nativeResult: ProxyFetchResult = {
    status: 201,
    ok: true,
    mime: "audio/mpeg",
    bytes: new ArrayBuffer(2),
    text: async () => "hi",
    json: async <T = unknown>() => ({ hi: 1 }) as T,
  }

  it("uses the installed native hook when it returns a promise", async () => {
    const hook = jest.fn(() => Promise.resolve(nativeResult))
    setTtsHost({ nativeProxyFetch: hook })
    const r = await proxyFetch("https://api.example.com/x", { json: { foo: 1 } })
    expect(hook).toHaveBeenCalledWith("https://api.example.com/x", { json: { foo: 1 } })
    expect(r).toBe(nativeResult)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it("falls through to browser fetch when the hook returns null (web shell)", async () => {
    setTtsHost({ nativeProxyFetch: () => null })
    const fetchMock = globalThis.fetch as unknown as jest.Mock
    fetchMock.mockResolvedValueOnce(makeResponse())
    const r = await proxyFetch("https://example.com/api", { json: {} })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r.status).toBe(200)
  })
})
