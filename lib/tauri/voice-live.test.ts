import { voiceLiveClient } from "./voice-live"

const mockCall = jest.fn()
const mockHasNoLeakingPiiDeep = jest.fn<boolean, [unknown]>(() => true)

jest.mock("@/lib/tauri", () => ({
  transport: { call: (name: string, args?: unknown) => mockCall(name, args) },
}))

jest.mock("@cognia/redact", () => ({
  hasNoLeakingPiiDeep: (value: unknown) => mockHasNoLeakingPiiDeep(value),
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockCall.mockResolvedValue({ status: 200, mime: "application/json", body_b64: "e30=" })
})

describe("voiceLiveClient.proxyFetch", () => {
  const request = {
    provider: "openai",
    url: "https://api.openai.com/v1/realtime/client_secrets",
    method: "POST",
    headers: { "content-type": "application/json" },
    body_b64: "e30=",
  } as const

  it("invokes the shared host proxy with the payload nested under `request`", async () => {
    await voiceLiveClient.proxyFetch(request)

    // The Rust signature is `tts_proxy_fetch(request: ProxyRequest)`, so Tauri
    // expects the payload under a `request` key — a flattened body deserializes
    // to a missing-field error at the IPC boundary.
    expect(mockCall).toHaveBeenCalledWith("tts_proxy_fetch", { request })
  })

  it("returns the host response verbatim", async () => {
    await expect(voiceLiveClient.proxyFetch(request)).resolves.toEqual({
      status: 200,
      mime: "application/json",
      body_b64: "e30=",
    })
  })

  it("keeps the provider tag on the wire — it selects the keyring entry", async () => {
    await voiceLiveClient.proxyFetch({ ...request, provider: "google" })

    expect(mockCall.mock.calls[0][1].request.provider).toBe("google")
  })

  it("omits body_b64 for a bodiless relay", async () => {
    await voiceLiveClient.proxyFetch({
      provider: "xai",
      url: "https://api.x.ai/v1/realtime/client_secrets",
      method: "GET",
      headers: {},
    })

    expect(mockCall.mock.calls[0][1].request).not.toHaveProperty("body_b64")
  })

  it("propagates a host rejection", async () => {
    mockCall.mockRejectedValue(new Error("no API key is configured for 'openai'"))

    await expect(voiceLiveClient.proxyFetch(request)).rejects.toThrow(
      "no API key is configured for 'openai'"
    )
  })

  it("blocks a private request body before invoking the host proxy", async () => {
    mockHasNoLeakingPiiDeep.mockReturnValueOnce(false)
    const privateBody = btoa(JSON.stringify({ instructions: "alice@example.com" }))

    await expect(voiceLiveClient.proxyFetch({ ...request, body_b64: privateBody })).rejects.toThrow(
      "PII redaction gate"
    )
    expect(mockCall).not.toHaveBeenCalled()
  })
})
