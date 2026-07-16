import {
  copyOllamaModel,
  deleteOllamaModel,
  generateOllamaEmbedding,
  generateOllamaEmbeddings,
  getOllamaModelCapabilities,
  getOllamaStatus,
  isOllamaEmbeddingModel,
  listOllamaModels,
  listRunningModels,
  probeOllamaModelCapabilities,
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

  /**
   * Was "posts JSON to {baseURL}/api/embeddings". That endpoint is deprecated
   * upstream ("superseded by /api/embed") and takes only `prompt: string`,
   * which is what forced the caller to loop one HTTP request per text.
   */
  it("posts JSON to {baseURL}/api/embed and returns the embedding array", async () => {
    proxyFetch.mockResolvedValue(makeResponse({ body: { embeddings: [[0.1, 0.2, 0.3]] } }))

    const out = await generateOllamaEmbedding("http://localhost:11434", "nomic-embed-text", "hello")

    expect(out).toEqual([0.1, 0.2, 0.3])
    const call = proxyFetch.mock.calls[0]
    expect(call[0]).toBe("http://localhost:11434/api/embed")
    expect(call[1].method).toBe("POST")
    expect(call[1].headers).toEqual({ "Content-Type": "application/json" })
    expect(JSON.parse(call[1].body as string)).toEqual({
      model: "nomic-embed-text",
      input: "hello",
    })
  })

  it("strips a trailing slash on baseURL", async () => {
    proxyFetch.mockResolvedValue(makeResponse({ body: { embeddings: [[1]] } }))
    await generateOllamaEmbedding("http://localhost:11434/", "m", "x")
    expect(proxyFetch.mock.calls[0][0]).toBe("http://localhost:11434/api/embed")
  })

  it("supports the 2-D embeddings[][] response shape /api/embed always returns", async () => {
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
      /url=http:\/\/localhost:11434\/api\/embed/
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

/**
 * These exercise the HTTP request/response SHAPES. They reach `global.fetch`
 * because provider-core's un-injected `defaultProxyFetch` delegates to it; the
 * transport question — which fetch actually runs on a desktop host — is pinned
 * separately in "Ollama transport under Tauri" below.
 *
 * The name is deliberate: these are no longer a "browser fallback". There used
 * to be an `invoke("ollama_*")` branch that took priority under Tauri, and
 * these helpers were only its backup. Those commands never existed in Rust, so
 * the "fallback" was in truth the only implementation, and the primary path
 * threw on every desktop run. HTTP is now the single path, on every host.
 */
describe("Ollama HTTP API helpers", () => {
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

  it("throws descriptive errors for non-ok responses", async () => {
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

  it("detects embedding models and guesses capabilities from names", () => {
    expect(isOllamaEmbeddingModel("nomic-embed-text")).toBe(true)
    expect(isOllamaEmbeddingModel("bge-large")).toBe(true)
    expect(isOllamaEmbeddingModel("llama3")).toBe(false)

    // `inferred: true` is the load-bearing field: these results come from
    // substring matching, and callers must be able to tell them apart from a
    // real /api/show probe rather than trusting both equally.
    expect(getOllamaModelCapabilities("llava:latest")).toEqual({
      supportsVision: true,
      supportsTools: true,
      supportsEmbedding: false,
      supportsThinking: false,
      inferred: true,
    })
    expect(getOllamaModelCapabilities("mxbai-embed-large")).toEqual({
      supportsVision: false,
      supportsTools: false,
      supportsEmbedding: true,
      supportsThinking: false,
      inferred: true,
    })
  })

  it("shows why the name guess is a fallback, not a mechanism", () => {
    // A real vision model the substring heuristic cannot see. This is the gap
    // probeOllamaModelCapabilities closes by asking the server instead.
    expect(getOllamaModelCapabilities("qwen2.5-vl:7b").supportsVision).toBe(false)
    expect(getOllamaModelCapabilities("moondream").supportsVision).toBe(false)
  })
})

/**
 * THE regression that made every other bug in this file invisible.
 *
 * This suite never simulated a Tauri host. `defaultIsTauri()` reads
 * `window.__TAURI_INTERNALS__`, which jsdom does not define, so `isTauri()` was
 * permanently false and every test took the browser branch. The `invoke`
 * branches — the ones that ran in the shipped desktop app, and threw there —
 * had zero coverage. A green suite certified a surface that was 100% broken on
 * the only host most users have.
 *
 * So the assertions below are about the HOST, not the payload: on a desktop
 * host every call MUST go through the injected proxyFetch (Rust-backed, CSP
 * exempt) and MUST NOT touch the bare `fetch` the CSP blocks.
 */
describe("Ollama transport under Tauri", () => {
  const proxy = jest.fn()
  const bareFetch = jest.fn()

  beforeEach(() => {
    proxy.mockReset()
    bareFetch.mockReset()
    global.fetch = bareFetch as unknown as typeof fetch
    setProviderCoreRuntimeAdapters({ isTauri: () => true, proxyFetch: proxy })
  })

  afterEach(() => {
    resetProviderCoreRuntimeAdaptersForTesting()
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  function ok(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      statusText: "",
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  }

  it.each([
    ["getOllamaStatus", () => getOllamaStatus("http://localhost:11434"), { models: [] }],
    ["listOllamaModels", () => listOllamaModels("http://localhost:11434"), { models: [] }],
    ["showOllamaModel", () => showOllamaModel("http://localhost:11434", "llama3"), {}],
    ["deleteOllamaModel", () => deleteOllamaModel("http://localhost:11434", "llama3"), {}],
    ["listRunningModels", () => listRunningModels("http://localhost:11434"), { models: [] }],
    ["copyOllamaModel", () => copyOllamaModel("http://localhost:11434", "a", "b"), {}],
    ["stopOllamaModel", () => stopOllamaModel("http://localhost:11434", "llama3"), {}],
    [
      "generateOllamaEmbedding",
      () => generateOllamaEmbedding("http://localhost:11434", "nomic", "hi"),
      { embedding: [0.1] },
    ],
  ])(
    "%s routes through the Rust-backed proxy and never the CSP-blocked fetch",
    async (_name, call, body) => {
      proxy.mockResolvedValue(ok(body))

      await call()

      expect(proxy).toHaveBeenCalled()
      expect(bareFetch).not.toHaveBeenCalled()
    }
  )

  it("keeps no ollama_* invoke path alive — the Rust commands it called never existed", async () => {
    proxy.mockResolvedValue(ok({ models: [] }))
    await listOllamaModels("http://localhost:11434")

    // Every request carries an absolute Ollama URL rather than a command name.
    for (const [url] of proxy.mock.calls) {
      expect(String(url)).toMatch(/^http:\/\/localhost:11434\/api\//)
    }
  })
})

describe("probeOllamaModelCapabilities", () => {
  const proxy = jest.fn()

  beforeEach(() => {
    proxy.mockReset()
    setProviderCoreRuntimeAdapters({ proxyFetch: proxy })
  })

  afterEach(() => {
    resetProviderCoreRuntimeAdaptersForTesting()
  })

  function showResponse(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      statusText: "",
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  }

  it("reads real capabilities off /api/show rather than guessing from the name", async () => {
    proxy.mockResolvedValue(
      showResponse({
        capabilities: ["completion", "tools", "vision", "thinking"],
        model_info: { "general.architecture": "llama", "llama.context_length": 131072 },
      })
    )

    // A name that the substring heuristic would call text-only.
    const caps = await probeOllamaModelCapabilities("http://localhost:11434", "qwen2.5-vl:7b")

    expect(caps).toMatchObject({
      supportsVision: true,
      supportsTools: true,
      supportsThinking: true,
      supportsEmbedding: false,
      inferred: false,
    })
  })

  /**
   * The bug this test exists to prevent: `model_info` keys are prefixed with
   * the model's ARCHITECTURE, so a hardcoded `llama.context_length` returns
   * undefined on Gemma/Qwen/DeepSeek — silently, with no error to notice.
   * Ollama's own GGUF reader builds the key by prepending
   * `general.architecture`, so we must too.
   */
  it.each([
    ["llama", 131072],
    ["qwen2", 32768],
    ["gemma4", 8192],
    ["deepseek2", 163840],
  ])("resolves context length for the %s architecture, not just llama", async (arch, expected) => {
    proxy.mockResolvedValue(
      showResponse({
        capabilities: ["completion"],
        model_info: {
          "general.architecture": arch,
          [`${arch}.context_length`]: expected,
        },
      })
    )

    const caps = await probeOllamaModelCapabilities("http://localhost:11434", "some-model")

    expect(caps.architecture).toBe(arch)
    expect(caps.contextLength).toBe(expected)
  })

  it("treats vision and image as equivalent input capabilities", async () => {
    proxy.mockResolvedValue(showResponse({ capabilities: ["completion", "image"] }))
    const caps = await probeOllamaModelCapabilities("http://localhost:11434", "m")
    expect(caps.supportsVision).toBe(true)
  })

  it("reports an embedding model from the server's own answer", async () => {
    proxy.mockResolvedValue(showResponse({ capabilities: ["embedding"] }))
    const caps = await probeOllamaModelCapabilities("http://localhost:11434", "some-vector-model")
    expect(caps).toMatchObject({
      supportsEmbedding: true,
      supportsTools: false,
      inferred: false,
    })
  })

  it("distinguishes an empty capabilities array (a real answer) from an absent one (a guess)", async () => {
    proxy.mockResolvedValue(showResponse({ capabilities: [] }))
    const answered = await probeOllamaModelCapabilities("http://localhost:11434", "llava")
    expect(answered.inferred).toBe(false)
    expect(answered.supportsVision).toBe(false)

    // No capabilities key at all — an older server. Fall back to the name guess
    // and SAY it is a guess.
    proxy.mockResolvedValue(showResponse({ model_info: {} }))
    const guessed = await probeOllamaModelCapabilities("http://localhost:11434", "llava")
    expect(guessed.inferred).toBe(true)
    expect(guessed.supportsVision).toBe(true)
  })

  it("degrades to a flagged guess instead of throwing when the probe fails", async () => {
    proxy.mockRejectedValue(new Error("connection refused"))
    const caps = await probeOllamaModelCapabilities("http://localhost:11434", "nomic-embed-text")
    expect(caps).toMatchObject({ supportsEmbedding: true, inferred: true })
    expect(caps.contextLength).toBeUndefined()
  })

  it("omits context length when model_info carries no architecture to key off", async () => {
    proxy.mockResolvedValue(
      showResponse({ capabilities: ["completion"], model_info: { "llama.context_length": 4096 } })
    )
    const caps = await probeOllamaModelCapabilities("http://localhost:11434", "m")
    // No `general.architecture` ⇒ no key to build ⇒ report nothing rather than
    // guess that this happens to be a llama.
    expect(caps.contextLength).toBeUndefined()
  })
})

describe("generateOllamaEmbeddings (batch)", () => {
  const proxy = jest.fn()

  beforeEach(() => {
    proxy.mockReset()
    setProviderCoreRuntimeAdapters({ proxyFetch: proxy })
  })

  afterEach(() => {
    resetProviderCoreRuntimeAdaptersForTesting()
  })

  function embedResponse(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      statusText: "",
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  }

  /** The whole point of W8: N vectors, ONE round-trip. */
  it("returns N vectors from a single HTTP request", async () => {
    proxy.mockResolvedValue(embedResponse({ embeddings: [[0.1], [0.2], [0.3]] }))

    const out = await generateOllamaEmbeddings("http://localhost:11434", "nomic", ["a", "b", "c"])

    expect(out).toEqual([[0.1], [0.2], [0.3]])
    expect(proxy).toHaveBeenCalledTimes(1)
    expect(proxy.mock.calls[0][0]).toBe("http://localhost:11434/api/embed")
    // `input` takes the array natively — the deprecated endpoint's `prompt`
    // only ever accepted one string, which is why it needed a loop.
    expect(JSON.parse(proxy.mock.calls[0][1].body)).toEqual({
      model: "nomic",
      input: ["a", "b", "c"],
    })
  })

  it("uses /api/embed, not the deprecated /api/embeddings, for a single text too", async () => {
    proxy.mockResolvedValue(embedResponse({ embeddings: [[0.5, 0.6]] }))

    const out = await generateOllamaEmbedding("http://localhost:11434", "nomic", "hello")

    expect(out).toEqual([0.5, 0.6])
    expect(proxy.mock.calls[0][0]).toBe("http://localhost:11434/api/embed")
    expect(JSON.parse(proxy.mock.calls[0][1].body)).toEqual({ model: "nomic", input: "hello" })
  })

  /**
   * A short response would shift every vector onto the wrong text — the sort of
   * corruption that surfaces much later as inexplicably bad retrieval. Fail here.
   */
  it("refuses to misalign when the server returns fewer vectors than inputs", async () => {
    proxy.mockResolvedValue(embedResponse({ embeddings: [[0.1]] }))

    await expect(
      generateOllamaEmbeddings("http://localhost:11434", "nomic", ["a", "b"])
    ).rejects.toThrow(/refusing to misalign/)
  })

  it("short-circuits an empty batch without touching the network", async () => {
    await expect(generateOllamaEmbeddings("http://x", "nomic", [])).resolves.toEqual([])
    expect(proxy).not.toHaveBeenCalled()
  })

  it("forwards truncate / dimensions / keep_alive when asked", async () => {
    proxy.mockResolvedValue(embedResponse({ embeddings: [[0.1]] }))

    await generateOllamaEmbedding("http://localhost:11434", "nomic", "hi", {
      truncate: false,
      dimensions: 128,
      keepAlive: "5m",
    })

    expect(JSON.parse(proxy.mock.calls[0][1].body)).toEqual({
      model: "nomic",
      input: "hi",
      truncate: false,
      dimensions: 128,
      keep_alive: "5m",
    })
  })

  it("omits options entirely when unset so the server's defaults apply", async () => {
    proxy.mockResolvedValue(embedResponse({ embeddings: [[0.1]] }))
    await generateOllamaEmbedding("http://localhost:11434", "nomic", "hi")
    expect(JSON.parse(proxy.mock.calls[0][1].body)).toEqual({ model: "nomic", input: "hi" })
  })

  it("tolerates a legacy 1-D `embedding` response from an older server", async () => {
    proxy.mockResolvedValue(embedResponse({ embedding: [0.9, 0.8] }))
    const out = await generateOllamaEmbedding("http://localhost:11434", "nomic", "hi")
    expect(out).toEqual([0.9, 0.8])
  })
})
