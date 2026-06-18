/**
 * @jest-environment jsdom
 */

import type { LocalProviderName } from "@/types/provider/local-provider"

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
  setTauri(false)
})

afterEach(() => {
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
  it("uses the Tauri ollama_get_status command when running under Tauri", async () => {
    setTauri(true)
    invokeMock.mockResolvedValue({ connected: true, version: "0.6.1" })
    const svc = new LocalProviderService("ollama")
    const status = await svc.getStatus()
    expect(invokeMock).toHaveBeenCalledWith(
      "ollama_get_status",
      expect.objectContaining({ baseUrl: expect.any(String) })
    )
    expect(status.connected).toBe(true)
    expect(typeof status.latency_ms).toBe("number")
  })

  it("falls through to local_provider_get_status for a generic Tauri provider", async () => {
    setTauri(true)
    invokeMock.mockResolvedValue({ connected: true })
    const svc = new LocalProviderService("lmstudio")
    await svc.getStatus()
    expect(invokeMock).toHaveBeenCalledWith(
      "local_provider_get_status",
      expect.objectContaining({ providerId: "lmstudio" })
    )
  })

  it("falls through to HTTP /api/version when the ollama Tauri command throws", async () => {
    setTauri(true)
    invokeMock.mockRejectedValue(new Error("not registered"))
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

  it("(Tauri) uses ollama_list_models and maps the size field through", async () => {
    setTauri(true)
    invokeMock.mockResolvedValue([
      { name: "llama3.2", model: "llama3.2", size: 4096 },
      { name: "qwen2.5", model: "qwen2.5", size: 7000 },
    ])
    const svc = new LocalProviderService("ollama")
    const models = await svc.listModels()
    expect(models).toEqual([
      { id: "llama3.2", object: "model", size: 4096 },
      { id: "qwen2.5", object: "model", size: 7000 },
    ])
  })

  it("(Tauri) falls through to local_provider_list_models for non-ollama providers", async () => {
    setTauri(true)
    invokeMock.mockResolvedValue([{ id: "phi3" }])
    const svc = new LocalProviderService("lmstudio")
    const models = await svc.listModels()
    expect(invokeMock).toHaveBeenCalledWith(
      "local_provider_list_models",
      expect.objectContaining({ providerId: "lmstudio" })
    )
    expect(models).toEqual([{ id: "phi3" }])
  })

  it("(browser) decodes Ollama's models[] response shape", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ models: [{ name: "llama3.2", size: 100 }] }))
    const svc = new LocalProviderService("ollama")
    const models = await svc.listModels()
    expect(models).toEqual([{ id: "llama3.2", object: "model", size: 100 }])
  })

  it("(browser) decodes OpenAI's data[] response shape", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ data: [{ id: "mistral", object: "model" }] }))
    const svc = new LocalProviderService("lmstudio")
    const models = await svc.listModels()
    expect(models).toEqual([{ id: "mistral", object: "model" }])
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

  it("(Tauri ollama) registers a progress listener and calls ollama_pull_model", async () => {
    setTauri(true)
    const unlistenFn = jest.fn()
    listenMock.mockResolvedValue(unlistenFn)
    invokeMock.mockResolvedValue(true)
    const onProgress = jest.fn()
    const svc = new LocalProviderService("ollama")
    const result = await svc.pullModel("llama3.2", { onProgress })
    expect(listenMock).toHaveBeenCalledWith("ollama-pull-progress", expect.any(Function))
    expect(invokeMock).toHaveBeenCalledWith(
      "ollama_pull_model",
      expect.objectContaining({ modelName: "llama3.2" })
    )
    expect(result.success).toBe(true)
    result.unsubscribe()
    expect(unlistenFn).toHaveBeenCalled()
  })

  it("(Tauri ollama) progress callbacks fire only for the requested model", async () => {
    setTauri(true)
    let registeredHandler: ((evt: { payload: { model: string; status: string } }) => void) | null =
      null
    listenMock.mockImplementation(
      async (
        _evt: string,
        handler: (evt: { payload: { model: string; status: string } }) => void
      ) => {
        registeredHandler = handler
        return jest.fn()
      }
    )
    invokeMock.mockResolvedValue(true)
    const onProgress = jest.fn()
    const svc = new LocalProviderService("ollama")
    await svc.pullModel("llama3.2", { onProgress })
    registeredHandler!({ payload: { model: "different-model", status: "pulling" } })
    registeredHandler!({ payload: { model: "llama3.2", status: "pulling" } })
    expect(onProgress).toHaveBeenCalledTimes(1)
  })

  it("(Tauri ollama) cleans up the listener when the invoke throws", async () => {
    setTauri(true)
    const unlistenFn = jest.fn()
    listenMock.mockResolvedValue(unlistenFn)
    invokeMock.mockRejectedValue(new Error("pull failed"))
    const svc = new LocalProviderService("ollama")
    await expect(svc.pullModel("llama3.2", { onProgress: jest.fn() })).rejects.toThrow(
      "pull failed"
    )
    expect(unlistenFn).toHaveBeenCalled()
  })

  it("(Tauri generic) calls local_provider_pull_model when not on ollama", async () => {
    setTauri(true)
    listenMock.mockResolvedValue(jest.fn())
    invokeMock.mockResolvedValue(true)
    const svc = new LocalProviderService("localai")
    await svc.pullModel("phi-3")
    expect(invokeMock).toHaveBeenCalledWith(
      "local_provider_pull_model",
      expect.objectContaining({ providerId: "localai", modelName: "phi-3" })
    )
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
})

describe("LocalProviderService.deleteModel + stopModel + generateEmbedding", () => {
  it("deleteModel returns false when the provider lacks delete support", async () => {
    const svc = new LocalProviderService("llamacpp")
    expect(await svc.deleteModel("foo")).toBe(false)
  })

  it("deleteModel uses the ollama Tauri command when on Tauri", async () => {
    setTauri(true)
    invokeMock.mockResolvedValue(true)
    const svc = new LocalProviderService("ollama")
    expect(await svc.deleteModel("foo")).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith(
      "ollama_delete_model",
      expect.objectContaining({ modelName: "foo" })
    )
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

  it("stopModel returns false when the provider lacks stop support", async () => {
    const svc = new LocalProviderService("lmstudio")
    expect(await svc.stopModel("foo")).toBe(false)
  })

  it("stopModel uses the Tauri command when available", async () => {
    setTauri(true)
    invokeMock.mockResolvedValue(true)
    const svc = new LocalProviderService("ollama")
    expect(await svc.stopModel("foo")).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith(
      "ollama_stop_model",
      expect.objectContaining({ modelName: "foo" })
    )
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

  it("generateEmbedding throws when the provider does not support embeddings", async () => {
    const svc = new LocalProviderService("llamafile")
    await expect(svc.generateEmbedding("m", "hello")).rejects.toThrow(/does not support/)
  })

  it("generateEmbedding (Tauri ollama) returns the embedding from the invoke result", async () => {
    setTauri(true)
    invokeMock.mockResolvedValue([0.1, 0.2, 0.3])
    const svc = new LocalProviderService("ollama")
    const vec = await svc.generateEmbedding("nomic", "hi")
    expect(vec).toEqual([0.1, 0.2, 0.3])
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
})

describe("checkProviderInstallation", () => {
  it("delegates to the Tauri command when running under Tauri", async () => {
    setTauri(true)
    invokeMock.mockResolvedValue({
      providerId: "ollama",
      installed: true,
      running: true,
      version: "0.6.1",
    })
    const result = await checkProviderInstallation("ollama")
    expect(invokeMock).toHaveBeenCalledWith(
      "local_provider_check_installation",
      expect.objectContaining({ providerId: "ollama" })
    )
    expect(result.installed).toBe(true)
  })

  it("falls back to a HTTP probe when the Tauri command throws", async () => {
    setTauri(true)
    invokeMock.mockRejectedValue(new Error("not implemented"))
    fetchSpy.mockResolvedValue(jsonResponse({ version: "0.5.0" }))
    const result = await checkProviderInstallation("ollama")
    expect(result.installed).toBe(true)
    expect(result.version).toBe("0.5.0")
  })

  it("reports installed=false when the HTTP probe times out / fails (browser)", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"))
    const result = await checkProviderInstallation("ollama")
    expect(result.installed).toBe(false)
    expect(result.running).toBe(false)
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
