import { runProviderProbe } from "./probe"

describe("runProviderProbe", () => {
  it("separates HTTP reachability from failed authentication", async () => {
    const fetchImpl = jest.fn(async () => new Response("unauthorized", { status: 401 }))

    const result = await runProviderProbe(
      {
        providerId: "openai",
        protocol: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "secret",
      },
      {
        fetchImpl,
        now: (() => {
          let value = 0
          return () => (value += 10)
        })(),
      }
    )

    expect(result).toEqual(
      expect.objectContaining({
        reachable: true,
        authenticated: false,
        capabilityVerified: false,
        httpStatus: 401,
        failure: expect.objectContaining({ code: "authentication", retryable: false }),
      })
    )
  })

  it("never treats an arbitrary HTTP 400 as a successful model check", async () => {
    const result = await runProviderProbe(
      {
        providerId: "anthropic",
        protocol: "anthropic",
        baseURL: "https://api.anthropic.com",
        apiKey: "secret",
      },
      { fetchImpl: async () => new Response("bad request", { status: 400 }) }
    )

    expect(result.reachable).toBe(true)
    expect(result.capabilityVerified).toBe(false)
    expect(result.failure?.code).toBe("invalid-response")
  })

  it("uses a header rather than a query-string credential for Gemini", async () => {
    const fetchImpl: jest.MockedFunction<typeof fetch> = jest.fn(
      async (..._args: Parameters<typeof fetch>) => new Response('{"models":[]}', { status: 200 })
    )

    await runProviderProbe(
      {
        providerId: "google",
        protocol: "google",
        baseURL: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-secret",
      },
      { fetchImpl }
    )

    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).not.toContain("gemini-secret")
    expect(init?.headers).toEqual(expect.objectContaining({ "x-goog-api-key": "gemini-secret" }))
    expect(init?.method).toBe("GET")
  })

  it("retries transient transport failures twice but not authentication failures", async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(new Response('{"data":[]}', { status: 200 }))

    const result = await runProviderProbe(
      {
        providerId: "openai",
        protocol: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "secret",
      },
      { fetchImpl, delay: async () => undefined }
    )

    expect(result.capabilityVerified).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(3)

    fetchImpl.mockClear()
    fetchImpl.mockResolvedValue(new Response("unauthorized", { status: 401 }))
    await runProviderProbe(
      {
        providerId: "openai",
        protocol: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "secret",
      },
      { fetchImpl, delay: async () => undefined }
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("aborts the active transport immediately when the diagnostic job is cancelled", async () => {
    const controller = new AbortController()
    const fetchImpl = jest.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        })
    )
    const running = runProviderProbe(
      {
        providerId: "openai",
        protocol: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: "secret",
      },
      { fetchImpl, signal: controller.signal, delay: async () => undefined }
    )
    controller.abort(new DOMException("cancelled", "AbortError"))

    await expect(running).resolves.toEqual(
      expect.objectContaining({
        reachable: false,
        failure: expect.objectContaining({ code: "aborted" }),
      })
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
