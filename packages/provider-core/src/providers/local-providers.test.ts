import {
  resetProviderCoreRuntimeAdaptersForTesting,
  setProviderCoreRuntimeAdapters,
} from "./runtime-adapters"
import {
  getDefaultBaseURL,
  getDefaultLocalProviderPort,
  getDefaultLocalProviderUrl,
  getLocalProviderIds,
  getLocalProviderStatus,
  isLocalProvider,
  listLocalProviderModels,
  normalizeBaseUrl,
  testLocalProviderConnection,
} from "./local-providers"

const proxyFetchMock = jest.fn()

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

describe("local provider helpers", () => {
  beforeEach(() => {
    proxyFetchMock.mockReset()
    setProviderCoreRuntimeAdapters({
      proxyFetch: proxyFetchMock,
      isTauri: () => false,
    })
  })

  afterEach(() => {
    resetProviderCoreRuntimeAdaptersForTesting()
  })

  it("normalizes URLs and exposes canonical local provider metadata", () => {
    expect(normalizeBaseUrl(" http://localhost:11434/v1/ ")).toBe("http://localhost:11434")
    expect(normalizeBaseUrl(" http://localhost:11434/api ")).toBe("http://localhost:11434/api")
    expect(getDefaultLocalProviderUrl("ollama")).toBe("http://localhost:11434")
    expect(getDefaultLocalProviderUrl("ghost" as never)).toBe("")
    expect(getDefaultLocalProviderPort("ollama")).toBe(11434)
    expect(getDefaultLocalProviderPort("ghost" as never)).toBe(0)
    expect(getDefaultBaseURL("unknown")).toBe("http://localhost:8080")
    expect(isLocalProvider("ollama")).toBe(true)
    expect(isLocalProvider("ghost")).toBe(false)
    expect(getLocalProviderIds()).toContain("lmstudio")
  })

  it("probes the descriptor health endpoint through proxyFetch", async () => {
    proxyFetchMock.mockResolvedValueOnce(response({ build: { version: "1.2.3" } }))

    await expect(getLocalProviderStatus("ollama", "http://localhost:11434/v1")).resolves.toEqual({
      connected: true,
      version: "1.2.3",
      models_count: undefined,
    })
    expect(proxyFetchMock).toHaveBeenCalledWith("http://localhost:11434/api/version", {
      method: "GET",
      timeout: 5000,
    })
  })

  it("counts models from either local or OpenAI-compatible payloads", async () => {
    proxyFetchMock.mockResolvedValueOnce(response({ version: "1.0.0", models: [1, 2] }))

    await expect(getLocalProviderStatus("ollama")).resolves.toMatchObject({
      connected: true,
      version: "1.0.0",
      models_count: 2,
    })

    proxyFetchMock.mockResolvedValueOnce(
      response({ data: [{ id: "local-model", object: "model" }] })
    )
    await expect(listLocalProviderModels("lmstudio")).resolves.toEqual([
      { id: "local-model", object: "model" },
    ])
  })

  it("reports HTTP and non-Error status failures conservatively", async () => {
    proxyFetchMock.mockResolvedValueOnce(response({}, 503))
    await expect(getLocalProviderStatus("lmstudio")).resolves.toEqual({
      connected: false,
      error: "HTTP 503",
    })

    proxyFetchMock.mockRejectedValueOnce("offline")
    await expect(getLocalProviderStatus("lmstudio")).resolves.toEqual({
      connected: false,
      error: "Connection failed",
    })
  })

  it("handles local model listing response shapes and failures", async () => {
    proxyFetchMock.mockResolvedValueOnce(response({ models: [{ model: "llama3" }] }))
    await expect(listLocalProviderModels("ollama")).resolves.toEqual([
      { id: "llama3", object: "model", owned_by: undefined },
    ])

    proxyFetchMock.mockResolvedValueOnce(
      response({ data: [{ id: "qwen2", object: "model", owned_by: "local" }] })
    )
    await expect(listLocalProviderModels("lmstudio")).resolves.toEqual([
      { id: "qwen2", object: "model", created: undefined, owned_by: "local" },
    ])

    proxyFetchMock.mockResolvedValueOnce(response({}, 404))
    await expect(listLocalProviderModels("lmstudio")).rejects.toThrow("HTTP 404")

    proxyFetchMock.mockResolvedValueOnce(response({ ok: true }))
    await expect(listLocalProviderModels("lmstudio")).rejects.toThrow("Invalid model list response")

    proxyFetchMock.mockRejectedValueOnce(new Error("offline"))
    await expect(listLocalProviderModels("lmstudio")).rejects.toThrow("offline")

    await expect(listLocalProviderModels("ghost")).resolves.toEqual([])
  })

  it("formats successful connection tests with optional version and model counts", async () => {
    proxyFetchMock.mockResolvedValueOnce(response({ version: "0.6.0", models: ["a", "b"] }))
    await expect(testLocalProviderConnection("ollama")).resolves.toMatchObject({
      success: true,
      message: "Connected v0.6.0 (2 models)",
    })

    proxyFetchMock.mockResolvedValueOnce(response({}))
    await expect(testLocalProviderConnection("lmstudio")).resolves.toMatchObject({
      success: true,
      message: "Connected",
    })
  })

  it("wraps status into connection-test output and handles unknown providers", async () => {
    await expect(getLocalProviderStatus("missing")).resolves.toMatchObject({
      connected: false,
      error: "Unknown provider: missing",
    })

    proxyFetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    await expect(testLocalProviderConnection("ollama")).resolves.toMatchObject({
      success: false,
      message: "ECONNREFUSED",
    })
  })
})
