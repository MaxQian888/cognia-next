/**
 * Coverage for `lib/tts/proxy-fetch.ts`. Drives both the browser and Tauri
 * paths through the boundary helpers, validating header/body packaging and
 * the lazy text/json accessors of the returned ProxyFetchResult.
 */

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))

import { isTauri } from "@/lib/tauri"
import * as core from "@tauri-apps/api/core"
import { proxyFetch } from "./proxy-fetch"

const mockIsTauri = isTauri as jest.Mock
const mockInvoke = core.invoke as unknown as jest.Mock

beforeEach(() => {
  mockIsTauri.mockReset()
  mockInvoke.mockReset()
  globalThis.fetch = jest.fn() as unknown as typeof fetch
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

describe("browser path", () => {
  beforeEach(() => mockIsTauri.mockReturnValue(false))

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
})

describe("tauri path", () => {
  beforeEach(() => mockIsTauri.mockReturnValue(true))

  it("packages JSON body and forwards default method", async () => {
    mockInvoke.mockResolvedValueOnce({
      status: 201,
      mime: "audio/mpeg",
      body_b64: btoa("hi"),
    })
    const r = await proxyFetch("https://api.example.com/x", {
      json: { foo: 1 },
      headers: { "x-h": "v" },
    })
    expect(mockInvoke).toHaveBeenCalledWith(
      "tts_proxy_fetch",
      expect.objectContaining({
        request: expect.objectContaining({
          url: "https://api.example.com/x",
          method: "POST",
          headers: { "x-h": "v" },
          json: { foo: 1 },
        }),
      })
    )
    expect(r.status).toBe(201)
    expect(r.ok).toBe(true)
    expect(r.mime).toBe("audio/mpeg")
    expect(await r.text()).toBe("hi")
  })

  it("encodes Uint8Array body as base64", async () => {
    mockInvoke.mockResolvedValueOnce({ status: 200, mime: "x", body_b64: "" })
    await proxyFetch("https://api.example.com/x", {
      method: "PUT",
      body: new Uint8Array([0x68, 0x69]),
    })
    const req = (mockInvoke.mock.calls[0][1] as { request: { body_b64?: string } }).request
    expect(req.body_b64).toBe(btoa("hi"))
  })

  it("encodes ArrayBuffer body as base64", async () => {
    mockInvoke.mockResolvedValueOnce({ status: 200, mime: "x", body_b64: "" })
    const buf = new TextEncoder().encode("hi").buffer as ArrayBuffer
    await proxyFetch("https://api.example.com/x", { body: buf })
    const req = (mockInvoke.mock.calls[0][1] as { request: { body_b64?: string } }).request
    expect(req.body_b64).toBe(btoa("hi"))
  })

  it("encodes Blob body as base64", async () => {
    mockInvoke.mockResolvedValueOnce({ status: 200, mime: "x", body_b64: "" })
    // jsdom's Blob doesn't ship .arrayBuffer(); polyfill from FileReader.
    if (typeof Blob.prototype.arrayBuffer !== "function") {
      Blob.prototype.arrayBuffer = function () {
        return new Promise((resolve) => {
          const r = new FileReader()
          r.onload = () => resolve(r.result as ArrayBuffer)
          r.readAsArrayBuffer(this)
        })
      }
    }
    const blob = new Blob(["hi"])
    await proxyFetch("https://api.example.com/x", { body: blob })
    const req = (mockInvoke.mock.calls[0][1] as { request: { body_b64?: string } }).request
    expect(req.body_b64).toBe(btoa("hi"))
  })

  it("classifies status>=400 as not ok", async () => {
    mockInvoke.mockResolvedValueOnce({
      status: 401,
      mime: "application/json",
      body_b64: btoa('{"error":"nope"}'),
    })
    const r = await proxyFetch("https://api.example.com/x", { json: {} })
    expect(r.ok).toBe(false)
    expect(await r.json<{ error: string }>()).toEqual({ error: "nope" })
  })

  it("base64-encoding handles large bodies in chunks", async () => {
    mockInvoke.mockResolvedValueOnce({ status: 200, mime: "x", body_b64: "" })
    // Larger than the 0x8000 chunk threshold to exercise the loop.
    const big = new Uint8Array(0x8001)
    big.fill(0x41)
    await proxyFetch("https://api.example.com/x", { body: big })
    const req = (mockInvoke.mock.calls[0][1] as { request: { body_b64?: string } }).request
    expect(typeof req.body_b64).toBe("string")
    expect((req.body_b64 ?? "").length).toBeGreaterThan(0)
  })

  it("returns an empty ArrayBuffer when body_b64 is empty", async () => {
    mockInvoke.mockResolvedValueOnce({ status: 200, mime: "x", body_b64: "" })
    const r = await proxyFetch("https://api.example.com/x", { json: {} })
    expect(r.bytes.byteLength).toBe(0)
  })

  it("defaults headers to {} when not provided", async () => {
    mockInvoke.mockResolvedValueOnce({ status: 200, mime: "x", body_b64: "" })
    await proxyFetch("https://api.example.com/x", { json: { a: 1 } })
    const req = (mockInvoke.mock.calls[0][1] as { request: { headers: Record<string, string> } })
      .request
    expect(req.headers).toEqual({})
  })
})
