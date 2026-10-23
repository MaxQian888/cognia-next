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
  it.each([undefined, 42, "", "x".repeat(129)])(
    "rejects malformed prepare acknowledgements before HTTP: %j",
    async (token) => {
      mockedInvoke.mockImplementation((command) =>
        Promise.resolve(command === "proxy_get_active" ? { requestAdmissionVersion: 1 } : token)
      )
      await expect(createProxyFetch()("https://files.example/data")).rejects.toThrow(
        "request_admission_invalid"
      )
      expect(mockedInvoke.mock.calls.map(([command]) => command)).toEqual([
        "proxy_get_active",
        "proxy_http_prepare",
      ])
    }
  )

  it.each([0, 2, "1"])(
    "refuses an unknown admission protocol before HTTP: %j",
    async (requestAdmissionVersion) => {
      mockedInvoke.mockResolvedValue({ requestAdmissionVersion })
      await expect(createProxyFetch()("https://files.example/data")).rejects.toThrow(
        "request_admission_unsupported"
      )
      expect(mockedInvoke.mock.calls.map(([command]) => command)).toEqual(["proxy_get_active"])
    }
  )

  it("prepares a generation before dispatch so cancellation before native request entry prevents I/O", async () => {
    let prepared = false
    let cancelled = false
    let startNative!: () => void
    let ioCount = 0
    mockedInvoke.mockImplementation((command, args) => {
      if (command === "proxy_get_active") return Promise.resolve({ requestAdmissionVersion: 1 })
      if (command === "proxy_http_prepare") {
        prepared = true
        return Promise.resolve("admission-a")
      }
      if (command === "proxy_http_cancel") {
        if (prepared && (args as { admissionToken?: string }).admissionToken === "admission-a")
          cancelled = true
        return Promise.resolve(cancelled)
      }
      return new Promise((resolve) => {
        startNative = () => {
          if (!cancelled) ioCount += 1
          resolve(nativeResponse(new Uint8Array([255])))
        }
      })
    })
    const controller = new AbortController()
    const pending = createProxyFetch()("https://files.example/data", { signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    for (let i = 0; i < 30 && !startNative; i++) await Promise.resolve()
    expect(startNative).toBeDefined()
    controller.abort()
    await rejected
    startNative()
    await Promise.resolve()
    expect(ioCount).toBe(0)
    expect(mockedInvoke).toHaveBeenCalledWith("proxy_http_request", {
      input: expect.objectContaining({ admissionToken: "admission-a" }),
    })
  })

  it("cancels while the native capability check is pending without starting a download", async () => {
    let finish!: (value: unknown) => void
    mockedInvoke.mockImplementation((command) =>
      command === "proxy_get_active"
        ? new Promise((resolve) => {
            finish = resolve
          })
        : Promise.resolve(true)
    )
    const controller = new AbortController()
    const pending = createProxyFetch()("https://files.example/data", {
      signal: controller.signal,
      downloadPolicy: { allowedOrigins: ["https://files.example"], maxBytes: 5 },
    })
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    for (let i = 0; i < 10 && !finish; i++) await Promise.resolve()
    expect(finish).toBeDefined()
    controller.abort()
    await rejected
    finish({ downloadPolicyVersion: 2, requestAdmissionVersion: 1 })
    await Promise.resolve()
    expect(mockedInvoke.mock.calls.map(([command]) => command)).toEqual(["proxy_get_active"])
  })

  it("releases a late prepare acknowledgement after cancellation without dispatching HTTP", async () => {
    let finish!: (token: string) => void
    mockedInvoke.mockImplementation((command) => {
      if (command === "proxy_get_active") return Promise.resolve({ requestAdmissionVersion: 1 })
      if (command === "proxy_http_prepare")
        return new Promise((resolve) => {
          finish = resolve
        })
      return Promise.resolve(true)
    })
    const controller = new AbortController()
    const pending = createProxyFetch()("https://files.example/data", { signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    for (let i = 0; i < 30 && !finish; i++) await Promise.resolve()
    expect(finish).toBeDefined()
    controller.abort()
    await rejected
    finish("late-admission")
    await Promise.resolve()
    expect(mockedInvoke).toHaveBeenCalledWith("proxy_http_cancel", {
      requestId: expect.any(String),
      admissionToken: "late-admission",
    })
    expect(mockedInvoke.mock.calls.some(([command]) => command === "proxy_http_request")).toBe(
      false
    )
  })

  it.each(["capability", "prepare", "body"])(
    "bounds the %s wait and discards a late native result",
    async (phase) => {
      jest.useFakeTimers()
      try {
        let finish!: (value: unknown) => void
        mockedInvoke.mockImplementation((command) => {
          if (command === "proxy_http_cancel") return Promise.resolve(true)
          if (command === "proxy_get_active" && phase !== "capability")
            return Promise.resolve({ downloadPolicyVersion: 2, requestAdmissionVersion: 1 })
          if (command === "proxy_http_prepare" && phase === "body")
            return Promise.resolve("download-admission")
          return new Promise((resolve) => {
            finish = resolve
          })
        })
        const pending = createProxyFetch()("https://files.example/data", {
          timeout: 25,
          downloadPolicy: { allowedOrigins: ["https://files.example"], maxBytes: 5 },
        })
        const rejected = expect(pending).rejects.toThrow("download_timed_out")
        for (let i = 0; i < 20 && !finish; i++) await Promise.resolve()
        expect(finish).toBeDefined()
        await jest.advanceTimersByTimeAsync(25)
        await rejected
        finish(
          phase === "body"
            ? nativeResponse(new Uint8Array([255]))
            : phase === "prepare"
              ? "late-admission"
              : { downloadPolicyVersion: 2, requestAdmissionVersion: 1 }
        )
        await Promise.resolve()
        expect(
          mockedInvoke.mock.calls.filter(([command]) => command === "proxy_http_request")
        ).toHaveLength(phase === "body" ? 1 : 0)
        if (phase === "capability")
          expect(mockedInvoke.mock.calls.some(([command]) => command === "proxy_http_cancel")).toBe(
            false
          )
        else
          expect(mockedInvoke).toHaveBeenCalledWith("proxy_http_cancel", {
            requestId: expect.any(String),
            admissionToken: phase === "prepare" ? "late-admission" : "download-admission",
          })
        expect(jest.getTimerCount()).toBe(0)
      } finally {
        jest.useRealTimers()
      }
    }
  )

  it("checks native strict capability before passing the download policy and preserving bytes", async () => {
    const bytes = new Uint8Array([0, 255, 128, 80, 75])
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "proxy_get_active")
        return { downloadPolicyVersion: 2, requestAdmissionVersion: 1 }
      if (command === "proxy_http_prepare") return "download-admission"
      return nativeResponse(bytes)
    })
    const downloadPolicy = { allowedOrigins: ["https://files.example"], maxBytes: 5 }
    const response = await createProxyFetch()("https://files.example/opaque?token=secret", {
      downloadPolicy,
    })
    expect(mockedInvoke.mock.calls[0]?.[0]).toBe("proxy_get_active")
    expect(mockedInvoke).toHaveBeenCalledWith("proxy_http_request", {
      input: expect.objectContaining({ downloadPolicy }),
    })
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  })

  it.each([{}, { downloadPolicyVersion: 1 }, { downloadPolicyVersion: 2 }])(
    "does not issue a download to a host without both boundary capabilities: %j",
    async (capabilities) => {
      mockedInvoke.mockResolvedValue(capabilities)
      await expect(
        createProxyFetch()("https://files.example/secret", {
          downloadPolicy: { allowedOrigins: ["https://files.example"], maxBytes: 5 },
        })
      ).rejects.toThrow("download_policy_unsupported")
      expect(mockedInvoke.mock.calls.map(([command]) => command)).toEqual(["proxy_get_active"])
    }
  )

  it("refuses a strict request in an ordinary browser before network I/O", async () => {
    mockedIsTauri.mockReturnValue(false)
    const fetchSpy = jest.spyOn(globalThis, "fetch")
    await expect(
      createProxyFetch()("https://files.example/secret", {
        downloadPolicy: { allowedOrigins: ["https://files.example"], maxBytes: 5 },
      })
    ).rejects.toThrow("download_policy_unsupported")
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
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
