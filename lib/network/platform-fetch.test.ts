import {
  createPlatformFetch,
  platformFetchKind,
  reachesNonCorsHosts,
  PlatformFetchUnavailableError,
} from "./platform-fetch"

import { measureOperation } from "@/lib/perf/operation-performance"

jest.mock("@/lib/perf/operation-performance", () => ({
  measureOperation: jest.fn((_name: string, callback: () => Promise<unknown>) => callback()),
}))

const detectPlatform = jest.fn<string, []>()
const getCapacitorHttp = jest.fn<unknown, []>()
const createProxyFetch = jest.fn()

jest.mock("@/lib/platform/detect", () => ({
  detectPlatform: () => detectPlatform(),
}))
jest.mock("@/lib/connectivity/capacitor-http", () => ({
  ...jest.requireActual("@/lib/connectivity/capacitor-http"),
  getCapacitorHttp: () => getCapacitorHttp(),
}))
jest.mock("@/lib/network/proxy-fetch", () => ({
  createProxyFetch: () => createProxyFetch(),
}))

beforeEach(() => {
  detectPlatform.mockReturnValue("web")
  getCapacitorHttp.mockReturnValue(null)
  createProxyFetch.mockReset()
  jest.mocked(measureOperation).mockClear()
})

describe("platformFetchKind", () => {
  it("routes the desktop shell through the native proxy bridge", () => {
    detectPlatform.mockReturnValue("tauri")
    expect(platformFetchKind()).toBe("tauri")
    expect(reachesNonCorsHosts()).toBe(true)
  })

  it("only claims the Capacitor path when the native plugin is actually present", () => {
    detectPlatform.mockReturnValue("mobile")
    // A mobile *web* build reports the platform without having the bridge.
    expect(platformFetchKind()).toBe("browser")
    getCapacitorHttp.mockReturnValue({ request: jest.fn() })
    expect(platformFetchKind()).toBe("capacitor")
  })

  it("admits that the browser is at the mercy of the target's CORS policy", () => {
    expect(platformFetchKind()).toBe("browser")
    expect(reachesNonCorsHosts()).toBe(false)
  })
})

describe("createPlatformFetch", () => {
  it("sends a JSON body through the Capacitor bridge as text", async () => {
    const request = jest.fn().mockResolvedValue({
      data: '{"ok":true}',
      status: 200,
      headers: { "content-type": "application/json" },
      url: "https://diag.test/v1/groups",
    })
    getCapacitorHttp.mockReturnValue({ request })
    const platformFetch = createPlatformFetch({ kind: "capacitor" })

    const response = await platformFetch("https://diag.test/v1/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    })

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", data: '{"status":"resolved"}' })
    )
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it("base64-encodes a binary body the native bridge could not otherwise carry", async () => {
    const request = jest.fn().mockResolvedValue({
      data: "{}",
      status: 201,
      headers: {},
      url: "https://diag.test/v1/incidents/x/parts/1",
    })
    getCapacitorHttp.mockReturnValue({ request })
    const platformFetch = createPlatformFetch({ kind: "capacitor" })

    await platformFetch("https://diag.test/v1/incidents/x/parts/1", {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([0, 1, 2, 253]),
    })

    // Without this the artifact would arrive as "[object ArrayBuffer]".
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ data: "AAEC/Q==", dataType: "file" })
    )
  })

  it("preserves untyped binary bytes instead of decoding them as UTF-8", async () => {
    const request = jest.fn().mockResolvedValue({ data: "", status: 200, headers: {} })
    getCapacitorHttp.mockReturnValue({ request })
    await createPlatformFetch({ kind: "capacitor" })("https://diag.test/upload", {
      method: "POST",
      body: new Uint8Array([0, 255, 128]),
    })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        data: "AP+A",
        dataType: "file",
        headers: expect.objectContaining({ "content-type": "application/octet-stream" }),
      })
    )
  })

  it("does not dispatch an already-aborted native request", async () => {
    const request = jest.fn()
    getCapacitorHttp.mockReturnValue({ request })
    const controller = new AbortController()
    controller.abort()
    await expect(
      createPlatformFetch({ kind: "capacitor" })("https://diag.test/upload", {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(request).not.toHaveBeenCalled()
  })

  it("rejects on cancellation and ignores a late native response", async () => {
    let resolve!: (response: unknown) => void
    const request = jest.fn(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    getCapacitorHttp.mockReturnValue({ request })
    const controller = new AbortController()
    const pending = createPlatformFetch({ kind: "capacitor" })("https://diag.test/upload", {
      signal: controller.signal,
    })
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    await new Promise((done) => setTimeout(done, 0))
    controller.abort()
    await rejected
    resolve({ status: 200, data: "late", headers: {} })
  })

  it("asks the Capacitor bridge for base64 and decodes it when the body is binary", async () => {
    const request = jest.fn().mockResolvedValue({
      data: "AAEC/Q==",
      status: 200,
      headers: { "content-type": "video/mp4" },
      url: "https://cdn.test/v.mp4",
    })
    getCapacitorHttp.mockReturnValue({ request })
    const platformFetch = createPlatformFetch({ kind: "capacitor" })

    const response = await platformFetch("https://cdn.test/v.mp4", {
      binaryResponse: true,
      timeout: 600_000,
    })

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        responseType: "blob",
        connectTimeout: 600_000,
        readTimeout: 600_000,
      })
    )
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([0, 1, 2, 253])
  })

  it("keeps the 30 s text defaults when the caller asks for neither", async () => {
    const request = jest.fn().mockResolvedValue({ data: "{}", status: 200, headers: {}, url: "" })
    getCapacitorHttp.mockReturnValue({ request })
    await createPlatformFetch({ kind: "capacitor" })("https://diag.test/v1/groups")
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ responseType: "text", connectTimeout: 30_000, readTimeout: 30_000 })
    )
  })

  it("passes the timeout to the desktop bridge and drops the binary hint", async () => {
    const proxied = jest.fn().mockResolvedValue(new Response("{}", { status: 200 }))
    createProxyFetch.mockReturnValue(proxied)
    await createPlatformFetch({ kind: "tauri" })("https://cdn.test/v.mp4", {
      timeout: 600_000,
      binaryResponse: true,
    })
    expect(proxied).toHaveBeenCalledWith("https://cdn.test/v.mp4", { timeout: 600_000 })
  })

  it("never hands a body to a status that forbids one", async () => {
    const request = jest.fn().mockResolvedValue({
      data: "",
      status: 204,
      headers: {},
      url: "https://diag.test/v1/incidents/x",
    })
    getCapacitorHttp.mockReturnValue({ request })
    const platformFetch = createPlatformFetch({ kind: "capacitor" })

    // `new Response("", {status: 204})` throws; an empty string is still a body.
    const response = await platformFetch("https://diag.test/v1/incidents/x", { method: "DELETE" })
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
  })

  it("reports a missing native bridge as its own error type", async () => {
    getCapacitorHttp.mockReturnValue(null)
    const platformFetch = createPlatformFetch({ kind: "capacitor" })
    await expect(platformFetch("https://diag.test/v1/groups")).rejects.toBeInstanceOf(
      PlatformFetchUnavailableError
    )
  })

  it("builds the proxied fetch once rather than per request on desktop", async () => {
    const proxied = jest.fn().mockResolvedValue(new Response("{}", { status: 200 }))
    createProxyFetch.mockReturnValue(proxied)
    const platformFetch = createPlatformFetch({ kind: "tauri" })

    await platformFetch("https://diag.test/v1/groups")
    await platformFetch("https://diag.test/v1/incidents")

    expect(createProxyFetch).toHaveBeenCalledTimes(1)
    expect(proxied).toHaveBeenCalledTimes(2)
  })
})

describe("platform fetch operation measurements", () => {
  it.each(["browser", "tauri", "capacitor"] as const)(
    "measures %s calls without changing the request or returned promise",
    async (kind) => {
      const response = new Response("private response", { status: 200 })
      const pending = Promise.resolve(response)
      const implementation = jest.fn(() => pending)
      const controller = new AbortController()
      const init = {
        method: "POST",
        credentials: "include" as const,
        signal: controller.signal,
        headers: { Authorization: "Bearer private-token" },
        body: "private body",
      }
      const input = new Request("https://private.test/path?secret=token")
      const platformFetch = createPlatformFetch({
        kind,
        browser: implementation,
        proxied: implementation,
        capacitor: implementation,
      })

      expect(platformFetch(input, init)).toBe(pending)
      expect(implementation).toHaveBeenCalledWith(input, init)
      expect(measureOperation).toHaveBeenCalledTimes(1)
      const [name, , classify] = jest.mocked(measureOperation).mock.calls[0]
      expect(name).toBe(`network.${kind}.fetch`)
      expect(classify?.(response)).toBe("success")
      expect(await pending).toBe(response)
      expect(response.bodyUsed).toBe(false)
    }
  )

  it("classifies HTTP failures without consuming or rejecting the response", async () => {
    const response = new Response("private failure", { status: 500 })
    const pending = Promise.resolve(response)
    const platformFetch = createPlatformFetch({ kind: "browser", browser: () => pending })

    expect(platformFetch("https://private.test")).toBe(pending)
    const classify = jest.mocked(measureOperation).mock.calls[0][2]
    expect(classify?.(response)).toBe("error")
    expect(await pending).toBe(response)
    expect(response.bodyUsed).toBe(false)
  })

  it.each([new Error("network failure"), new DOMException("cancelled", "AbortError")])(
    "preserves rejected promise and original error %s",
    async (error) => {
      const pending = Promise.reject(error)
      const platformFetch = createPlatformFetch({ kind: "browser", browser: () => pending })
      expect(platformFetch("https://private.test")).toBe(pending)
      await expect(pending).rejects.toBe(error)
    }
  )

  it("preserves synchronous transport errors", () => {
    const error = new Error("synchronous failure")
    const platformFetch = createPlatformFetch({
      kind: "tauri",
      proxied: () => {
        throw error
      },
    })
    expect(() => platformFetch("https://private.test")).toThrow(error)
  })

  it("keeps browser option filtering and original cancellation signal", async () => {
    const originalFetch = global.fetch
    const response = new Response("ok")
    const pending = Promise.resolve(response)
    const fetchMock = jest.fn(() => pending)
    global.fetch = fetchMock
    const controller = new AbortController()
    try {
      const result = createPlatformFetch({ kind: "browser" })("https://private.test", {
        timeout: 100,
        binaryResponse: true,
        credentials: "include",
        signal: controller.signal,
      })
      expect(result).toBe(pending)
      expect(fetchMock).toHaveBeenCalledWith("https://private.test", {
        credentials: "include",
        signal: controller.signal,
      })
      expect(await result).toBe(response)
    } finally {
      global.fetch = originalFetch
    }
  })
})
