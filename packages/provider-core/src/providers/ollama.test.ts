import {
  copyOllamaModel,
  deleteOllamaModel,
  generateOllamaEmbedding,
  getOllamaModelCapabilities,
  getOllamaStatus,
  isOllamaEmbeddingModel,
  listOllamaModels,
  listRunningModels,
  pullOllamaModel,
  showOllamaModel,
  stopOllamaModel,
} from "./ollama"
import {
  resetProviderCoreRuntimeAdaptersForTesting,
  setProviderCoreRuntimeAdapters,
} from "./runtime-adapters"

const proxyFetch = jest.fn()
const originalFetch = global.fetch

function makeResponse(init: {
  status?: number
  statusText?: string
  body?: unknown
  rawText?: string
  jsonThrows?: boolean
}): Response {
  const status = init.status ?? 200
  const ok = status >= 200 && status < 300
  return {
    ok,
    status,
    statusText: init.statusText ?? "",
    json: async () => {
      if (init.jsonThrows) throw new Error("invalid json")
      return init.body
    },
    text: async () => init.rawText ?? JSON.stringify(init.body ?? ""),
  } as unknown as Response
}

describe("generateOllamaEmbedding", () => {
  beforeEach(() => {
    proxyFetch.mockReset()
    setProviderCoreRuntimeAdapters({ proxyFetch })
  })

  afterEach(() => {
    resetProviderCoreRuntimeAdaptersForTesting()
  })

  it("posts JSON to {baseURL}/api/embeddings and returns the embedding array", async () => {
    proxyFetch.mockResolvedValue(makeResponse({ body: { embedding: [0.1, 0.2, 0.3] } }))

    const out = await generateOllamaEmbedding("http://localhost:11434", "nomic-embed-text", "hello")

    expect(out).toEqual([0.1, 0.2, 0.3])
    const call = proxyFetch.mock.calls[0]
    expect(call[0]).toBe("http://localhost:11434/api/embeddings")
    expect(call[1].method).toBe("POST")
    expect(call[1].headers).toEqual({ "Content-Type": "application/json" })
    expect(JSON.parse(call[1].body as string)).toEqual({
      model: "nomic-embed-text",
      prompt: "hello",
    })
  })

  it("strips a trailing slash on baseURL", async () => {
    proxyFetch.mockResolvedValue(makeResponse({ body: { embedding: [1] } }))
    await generateOllamaEmbedding("http://localhost:11434/", "m", "x")
    expect(proxyFetch.mock.calls[0][0]).toBe("http://localhost:11434/api/embeddings")
  })

  it("supports the newer embeddings[][] response shape", async () => {
    proxyFetch.mockResolvedValue(makeResponse({ body: { embeddings: [[1, 2, 3]] } }))
    const out = await generateOllamaEmbedding("http://localhost:11434", "m", "hello")
    expect(out).toEqual([1, 2, 3])
  })

  it("throws on a 4xx response with the body included in the message", async () => {
    proxyFetch.mockResolvedValue(
      makeResponse({ status: 404, statusText: "Not Found", rawText: "model not found" })
    )
    await expect(generateOllamaEmbedding("http://localhost:11434", "missing", "x")).rejects.toThrow(
      /HTTP 404/
    )
    await expect(generateOllamaEmbedding("http://localhost:11434", "missing", "x")).rejects.toThrow(
      /model not found/
    )
  })

  it("throws on a 5xx response", async () => {
    proxyFetch.mockResolvedValue(makeResponse({ status: 500, statusText: "Server Error" }))
    await expect(generateOllamaEmbedding("http://localhost:11434", "m", "x")).rejects.toThrow(
      /HTTP 500/
    )
  })

  it("throws when the body is missing the embedding fields", async () => {
    proxyFetch.mockResolvedValue(makeResponse({ body: { not_what_you_expected: true } }))
    await expect(generateOllamaEmbedding("http://localhost:11434", "m", "x")).rejects.toThrow(
      /missing an 'embedding'/
    )
  })

  it("throws when the embedding array is empty", async () => {
    proxyFetch.mockResolvedValue(makeResponse({ body: { embedding: [] } }))
    await expect(generateOllamaEmbedding("http://localhost:11434", "m", "x")).rejects.toThrow(
      /missing an 'embedding'/
    )
  })

  it("throws when JSON parsing fails", async () => {
    proxyFetch.mockResolvedValue(makeResponse({ jsonThrows: true }))
    await expect(generateOllamaEmbedding("http://localhost:11434", "m", "x")).rejects.toThrow(
      /not valid JSON/
    )
  })

  it("propagates fetch-layer errors with context", async () => {
    proxyFetch.mockRejectedValue(new Error("ECONNREFUSED"))
    await expect(generateOllamaEmbedding("http://localhost:11434", "m", "x")).rejects.toThrow(
      /ECONNREFUSED/
    )
    await expect(generateOllamaEmbedding("http://localhost:11434", "m", "x")).rejects.toThrow(
      /url=http:\/\/localhost:11434\/api\/embeddings/
    )
  })

  it("handles non-Error throwables from the fetch layer", async () => {
    proxyFetch.mockRejectedValue("string-thrown-without-Error")
    await expect(generateOllamaEmbedding("http://localhost:11434", "m", "x")).rejects.toThrow(
      /string-thrown-without-Error/
    )
  })

  it("handles non-Error throwables from JSON parsing", async () => {
    proxyFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "",
      json: async () => {
        throw "not-an-error-instance"
      },
      text: async () => "",
    } as unknown as Response)
    await expect(generateOllamaEmbedding("http://localhost:11434", "m", "x")).rejects.toThrow(
      /not-an-error-instance/
    )
  })

  it("throws when baseURL is missing", async () => {
    await expect(generateOllamaEmbedding("", "m", "x")).rejects.toThrow(/baseURL is required/)
  })

  it("throws when modelId is missing", async () => {
    await expect(generateOllamaEmbedding("http://localhost:11434", "", "x")).rejects.toThrow(
      /modelId is required/
    )
  })
})

describe("Ollama browser fallback API helpers", () => {
  const fetchMock = jest.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  }

  function streamResponse(chunks: string[]): Response {
    const encoded = chunks.map((chunk) => new TextEncoder().encode(chunk))
    let index = 0
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () =>
            index < encoded.length
              ? { done: false, value: encoded[index++] }
              : { done: true, value: undefined },
        }),
      },
    } as unknown as Response
  }

  it("reads server status with optional version and model count", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { version: "0.7.0" }))
      .mockResolvedValueOnce(jsonResponse(200, { models: [{ name: "llama" }, { name: "nomic" }] }))

    await expect(getOllamaStatus("http://localhost:11434/v1/")).resolves.toEqual({
      connected: true,
      version: "0.7.0",
      models_count: 2,
    })
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:11434/api/version")
    expect(fetchMock.mock.calls[1][0]).toBe("http://localhost:11434/api/tags")
  })

  it("reports disconnected status when version or tag requests fail", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("version missing"))
      .mockResolvedValueOnce(jsonResponse(503, {}))
    await expect(getOllamaStatus()).resolves.toEqual({ connected: false, models_count: 0 })

    fetchMock.mockRejectedValueOnce(new Error("network down"))
    await expect(getOllamaStatus()).resolves.toEqual({ connected: false, models_count: 0 })
  })

  it("lists, shows, deletes, copies, stops, and lists running models", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { models: [{ name: "llama3" }] }))
      .mockResolvedValueOnce(jsonResponse(200, { license: "mit", details: { format: "gguf" } }))
      .mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(200, { models: [{ name: "llama3", size: 1 }] }))
      .mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(200, {}))

    await expect(listOllamaModels("http://ollama.local/")).resolves.toEqual([{ name: "llama3" }])
    await expect(showOllamaModel("http://ollama.local/v1", "llama3")).resolves.toEqual({
      license: "mit",
      details: { format: "gguf" },
    })
    await expect(deleteOllamaModel("http://ollama.local", "llama3")).resolves.toBe(true)
    await expect(listRunningModels("http://ollama.local")).resolves.toEqual([
      { name: "llama3", size: 1 },
    ])
    await expect(copyOllamaModel("http://ollama.local", "llama3", "llama3-copy")).resolves.toBe(
      true
    )
    await expect(stopOllamaModel("http://ollama.local", "llama3")).resolves.toBe(true)

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://ollama.local/api/tags",
      "http://ollama.local/api/show",
      "http://ollama.local/api/delete",
      "http://ollama.local/api/ps",
      "http://ollama.local/api/copy",
      "http://ollama.local/api/generate",
    ])
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({ name: "llama3" })
    expect(JSON.parse(fetchMock.mock.calls[4][1].body as string)).toEqual({
      source: "llama3",
      destination: "llama3-copy",
    })
    expect(JSON.parse(fetchMock.mock.calls[5][1].body as string)).toEqual({
      model: "llama3",
      keep_alive: 0,
    })
  })

  it("throws descriptive errors for non-ok browser fallback responses", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}))
    await expect(listOllamaModels("http://ollama.local")).rejects.toThrow(
      "Failed to list models: 500"
    )

    fetchMock.mockResolvedValueOnce(jsonResponse(404, {}))
    await expect(showOllamaModel("http://ollama.local", "missing")).rejects.toThrow(
      "Failed to show model: 404"
    )

    fetchMock.mockResolvedValueOnce(jsonResponse(400, {}))
    await expect(deleteOllamaModel("http://ollama.local", "missing")).rejects.toThrow(
      "Failed to delete model: 400"
    )

    fetchMock.mockResolvedValueOnce(jsonResponse(503, {}))
    await expect(listRunningModels("http://ollama.local")).rejects.toThrow(
      "Failed to list running models: 503"
    )

    fetchMock.mockResolvedValueOnce(jsonResponse(409, {}))
    await expect(copyOllamaModel("http://ollama.local", "a", "b")).rejects.toThrow(
      "Failed to copy model: 409"
    )

    fetchMock.mockResolvedValueOnce(jsonResponse(408, {}))
    await expect(stopOllamaModel("http://ollama.local", "a")).rejects.toThrow(
      "Failed to stop model: 408"
    )
  })

  it("streams pull progress, ignores malformed lines, and exposes a no-op unsubscribe", async () => {
    const onProgress = jest.fn()
    fetchMock.mockResolvedValueOnce(
      streamResponse(['{"status":"pulling"', ',"completed":1}\nnot-json\n{"status":"done"}\n'])
    )

    const result = await pullOllamaModel("http://ollama.local", "llama3", onProgress)

    expect(result.success).toBe(true)
    expect(result.unsubscribe()).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith("http://ollama.local/api/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "llama3", stream: true }),
    })
    expect(onProgress).toHaveBeenCalledWith({
      status: "pulling",
      completed: 1,
      model: "llama3",
    })
    expect(onProgress).toHaveBeenCalledWith({ status: "done", model: "llama3" })
  })

  it("rejects pull failures and missing stream bodies", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, {}))
    await expect(pullOllamaModel("http://ollama.local", "missing")).rejects.toThrow(
      "Failed to pull model: 404"
    )

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: undefined,
    } as unknown as Response)
    await expect(pullOllamaModel("http://ollama.local", "missing")).rejects.toThrow(
      "No response body"
    )
  })

  it("detects embedding models and derives model capabilities from names", () => {
    expect(isOllamaEmbeddingModel("nomic-embed-text")).toBe(true)
    expect(isOllamaEmbeddingModel("bge-large")).toBe(true)
    expect(isOllamaEmbeddingModel("llama3")).toBe(false)

    expect(getOllamaModelCapabilities("llava:latest")).toEqual({
      supportsVision: true,
      supportsTools: true,
      supportsEmbedding: false,
    })
    expect(getOllamaModelCapabilities("mxbai-embed-large")).toEqual({
      supportsVision: false,
      supportsTools: false,
      supportsEmbedding: true,
    })
  })
})
