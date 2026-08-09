import { createLiveVoiceFetch, HOST_INJECTED_API_KEY } from "./proxy-fetch"

const mockProxyFetch = jest.fn()

jest.mock("@/lib/tauri/voice-live", () => ({
  voiceLiveClient: { proxyFetch: (request: unknown) => mockProxyFetch(request) },
}))

const utf8 = new TextDecoder("utf-8")

/** Decode what the shim put on the wire, so assertions read as plain text. */
function sentBody(): string | undefined {
  const b64 = mockProxyFetch.mock.calls.at(-1)?.[0]?.body_b64
  if (b64 === undefined) return undefined
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return utf8.decode(bytes)
}

function hostReturns(body: unknown, status = 200) {
  mockProxyFetch.mockResolvedValue({
    status,
    mime: "application/json",
    body_b64: btoa(JSON.stringify(body)),
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  hostReturns({ value: "ek_secret" })
})

describe("createLiveVoiceFetch", () => {
  it("tags the request with the provider so the host injects the right key", async () => {
    await createLiveVoiceFetch("xai")("https://api.x.ai/v1/realtime/client_secrets", {
      method: "POST",
    })

    expect(mockProxyFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "xai",
        url: "https://api.x.ai/v1/realtime/client_secrets",
      })
    )
  })

  it("returns a real Response the SDK can parse", async () => {
    hostReturns({ value: "ek_secret", expires_at: 42 })

    const response = await createLiveVoiceFetch("openai")("https://api.openai.com/x")

    expect(response.ok).toBe(true)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/json")
    await expect(response.json()).resolves.toEqual({ value: "ek_secret", expires_at: 42 })
  })

  it("surfaces an upstream failure as a non-ok Response, not a throw", async () => {
    // The SDK reads `response.ok` and then `.text()` to build its error; a throw
    // here would replace the vendor's message with a transport-looking one.
    mockProxyFetch.mockResolvedValue({
      status: 401,
      mime: "application/json",
      body_b64: btoa(`{"error":"invalid key"}`),
    })

    const response = await createLiveVoiceFetch("openai")("https://api.openai.com/x")

    expect(response.ok).toBe(false)
    expect(response.status).toBe(401)
    await expect(response.text()).resolves.toContain("invalid key")
  })

  it("defaults to POST — every realtime mint is one", async () => {
    await createLiveVoiceFetch("openai")("https://api.openai.com/x")

    expect(mockProxyFetch).toHaveBeenCalledWith(expect.objectContaining({ method: "POST" }))
  })

  it("upper-cases the method", async () => {
    await createLiveVoiceFetch("openai")("https://api.openai.com/x", { method: "get" })

    expect(mockProxyFetch).toHaveBeenCalledWith(expect.objectContaining({ method: "GET" }))
  })
})

describe("createLiveVoiceFetch — request bodies", () => {
  it("forwards a JSON string body byte-for-byte", async () => {
    await createLiveVoiceFetch("openai")("https://api.openai.com/x", {
      method: "POST",
      body: JSON.stringify({ session: { model: "gpt-realtime" } }),
    })

    expect(sentBody()).toBe(`{"session":{"model":"gpt-realtime"}}`)
  })

  it("encodes non-ASCII instructions as UTF-8", async () => {
    // `btoa` throws on these outright, so a naive encoder fails loudly here —
    // and Chinese personas are the common case, not an edge case.
    await createLiveVoiceFetch("openai")("https://api.openai.com/x", {
      method: "POST",
      body: JSON.stringify({ instructions: "你好，请简短回答" }),
    })

    expect(sentBody()).toBe(`{"instructions":"你好，请简短回答"}`)
  })

  it("omits the body for a bodiless request", async () => {
    await createLiveVoiceFetch("openai")("https://api.openai.com/x", { method: "GET" })

    expect(mockProxyFetch.mock.calls[0][0]).not.toHaveProperty("body_b64")
  })

  it("omits an empty string body rather than sending zero bytes", async () => {
    await createLiveVoiceFetch("openai")("https://api.openai.com/x", { body: "" })

    expect(mockProxyFetch.mock.calls[0][0]).not.toHaveProperty("body_b64")
  })

  it.each([
    ["Uint8Array", () => new Uint8Array([104, 105])],
    ["ArrayBuffer", () => new Uint8Array([104, 105]).buffer],
    ["Blob", () => new Blob(["hi"])],
  ])("forwards a %s body", async (_label, build) => {
    await createLiveVoiceFetch("openai")("https://api.openai.com/x", {
      body: build() as BodyInit,
    })

    expect(sentBody()).toBe("hi")
  })

  it("refuses a body shape the host proxy cannot represent", async () => {
    await expect(
      createLiveVoiceFetch("openai")("https://api.openai.com/x", {
        body: new URLSearchParams({ a: "b" }),
      })
    ).rejects.toThrow(/cannot forward this request body type/)
  })
})

describe("createLiveVoiceFetch — headers", () => {
  it("flattens a Headers instance", async () => {
    await createLiveVoiceFetch("openai")("https://api.openai.com/x", {
      headers: new Headers({ "Content-Type": "application/json" }),
    })

    expect(mockProxyFetch.mock.calls[0][0].headers).toEqual({ "content-type": "application/json" })
  })

  it("flattens an entry-pair array", async () => {
    await createLiveVoiceFetch("openai")("https://api.openai.com/x", {
      headers: [["x-trace", "1"]],
    })

    expect(mockProxyFetch.mock.calls[0][0].headers).toEqual({ "x-trace": "1" })
  })

  it("passes a plain record through", async () => {
    await createLiveVoiceFetch("openai")("https://api.openai.com/x", {
      headers: { Authorization: `Bearer ${HOST_INJECTED_API_KEY}` },
    })

    expect(mockProxyFetch.mock.calls[0][0].headers).toEqual({
      Authorization: `Bearer ${HOST_INJECTED_API_KEY}`,
    })
  })

  it("sends an empty map when there are no headers", async () => {
    await createLiveVoiceFetch("openai")("https://api.openai.com/x")

    expect(mockProxyFetch.mock.calls[0][0].headers).toEqual({})
  })
})

describe("createLiveVoiceFetch — input shapes", () => {
  it("accepts a URL object", async () => {
    await createLiveVoiceFetch("openai")(new URL("https://api.openai.com/v1/x"))

    expect(mockProxyFetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://api.openai.com/v1/x" })
    )
  })

  it("reads url, method and body off a Request when init is empty", async () => {
    // `fetch(new Request(...))` puts everything on the Request; reading only
    // `init` would silently post an empty body.
    await createLiveVoiceFetch("openai")(
      new Request("https://api.openai.com/v1/x", { method: "POST", body: "payload" })
    )

    expect(mockProxyFetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://api.openai.com/v1/x", method: "POST" })
    )
    expect(sentBody()).toBe("payload")
  })

  it("lets init override the Request's method", async () => {
    await createLiveVoiceFetch("openai")(new Request("https://api.openai.com/v1/x"), {
      method: "PUT",
    })

    expect(mockProxyFetch).toHaveBeenCalledWith(expect.objectContaining({ method: "PUT" }))
  })
})

describe("createLiveVoiceFetch — response edge cases", () => {
  it("builds a bodiless Response for a null-body status", async () => {
    // `new Response(bytes, { status: 204 })` is a TypeError; the host can
    // legitimately relay a 204 from a vendor.
    mockProxyFetch.mockResolvedValue({ status: 204, mime: "application/json", body_b64: "" })

    const response = await createLiveVoiceFetch("openai")("https://api.openai.com/x")

    expect(response.status).toBe(204)
    await expect(response.text()).resolves.toBe("")
  })

  it("falls back to a generic media type when the host reports none", async () => {
    mockProxyFetch.mockResolvedValue({ status: 200, mime: "", body_b64: "" })

    const response = await createLiveVoiceFetch("openai")("https://api.openai.com/x")

    expect(response.headers.get("content-type")).toBe("application/octet-stream")
  })

  it.each([0, 199, 600, 1.5])(
    "rejects an unusable status (%s) with a clear error",
    async (status) => {
      mockProxyFetch.mockResolvedValue({ status, mime: "", body_b64: "" })

      await expect(createLiveVoiceFetch("openai")("https://api.openai.com/x")).rejects.toThrow(
        /unusable status/
      )
    }
  )

  it("propagates a host rejection unchanged", async () => {
    mockProxyFetch.mockRejectedValue(new Error("no API key is configured for 'openai'"))

    await expect(createLiveVoiceFetch("openai")("https://api.openai.com/x")).rejects.toThrow(
      "no API key is configured for 'openai'"
    )
  })

  it("uses the injected proxy seam when one is supplied", async () => {
    const proxyFetch = jest
      .fn()
      .mockResolvedValue({ status: 200, mime: "text/plain", body_b64: btoa("ok") })

    const response = await createLiveVoiceFetch("openai", { proxyFetch })(
      "https://api.openai.com/x"
    )

    await expect(response.text()).resolves.toBe("ok")
    expect(mockProxyFetch).not.toHaveBeenCalled()
  })
})
