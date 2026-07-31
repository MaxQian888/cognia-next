const mockInvoke = jest.fn()
const mockIsTauri = jest.fn()

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

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

const fetchMock = jest.fn()

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

describe("local provider helpers", () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockIsTauri.mockReset()
    fetchMock.mockReset()
    setProviderCoreRuntimeAdapters({ isTauri: () => mockIsTauri() })
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
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

  it("uses the Tauri Ollama status command before falling through to HTTP", async () => {
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockResolvedValueOnce({ connected: true, version: "0.6.0" })

    await expect(getLocalProviderStatus("ollama")).resolves.toMatchObject({
      connected: true,
      version: "0.6.0",
    })
    expect(mockInvoke).toHaveBeenCalledWith("ollama_get_status", {
      baseUrl: "http://localhost:11434",
    })
  })

  it("falls back from the Tauri Ollama status command to HTTP status checks", async () => {
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockRejectedValueOnce(new Error("command missing"))
    fetchMock.mockResolvedValueOnce(response({ build: { version: "1.2.3" } }))

    await expect(getLocalProviderStatus("ollama", "http://localhost:11434/v1")).resolves.toEqual({
      connected: true,
      version: "1.2.3",
      models_count: undefined,
    })
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:11434/api/version", {
      method: "GET",
      signal: expect.any(AbortSignal),
    })
  })

  it("probes HTTP status and model endpoints in browser mode", async () => {
    mockIsTauri.mockReturnValue(false)
    fetchMock.mockResolvedValueOnce(response({ version: "1.0.0", models: [1, 2] }))

    await expect(getLocalProviderStatus("ollama")).resolves.toMatchObject({
      connected: true,
      version: "1.0.0",
      models_count: 2,
    })

    fetchMock.mockResolvedValueOnce(response({ data: [{ id: "local-model", object: "model" }] }))
    await expect(listLocalProviderModels("lmstudio")).resolves.toEqual([
      { id: "local-model", object: "model" },
    ])
  })

  it("reports HTTP and non-Error status failures conservatively", async () => {
    fetchMock.mockResolvedValueOnce(response({}, 503))
    await expect(getLocalProviderStatus("lmstudio")).resolves.toEqual({
      connected: false,
      error: "HTTP 503",
    })

    fetchMock.mockRejectedValueOnce("offline")
    await expect(getLocalProviderStatus("lmstudio")).resolves.toEqual({
      connected: false,
      error: "Connection failed",
    })
  })

  it("handles local model listing fallbacks and response shapes", async () => {
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockResolvedValueOnce([{ name: "", model: "llama3" }])
    await expect(listLocalProviderModels("ollama")).resolves.toEqual([
      { id: "llama3", object: "model" },
    ])

    mockInvoke.mockRejectedValueOnce(new Error("command missing"))
    fetchMock.mockResolvedValueOnce(response({ models: [{ model: "qwen2" }] }))
    await expect(listLocalProviderModels("ollama")).resolves.toEqual([
      { id: "qwen2", object: "model" },
    ])

    fetchMock.mockResolvedValueOnce(response({}, 404))
    await expect(listLocalProviderModels("lmstudio")).resolves.toEqual([])

    fetchMock.mockResolvedValueOnce(response({ ok: true }))
    await expect(listLocalProviderModels("lmstudio")).resolves.toEqual([])

    fetchMock.mockRejectedValueOnce(new Error("offline"))
    await expect(listLocalProviderModels("lmstudio")).resolves.toEqual([])

    await expect(listLocalProviderModels("ghost")).resolves.toEqual([])
  })

  it("formats successful connection tests with optional version and model counts", async () => {
    fetchMock.mockResolvedValueOnce(response({ version: "0.6.0", models: ["a", "b"] }))
    await expect(testLocalProviderConnection("ollama")).resolves.toMatchObject({
      success: true,
      message: "Connected v0.6.0 (2 models)",
    })

    fetchMock.mockResolvedValueOnce(response({}))
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

    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    await expect(testLocalProviderConnection("ollama")).resolves.toMatchObject({
      success: false,
      message: "ECONNREFUSED",
    })
  })
})
