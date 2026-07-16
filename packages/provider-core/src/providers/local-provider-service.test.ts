/**
 * @jest-environment jsdom
 */

import type { LocalProviderName } from "@cognia/provider-types/local-provider"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

jest.mock("@tauri-apps/api/event", () => ({
  listen: jest.fn(),
}))

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import {
  LocalProviderService,
  getProviderCapabilities,
  checkProviderInstallation,
  checkAllProvidersInstallation,
  getInstallInstructions,
  createLocalProviderService,
} from "./local-provider-service"
import {
  resetProviderCoreRuntimeAdaptersForTesting,
  setProviderCoreRuntimeAdapters,
} from "./runtime-adapters"

const invokeMock = invoke as unknown as jest.Mock
const listenMock = listen as unknown as jest.Mock

function setTauri(enabled: boolean) {
  const w = window as unknown as Record<string, unknown>
  if (enabled) {
    w.__TAURI_INTERNALS__ = {}
  } else {
    delete w.__TAURI_INTERNALS__
  }
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200
  const ok = status >= 200 && status < 300
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response
}

// jsdom does not expose `fetch` on globalThis; assign a jest.fn() once and reset
// it before every test. The mock survives across the suite — same pattern used
// by lib/twin/ingest/embed.test.ts and others in the repo.
const fetchSpy = jest.fn()
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch

beforeEach(() => {
  invokeMock.mockReset()
  listenMock.mockReset()
  fetchSpy.mockReset()
  resetProviderCoreRuntimeAdaptersForTesting()
  setTauri(false)
})

afterEach(() => {
  resetProviderCoreRuntimeAdaptersForTesting()
  setTauri(false)
})

describe("getProviderCapabilities", () => {
  it("returns the canonical capability matrix for ollama (full feature set)", () => {
    const cap = getProviderCapabilities("ollama")
    expect(cap).toMatchObject({
      canListModels: true,
      canPullModels: true,
      canDeleteModels: true,
      canStopModels: true,
      canGenerateEmbeddings: true,
      supportsStreaming: true,
      supportsVision: true,
      supportsTools: true,
    })
  })

  it("marks read-only servers as canPullModels=false (lmstudio, llamacpp, vllm)", () => {
    expect(getProviderCapabilities("lmstudio").canPullModels).toBe(false)
    expect(getProviderCapabilities("llamacpp").canPullModels).toBe(false)
    expect(getProviderCapabilities("vllm").canPullModels).toBe(false)
  })

  it("falls back to a conservative default for unknown providers", () => {
    const cap = getProviderCapabilities("unknown-engine" as unknown as LocalProviderName)
    expect(cap).toMatchObject({
      canListModels: true,
      canPullModels: false,
      canDeleteModels: false,
      canStopModels: false,
      canGenerateEmbeddings: false,
      supportsStreaming: true,
      supportsVision: false,
      supportsTools: false,
    })
  })
})

describe("LocalProviderService constructor + accessors", () => {
  it("exposes the provider id, config, and capabilities", () => {
    const svc = new LocalProviderService("ollama")
    expect(svc.getId()).toBe("ollama")
    expect(svc.getConfig().name).toBe("Ollama")
    expect(svc.getCapabilities().canPullModels).toBe(true)
  })

  it("normalizes a user-supplied baseUrl (strips trailing /v1 and slashes)", async () => {
    const svc = new LocalProviderService("ollama", "http://localhost:11434/v1/")
    fetchSpy.mockResolvedValue(jsonResponse({ models: [] }, { status: 200 }))
    await svc.getStatus()
    expect(fetchSpy.mock.calls[0][0]).toBe("http://localhost:11434/api/version")
  })
})

describe("LocalProviderService.getStatus", () => {
  /**
   * The predecessors of these two tests asserted that `getStatus` called
   * `invoke("ollama_get_status")` / `invoke("local_provider_get_status")`.
   * Neither command has ever existed in Rust. The tests passed only because
   * `invoke` was mocked, so the mock happily returned whatever the test asked
   * for — pinning a fantasy as if it were the contract, and hiding the fact
   * that every desktop run threw "Command not found" here. That is why the
   * assertion now targets the transport that actually exists.
   */
  it("(Tauri) issues the status probe through the injected proxy fetch, never a bare fetch", async () => {
    setTauri(true)
    const proxy = jest.fn().mockResolvedValue(jsonResponse({ version: "0.6.1" }))
    setProviderCoreRuntimeAdapters({ isTauri: () => true, proxyFetch: proxy })

    const status = await new LocalProviderService("ollama").getStatus()

    expect(proxy).toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(status.connected).toBe(true)
    expect(status.version).toBe("0.6.1")
    expect(typeof status.latency_ms).toBe("number")
  })

  it("(Tauri) routes a generic (non-ollama) provider through the proxy too", async () => {
    setTauri(true)
    const proxy = jest.fn().mockResolvedValue(jsonResponse({ version: "1.0" }))
    setProviderCoreRuntimeAdapters({ isTauri: () => true, proxyFetch: proxy })

    await new LocalProviderService("lmstudio").getStatus()

    expect(proxy).toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("reads the version off the health endpoint", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ version: "0.5.0" }))
    const svc = new LocalProviderService("ollama")
    const status = await svc.getStatus()
    expect(status.connected).toBe(true)
    expect(status.version).toBe("0.5.0")
  })

  it("(browser) reports HTTP errors as connected=false with the status code", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}, { status: 500 }))
    const svc = new LocalProviderService("ollama")
    const status = await svc.getStatus()
    expect(status.connected).toBe(false)
    expect(status.error).toContain("500")
  })

  it("(browser) reports a thrown fetch as connected=false with the error message", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"))
    const svc = new LocalProviderService("ollama")
    const status = await svc.getStatus()
    expect(status.connected).toBe(false)
    expect(status.error).toContain("ECONNREFUSED")
  })

  it("(browser) uses build.version, tolerates JSON parse failures, and normalizes non-Error throws", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ build: { version: "1.2.3" } }))
    await expect(new LocalProviderService("ollama").getStatus()).resolves.toMatchObject({
      connected: true,
      version: "1.2.3",
    })

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json")
      },
    } as unknown as Response)
    await expect(new LocalProviderService("ollama").getStatus()).resolves.toMatchObject({
      connected: true,
      version: undefined,
      models_count: undefined,
    })

    fetchSpy.mockRejectedValueOnce("offline")
    await expect(new LocalProviderService("ollama").getStatus()).resolves.toMatchObject({
      connected: false,
      error: "Connection failed",
    })
  })
})

describe("LocalProviderService.listModels", () => {
  it("returns empty array when the provider does not advertise model listing", async () => {
    const cap = getProviderCapabilities("ollama")
    expect(cap.canListModels).toBe(true)
    // Force a provider whose capability table flips this off:
    const svc = new LocalProviderService("ollama")
    // Monkey-patch the capability via cast — simpler than touching the matrix.
    ;(svc as unknown as { capabilities: { canListModels: boolean } }).capabilities = {
      ...cap,
      canListModels: false,
    }
    const models = await svc.listModels()
    expect(models).toEqual([])
  })

  it("(Tauri) lists models through the injected proxy fetch and maps the size field through", async () => {
    setTauri(true)
    const proxy = jest.fn().mockResolvedValue(
      jsonResponse({
        models: [
          { name: "llama3.2", size: 4096 },
          { name: "qwen2.5", size: 7000 },
        ],
      })
    )
    setProviderCoreRuntimeAdapters({ isTauri: () => true, proxyFetch: proxy })

    const models = await new LocalProviderService("ollama").listModels()

    expect(proxy).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.objectContaining({ method: "GET" })
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(models).toEqual([
      { id: "llama3.2", object: "model", size: 4096 },
      { id: "qwen2.5", object: "model", size: 7000 },
    ])
  })

  it("(Tauri) hits the OpenAI-compatible /v1/models path for non-ollama providers", async () => {
    setTauri(true)
    const proxy = jest.fn().mockResolvedValue(jsonResponse({ data: [{ id: "phi3" }] }))
    setProviderCoreRuntimeAdapters({ isTauri: () => true, proxyFetch: proxy })

    const models = await new LocalProviderService("lmstudio").listModels()

    expect(proxy.mock.calls[0][0]).toContain("/v1/models")
    expect(models).toEqual([{ id: "phi3", object: "model", created: undefined }])
  })

  it("(browser) decodes Ollama's models[] response shape", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ models: [{ name: "llama3.2", size: 100 }] }))
    const svc = new LocalProviderService("ollama")
    const models = await svc.listModels()
    expect(models).toEqual([{ id: "llama3.2", object: "model", size: 100 }])
  })

  it("(browser) decodes Ollama model fallback ids", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ models: [{ model: "fallback" }, {}] }))
    const svc = new LocalProviderService("ollama")
    const models = await svc.listModels()
    expect(models).toEqual([
      { id: "fallback", object: "model", size: undefined },
      { id: "", object: "model", size: undefined },
    ])
  })

  it("(browser) decodes OpenAI's data[] response shape", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ data: [{ id: "mistral", object: "model" }] }))
    const svc = new LocalProviderService("lmstudio")
    const models = await svc.listModels()
    expect(models).toEqual([{ id: "mistral", object: "model" }])
  })

  it("(browser) defaults OpenAI model object values and preserves created timestamps", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ data: [{ id: "mistral", created: 123 }] }))
    const svc = new LocalProviderService("lmstudio")
    const models = await svc.listModels()
    expect(models).toEqual([{ id: "mistral", object: "model", created: 123 }])
  })

  it("(browser) swallows HTTP errors and returns an empty list", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}, { status: 500 }))
    const svc = new LocalProviderService("ollama")
    const models = await svc.listModels()
    expect(models).toEqual([])
  })
})

describe("LocalProviderService.pullModel", () => {
  it("returns a noop when the provider does not advertise pull support", async () => {
    const svc = new LocalProviderService("llamacpp")
    const result = await svc.pullModel("foo")
    expect(result.success).toBe(false)
  })

  /**
   * The four tests this replaces asserted `invoke("ollama_pull_model")` and
   * `invoke("local_provider_pull_model")`. Neither Rust command exists. With
   * `invoke` mocked they passed cleanly while the real desktop path threw on
   * every call — the sharpest example of a mock certifying a fantasy.
   * `ollama_pull_model_stream` below is different: it is registered in Rust and
   * covered by `cargo test -p cognia-net`.
   */
  it("(Tauri ollama) streams via the Rust command and scopes progress to its own pull id", async () => {
    setTauri(true)
    setProviderCoreRuntimeAdapters({ isTauri: () => true })
    const unlistenFn = jest.fn()
    let registeredHandler:
      ((evt: { payload: { pullId?: string; model?: string; status: string } }) => void) | null =
      null
    listenMock.mockImplementation(async (_evt: string, handler: typeof registeredHandler) => {
      registeredHandler = handler
      return unlistenFn
    })
    invokeMock.mockResolvedValue(true)
    const onProgress = jest.fn()

    const result = await new LocalProviderService("ollama").pullModel("llama3.2", { onProgress })

    expect(listenMock).toHaveBeenCalledWith("ollama-pull-progress", expect.any(Function))
    const [command, payload] = invokeMock.mock.calls[0]
    expect(command).toBe("ollama_pull_model_stream")
    expect(payload).toMatchObject({ modelName: "llama3.2", pullId: expect.any(String) })
    expect(result.success).toBe(true)

    // A second concurrent pull's events must not leak into this callback.
    registeredHandler!({ payload: { pullId: "someone-elses-pull", status: "pulling" } })
    expect(onProgress).not.toHaveBeenCalled()

    registeredHandler!({ payload: { pullId: payload.pullId, status: "pulling" } })
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ model: "llama3.2" }))

    result.unsubscribe()
    expect(unlistenFn).toHaveBeenCalled()
  })

  it("(Tauri ollama) detaches the listener when the stream command throws", async () => {
    setTauri(true)
    setProviderCoreRuntimeAdapters({ isTauri: () => true })
    const unlistenFn = jest.fn()
    listenMock.mockResolvedValue(unlistenFn)
    invokeMock.mockRejectedValue(new Error("pull failed"))

    await expect(
      new LocalProviderService("ollama").pullModel("llama3.2", { onProgress: jest.fn() })
    ).rejects.toThrow("pull failed")
    expect(unlistenFn).toHaveBeenCalled()
  })

  it("reports failure for providers whose pull protocol is unimplemented (localai/jan)", async () => {
    setTauri(true)
    setProviderCoreRuntimeAdapters({ isTauri: () => true })
    // Their capability matrix advertises canPullModels, but only Ollama's pull
    // protocol exists here — a known gap. It must fail visibly, not invoke a
    // command that was never written.
    const result = await new LocalProviderService("localai").pullModel("phi-3")
    expect(result.success).toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("(browser ollama) streams JSON lines from /api/pull and forwards progress payloads", async () => {
    const lines = [
      `${JSON.stringify({ status: "downloading" })}\n`,
      `${JSON.stringify({ status: "verifying" })}\n`,
    ]
    let cursor = 0
    const reader = {
      read: jest.fn().mockImplementation(async () => {
        if (cursor >= lines.length) return { done: true, value: undefined }
        const value = new TextEncoder().encode(lines[cursor++])
        return { done: false, value }
      }),
    }
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    } as unknown as Response)
    const onProgress = jest.fn()
    const svc = new LocalProviderService("ollama")
    const result = await svc.pullModel("llama3.2", { onProgress })
    expect(result.success).toBe(true)
    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(onProgress.mock.calls[0][0]).toMatchObject({ model: "llama3.2", status: "downloading" })
  })

  it("(browser ollama) rejects failed pulls, missing bodies, and ignores invalid JSON lines", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, { status: 500 }))
    await expect(new LocalProviderService("ollama").pullModel("llama3.2")).rejects.toThrow(/500/)

    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, body: null } as unknown as Response)
    await expect(new LocalProviderService("ollama").pullModel("llama3.2")).rejects.toThrow(
      "No response body"
    )

    const reader = {
      read: jest
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: new TextEncoder().encode("not-json\n\n"),
        })
        .mockResolvedValueOnce({ done: true, value: undefined }),
    }
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    } as unknown as Response)
    const onProgress = jest.fn()
    await expect(
      new LocalProviderService("ollama").pullModel("llama3.2", { onProgress })
    ).resolves.toMatchObject({ success: true })
    expect(onProgress).not.toHaveBeenCalled()
  })
})

describe("LocalProviderService.deleteModel + stopModel + generateEmbedding", () => {
  it("deleteModel returns false when the provider lacks delete support", async () => {
    const svc = new LocalProviderService("llamacpp")
    expect(await svc.deleteModel("foo")).toBe(false)
  })

  it("deleteModel (Tauri) goes through the injected proxy fetch, never a bare fetch", async () => {
    setTauri(true)
    const proxy = jest.fn().mockResolvedValue(jsonResponse({}))
    setProviderCoreRuntimeAdapters({ isTauri: () => true, proxyFetch: proxy })

    expect(await new LocalProviderService("ollama").deleteModel("foo")).toBe(true)
    expect(proxy.mock.calls[0][0]).toContain("/api/delete")
    expect(proxy.mock.calls[0][1].method).toBe("DELETE")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("deleteModel (browser ollama) DELETEs /api/delete with a JSON body", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}))
    const svc = new LocalProviderService("ollama")
    expect(await svc.deleteModel("foo")).toBe(true)
    const call = fetchSpy.mock.calls[0]
    expect(call[0]).toContain("/api/delete")
    expect(call[1].method).toBe("DELETE")
  })

  it("deleteModel propagates non-2xx via thrown error", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}, { status: 500 }))
    const svc = new LocalProviderService("ollama")
    await expect(svc.deleteModel("foo")).rejects.toThrow(/500/)
  })

  it("deleteModel reports failure for providers whose delete protocol is unimplemented", async () => {
    setTauri(true)
    setProviderCoreRuntimeAdapters({ isTauri: () => true })
    // Same known gap as pullModel: localai/jan advertise the capability, but
    // only Ollama's delete protocol is implemented. The old code invoked
    // `local_provider_delete_model`, which does not exist in Rust.
    await expect(new LocalProviderService("localai").deleteModel("foo")).resolves.toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("stopModel returns false when the provider lacks stop support", async () => {
    const svc = new LocalProviderService("lmstudio")
    expect(await svc.stopModel("foo")).toBe(false)
  })

  it("stopModel (Tauri) goes through the injected proxy fetch, never a bare fetch", async () => {
    setTauri(true)
    const proxy = jest.fn().mockResolvedValue(jsonResponse({}))
    setProviderCoreRuntimeAdapters({ isTauri: () => true, proxyFetch: proxy })

    expect(await new LocalProviderService("ollama").stopModel("foo")).toBe(true)
    expect(JSON.parse(proxy.mock.calls[0][1].body)).toMatchObject({ model: "foo", keep_alive: 0 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("stopModel (browser ollama) POSTs /api/generate with keep_alive:0", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}))
    const svc = new LocalProviderService("ollama")
    expect(await svc.stopModel("foo")).toBe(true)
    expect(JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body)).toMatchObject({
      model: "foo",
      keep_alive: 0,
    })
  })

  it("stopModel returns false when the browser Ollama unload request fails", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}, { status: 500 }))
    const svc = new LocalProviderService("ollama")
    await expect(svc.stopModel("foo")).resolves.toBe(false)
  })

  it("generateEmbedding throws when the provider does not support embeddings", async () => {
    const svc = new LocalProviderService("llamafile")
    await expect(svc.generateEmbedding("m", "hello")).rejects.toThrow(/does not support/)
  })

  it("generateEmbedding (Tauri ollama) goes through the injected proxy fetch, never a bare fetch", async () => {
    setTauri(true)
    const proxy = jest.fn().mockResolvedValue(jsonResponse({ data: [{ embedding: [0.1, 0.2] }] }))
    setProviderCoreRuntimeAdapters({ isTauri: () => true, proxyFetch: proxy })

    const vec = await new LocalProviderService("ollama").generateEmbedding("nomic", "hi")

    expect(vec).toEqual([0.1, 0.2])
    expect(proxy).toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("generateEmbedding (browser) POSTs to /v1/embeddings and decodes the first vector", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ data: [{ embedding: [1, 2, 3] }] }))
    const svc = new LocalProviderService("lmstudio")
    const vec = await svc.generateEmbedding("nomic", "hi")
    expect(vec).toEqual([1, 2, 3])
    expect(fetchSpy.mock.calls[0][0]).toContain("/v1/embeddings")
  })

  it("generateEmbedding (browser) throws with the HTTP code on failure", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}, { status: 400 }))
    const svc = new LocalProviderService("lmstudio")
    await expect(svc.generateEmbedding("nomic", "hi")).rejects.toThrow(/400/)
  })

  it("generateEmbedding returns an empty vector when the response has no embedding", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ data: [] }))
    const svc = new LocalProviderService("lmstudio")
    await expect(svc.generateEmbedding("nomic", "hi")).resolves.toEqual([])
  })
})

describe("checkProviderInstallation", () => {
  it("reports installed + running when the server answers", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ version: "0.5.0" }))
    const result = await checkProviderInstallation("ollama")
    expect(result.installed).toBe(true)
    expect(result.running).toBe(true)
    expect(result.version).toBe("0.5.0")
  })

  /**
   * Replaces a test literally named "reports installed=false when the HTTP
   * probe times out". An HTTP probe cannot prove absence: silence is equally
   * consistent with "not installed", "installed but not started", and "started
   * on another port". Claiming `false` there was a lie the test enforced.
   */
  it("reports installed=unknown (not false) when the probe cannot reach the server", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"))
    const result = await checkProviderInstallation("ollama")
    expect(result.installed).toBeUndefined()
    expect(result.running).toBe(false)
  })

  /**
   * W6c: the probe used to construct the service without the baseUrl, so a
   * user who moved their server off the default port was told it was offline
   * while it ran happily elsewhere.
   */
  it("probes the caller's baseUrl instead of silently falling back to the default port", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ version: "0.5.0" }))
    await checkProviderInstallation("ollama", "http://127.0.0.1:11500")
    expect(fetchSpy.mock.calls[0][0]).toContain("127.0.0.1:11500")
    expect(fetchSpy.mock.calls[0][0]).not.toContain("11434")
  })
})

describe("checkAllProvidersInstallation", () => {
  it("returns one result per supported local provider id", async () => {
    fetchSpy.mockRejectedValue(new Error("unreachable"))
    const results = await checkAllProvidersInstallation()
    const ids = results.map((r) => r.providerId)
    expect(ids).toEqual(
      expect.arrayContaining([
        "ollama",
        "lmstudio",
        "llamacpp",
        "llamafile",
        "vllm",
        "localai",
        "jan",
        "textgenwebui",
        "koboldcpp",
        "tabbyapi",
      ])
    )
  })
})

describe("getInstallInstructions", () => {
  it.each([
    "ollama",
    "lmstudio",
    "llamacpp",
    "llamafile",
    "vllm",
    "localai",
    "jan",
    "textgenwebui",
    "koboldcpp",
    "tabbyapi",
  ] as const)("returns a title + non-empty steps + download/docs links for %s", (id) => {
    const inst = getInstallInstructions(id)
    expect(inst.title).toBeTruthy()
    expect(inst.steps.length).toBeGreaterThan(0)
    expect(inst.downloadUrl).toMatch(/^https?:\/\//)
    expect(inst.docsUrl).toMatch(/^https?:\/\//)
    // Every provider exposes a browse-models URL for the setup flow.
    expect(inst.modelsUrl).toMatch(/^https?:\/\//)
  })

  it("exposes ollama's serve + model-pull commands", () => {
    const inst = getInstallInstructions("ollama")
    expect(inst.serveCommand).toBe("ollama serve")
    expect(inst.modelPullCommand).toContain("pull")
  })

  it("omits the serve command for GUI-driven providers", () => {
    expect(getInstallInstructions("lmstudio").serveCommand).toBeUndefined()
    expect(getInstallInstructions("jan").serveCommand).toBeUndefined()
  })

  it("provides a serve command for CLI/server providers", () => {
    expect(getInstallInstructions("llamacpp").serveCommand).toBeTruthy()
    expect(getInstallInstructions("vllm").serveCommand).toContain("vllm serve")
  })
})

describe("createLocalProviderService", () => {
  it("constructs a LocalProviderService with the provided id", () => {
    const svc = createLocalProviderService("ollama")
    expect(svc).toBeInstanceOf(LocalProviderService)
    expect(svc.getId()).toBe("ollama")
  })

  it("forwards a custom baseUrl to the constructor (after normalization)", async () => {
    const svc = createLocalProviderService("ollama", "http://192.168.1.50:11434/v1")
    fetchSpy.mockResolvedValue(jsonResponse({}))
    await svc.getStatus()
    expect(fetchSpy.mock.calls[0][0]).toBe("http://192.168.1.50:11434/api/version")
  })
})
