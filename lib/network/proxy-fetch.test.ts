import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import {
  createProxyFetch,
  createRetryableProxyFetch,
  formatProxiedUrl,
  getCurrentProxyUrl,
  getProxyConfig,
  isProxyEnabled,
  shouldBypassProxy,
} from "./proxy-fetch"

jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))

const getState = jest.fn()
const getActiveProxyUrl = jest.fn()
const getNetworkProxy = jest.fn()
jest.mock("@/stores/system", () => ({
  useProxyStore: { getState: () => getState() },
  getActiveProxyUrl: (...args: unknown[]) => getActiveProxyUrl(...args),
  getNetworkProxy: () => getNetworkProxy(),
}))

const mockedInvoke = jest.mocked(invoke)
const mockedIsTauri = jest.mocked(isTauri)
const nativeResponse = (body: Uint8Array, status = 200) => ({
  status,
  bodyBase64: btoa(String.fromCharCode(...body)),
  headers: { "content-type": "application/octet-stream" },
})

beforeEach(() => {
  jest.clearAllMocks()
  mockedIsTauri.mockReturnValue(true)
  getState.mockReturnValue({
    config: {
      enabled: true,
      mode: "manual",
      url: "http://proxy.example:8080",
    },
  })
  getActiveProxyUrl.mockImplementation((state) => state?.config?.url ?? null)
  getNetworkProxy.mockReturnValue({ bypass: ["localhost", ".internal", "10.0.0.0/8"] })
})

describe("createProxyFetch", () => {
  it("sends a sanitized buffered request through the native policy", async () => {
    mockedInvoke.mockResolvedValue(nativeResponse(new TextEncoder().encode("ok")))

    const response = await createProxyFetch()("https://example.com/data", {
      method: "POST",
      headers: { "content-type": "text/plain", "x-test": "yes" },
      body: "hello",
      timeout: 2500,
      redirect: "manual",
    })

    expect(await response.text()).toBe("ok")
    expect(mockedInvoke).toHaveBeenCalledWith("proxy_http_request", {
      input: expect.objectContaining({
        url: "https://example.com/data",
        method: "POST",
        headers: expect.objectContaining({ "content-type": "text/plain", "x-test": "yes" }),
        bodyBase64: btoa("hello"),
        timeoutMs: 2500,
        redirect: "manual",
      }),
    })
    expect(JSON.stringify(mockedInvoke.mock.calls[0])).not.toContain("proxy_url")
  })

  it("uses standard Request/init precedence", async () => {
    mockedInvoke.mockResolvedValue(nativeResponse(new Uint8Array()))
    const original = new Request("https://example.com/old", {
      method: "POST",
      headers: { "x-base": "yes" },
      body: "old",
    })

    await createProxyFetch()(original, { method: "PUT", body: "new", headers: { "x-new": "yes" } })

    expect(mockedInvoke).toHaveBeenCalledWith("proxy_http_request", {
      input: expect.objectContaining({
        method: "PUT",
        headers: { "content-type": "text/plain;charset=UTF-8", "x-new": "yes" },
        bodyBase64: btoa("new"),
      }),
    })
  })

  it("preserves binary response bytes", async () => {
    const bytes = new Uint8Array([0, 255, 1, 128])
    mockedInvoke.mockResolvedValue(nativeResponse(bytes))
    const response = await createProxyFetch()("https://example.com/image")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  })

  it("rejects renderer supplied Proxy-Authorization", async () => {
    await expect(
      createProxyFetch()("https://example.com", {
        headers: { "Proxy-Authorization": "Basic secret" },
      })
    ).rejects.toThrow("Proxy-Authorization is reserved")
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it("cancels the native request when AbortSignal fires", async () => {
    let resolveNative!: (value: unknown) => void
    mockedInvoke.mockImplementation((command) =>
      command === "proxy_http_request"
        ? new Promise((resolve) => {
            resolveNative = resolve
          })
        : Promise.resolve(undefined)
    )
    const controller = new AbortController()
    const request = createProxyFetch()("https://example.com/slow", { signal: controller.signal })
    while (!mockedInvoke.mock.calls.some(([command]) => command === "proxy_http_request")) {
      await Promise.resolve()
    }
    controller.abort()
    await expect(request).rejects.toMatchObject({ name: "AbortError" })
    expect(mockedInvoke).toHaveBeenCalledWith("proxy_http_cancel", {
      requestId: expect.any(String),
    })
    resolveNative(nativeResponse(new Uint8Array()))
  })

  it("uses ordinary browser fetch outside Tauri", async () => {
    mockedIsTauri.mockReturnValue(false)
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("web"))
    const response = await createProxyFetch()("https://example.com")
    expect(await response.text()).toBe("web")
    expect(mockedInvoke).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe("null-body statuses", () => {
  // Regression: a zero-length ArrayBuffer is still a *body*, and the Response
  // constructor rejects any body on a null-body status. The TypeError was
  // thrown inside the try block and rewrapped as "Proxy request failed", which
  // sent readers hunting a network fault that never happened.
  it.each([204, 205, 304])("returns a %s response instead of throwing", async (status) => {
    mockedInvoke.mockResolvedValue(nativeResponse(new Uint8Array(), status))
    const response = await createProxyFetch()("https://example.test/resource")
    expect(response.status).toBe(status)
    expect(response.body).toBeNull()
  })

  it("preserves headers on a 304 so ETag revalidation can proceed", async () => {
    mockedInvoke.mockResolvedValue({
      status: 304,
      headers: { etag: 'W/"abc"', "x-ratelimit-remaining": "4999" },
      bodyBase64: "",
    })
    const response = await createProxyFetch()("https://example.test/resource")
    expect(response.status).toBe(304)
    expect(response.headers.get("etag")).toBe('W/"abc"')
    expect(response.headers.get("x-ratelimit-remaining")).toBe("4999")
  })

  it("still returns a body for a normal 200", async () => {
    mockedInvoke.mockResolvedValue(nativeResponse(new TextEncoder().encode("ok"), 200))
    await expect((await createProxyFetch()("https://example.test/resource")).text()).resolves.toBe(
      "ok"
    )
  })
})

describe("public proxy helpers", () => {
  it("returns only sanitized endpoint metadata", () => {
    getActiveProxyUrl.mockReturnValue("http://alice:secret@proxy.example:8080")
    expect(getCurrentProxyUrl()).toBe("http://proxy.example:8080/")
    expect(getProxyConfig()).toEqual({
      enabled: true,
      url: "http://proxy.example:8080/",
      host: "proxy.example",
      port: 8080,
      protocol: "http",
    })
    expect(formatProxiedUrl("https://target.example")).not.toContain("secret")
  })

  it("uses the configured bypass contract only for route previews", () => {
    expect(shouldBypassProxy("http://localhost:3000")).toBe(true)
    expect(shouldBypassProxy("https://api.internal")).toBe(true)
    expect(shouldBypassProxy("https://10.4.2.1")).toBe(true)
    expect(shouldBypassProxy("https://example.com")).toBe(false)
  })

  it("reports enabled state without exposing an environment override", () => {
    getActiveProxyUrl.mockReturnValue("http://proxy.example:8080")
    expect(isProxyEnabled()).toBe(true)
  })
})

describe("createRetryableProxyFetch", () => {
  it("retries retryable failures and eventually returns the response", async () => {
    mockedInvoke
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(nativeResponse(new TextEncoder().encode("ok")))
    const onRetry = jest.fn()
    const response = await createRetryableProxyFetch()("https://example.com", {
      maxRetries: 1,
      initialDelay: 0,
      onRetry,
    })
    expect(await response.text()).toBe("ok")
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("never retries an aborted request", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      createRetryableProxyFetch()("https://example.com", {
        signal: controller.signal,
        maxRetries: 3,
      })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(mockedInvoke).not.toHaveBeenCalled()
  })
})
