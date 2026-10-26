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

describe("request cancellation", () => {
  it("does not dispatch a pre-aborted native request", async () => {
    isTauriMock.mockReturnValue(true)
    const controller = new AbortController()
    controller.abort()
    await expect(
      googleHttp({ url: "https://x", method: "GET", signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(connectorsHttpMock).not.toHaveBeenCalled()
  })

  it("forwards an active cancellation to fetch", async () => {
    const controller = new AbortController()
    let fetchSignal: AbortSignal | null | undefined
    const original = globalThis.fetch
    globalThis.fetch = jest.fn(async (_url, init) => {
      fetchSignal = init?.signal
      controller.abort()
      return { status: 200, headers: new Map(), text: async () => "late" } as unknown as Response
    })
    try {
      await expect(
        googleHttp({ url: "https://x", method: "GET", signal: controller.signal })
      ).rejects.toMatchObject({ name: "AbortError" })
      expect(fetchSignal?.aborted).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })

  it("releases the native caller on abort even while the native bridge is pending", async () => {
    isTauriMock.mockReturnValue(true)
    connectorsHttpMock.mockReturnValue(new Promise(() => undefined))
    const controller = new AbortController()
    const request = googleHttp({ url: "https://x", method: "GET", signal: controller.signal })
    controller.abort()
    await expect(request).rejects.toMatchObject({ name: "AbortError" })
  })
})
