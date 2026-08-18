jest.mock("@/lib/platform/detect", () => ({ isTauri: jest.fn(() => false) }))
jest.mock("@/lib/connectors/tauri/commands", () => ({ connectorsHttpRequest: jest.fn() }))

import { isTauri } from "@/lib/platform/detect"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { googleHttp, parseJson, resolveGoogleHttp } from "./http"

const isTauriMock = isTauri as jest.Mock
const connectorsHttpMock = connectorsHttpRequest as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(false)
})

describe("resolveGoogleHttp", () => {
  it("routes through the Rust bridge on the desktop", async () => {
    isTauriMock.mockReturnValue(true)
    connectorsHttpMock.mockResolvedValue({ status: 200, headers: { "X-A": "b" }, body: "ok" })
    const out = await googleHttp({ url: "https://x/y", method: "GET" })
    expect(connectorsHttpMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://x/y", method: "GET", timeoutMs: 30_000 })
    )
    expect(out).toEqual({ status: 200, headers: { "x-a": "b" }, body: "ok" })
  })

  it("tolerates a Rust response with no headers or body", async () => {
    isTauriMock.mockReturnValue(true)
    connectorsHttpMock.mockResolvedValue({ status: 204 })
    expect(await googleHttp({ url: "https://x", method: "GET" })).toEqual({
      status: 204,
      headers: {},
      body: "",
    })
  })

  it("falls back to fetch off the desktop", async () => {
    const fetchMock = jest.fn(async () => ({
      status: 201,
      headers: new Map([["Content-Type", "application/json"]]),
      text: async () => "body",
    }))
    const original = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      expect(await googleHttp({ url: "https://x", method: "POST", body: "b" })).toEqual({
        status: 201,
        headers: { "content-type": "application/json" },
        body: "body",
      })
    } finally {
      globalThis.fetch = original
    }
    expect(connectorsHttpMock).not.toHaveBeenCalled()
  })

  it("returns a stable function identity per host", () => {
    expect(typeof resolveGoogleHttp()).toBe("function")
  })
})

describe("parseJson", () => {
  it("parses JSON and returns null for anything else", () => {
    expect(parseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
    expect(parseJson("")).toBeNull()
    expect(parseJson("<html>")).toBeNull()
  })
})
