/**
 * @jest-environment jsdom
 */

jest.mock("@/lib/network/proxy-fetch", () => ({
  __esModule: true,
  proxyFetch: jest.fn(),
}))

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

import { proxyFetch } from "@/lib/network/proxy-fetch"
import { invoke } from "@tauri-apps/api/core"
import {
  testCustomProviderConnectionByProtocol,
  testOpenAIConnection,
  testAnthropicConnection,
  testGoogleConnection,
  testDeepSeekConnection,
  testGroqConnection,
  testMistralConnection,
  testOllamaConnection,
  testLocalProviderConnectionByUrl,
  testCustomProviderConnection,
  testProviderConnection,
  probeProviderConnection,
  detectLocalProvider,
  detectLocalProviders,
  LOCAL_PROVIDER_TEST_CONFIGS,
} from "./api-test"

const proxyFetchMock = proxyFetch as unknown as jest.Mock
const invokeMock = invoke as unknown as jest.Mock

// jsdom does not expose `fetch` on globalThis; install a single jest.fn() and
// reset its state between tests (same pattern as local-provider-service.test.ts).
const fetchMock = jest.fn()
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch

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

beforeEach(() => {
  proxyFetchMock.mockReset()
  invokeMock.mockReset()
  fetchMock.mockReset()
  setTauri(false)
})

afterEach(() => {
  setTauri(false)
})

describe("LOCAL_PROVIDER_TEST_CONFIGS", () => {
  it("registers a config for every supported local engine", () => {
    expect(Object.keys(LOCAL_PROVIDER_TEST_CONFIGS).sort()).toEqual(
      [
        "jan",
        "koboldcpp",
        "llamacpp",
        "llamafile",
        "localai",
        "lmstudio",
        "ollama",
        "tabbyapi",
        "textgenwebui",
        "vllm",
      ].sort()
    )
  })

  it("exposes url + name + healthPath for every entry", () => {
    for (const [id, cfg] of Object.entries(LOCAL_PROVIDER_TEST_CONFIGS)) {
      expect(cfg.url).toMatch(/^https?:\/\//)
      expect(cfg.name).toBeTruthy()
      expect(cfg.healthPath).toMatch(/^\//)
      expect(id).toBeTruthy()
    }
  })
})

describe("testCustomProviderConnectionByProtocol", () => {
  it("(openai) GETs /models with Bearer auth and returns success on 200", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({}, { status: 200 }))
    const result = await testCustomProviderConnectionByProtocol(
      "https://custom.example.com/v1",
      "sk-test",
      "openai"
    )
    expect(result.success).toBe(true)
    const call = proxyFetchMock.mock.calls[0]
    expect(call[0]).toBe("https://custom.example.com/v1/models")
    expect(call[1].headers.Authorization).toBe("Bearer sk-test")
  })

  it("(openai) normalizes a trailing slash in the base URL", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({}, { status: 200 }))
    await testCustomProviderConnectionByProtocol("https://x.example/v1/", "k", "openai")
    expect(proxyFetchMock.mock.calls[0][0]).toBe("https://x.example/v1/models")
  })

  it("(openai) returns failure with the upstream status when non-2xx", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }))
    const result = await testCustomProviderConnectionByProtocol("https://x", "k", "openai")
    expect(result.success).toBe(false)
    expect(result.message).toContain("401")
  })

  it("(anthropic) POSTs /messages with the x-api-key header and treats 400 as ok", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({}, { status: 400 }))
    const result = await testCustomProviderConnectionByProtocol(
      "https://api.anthropic.com",
      "key",
      "anthropic"
    )
    expect(result.success).toBe(true)
    const call = proxyFetchMock.mock.calls[0]
    expect(call[0]).toBe("https://api.anthropic.com/messages")
    expect(call[1].method).toBe("POST")
    expect(call[1].headers["x-api-key"]).toBe("key")
  })

  it("(gemini) appends the key as a query param", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({}, { status: 200 }))
    const result = await testCustomProviderConnectionByProtocol(
      "https://generativelanguage.googleapis.com/v1",
      "gk",
      "gemini"
    )
    expect(result.success).toBe(true)
    expect(proxyFetchMock.mock.calls[0][0]).toBe(
      "https://generativelanguage.googleapis.com/v1/models?key=gk"
    )
  })

  it("(gemini) returns failure on non-2xx", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({}, { status: 403 }))
    const result = await testCustomProviderConnectionByProtocol("https://x", "k", "gemini")
    expect(result.success).toBe(false)
  })

  it("wraps a thrown error as a failed result", async () => {
    proxyFetchMock.mockRejectedValue(new Error("ECONNREFUSED"))
    const result = await testCustomProviderConnectionByProtocol("https://x", "k", "openai")
    expect(result.success).toBe(false)
    expect(result.message).toContain("ECONNREFUSED")
  })

  it("falls back to a generic message when the throwable is not an Error", async () => {
    proxyFetchMock.mockRejectedValue("bad string")
    const result = await testCustomProviderConnectionByProtocol("https://x", "k", "openai")
    expect(result.success).toBe(false)
    expect(result.message).toBe("Connection failed")
  })
})

describe("testOpenAIConnection", () => {
  it("delegates to Tauri when running inside Tauri", async () => {
    setTauri(true)
    invokeMock.mockResolvedValue({ success: true, message: "tauri ok" })
    const result = await testOpenAIConnection("sk-x")
    expect(invokeMock).toHaveBeenCalledWith("test_openai_connection", {
      apiKey: "sk-x",
      baseUrl: undefined,
    })
    expect(result.message).toBe("tauri ok")
  })

  it("(browser) succeeds and reports model count when /models returns 200", async () => {
    proxyFetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] })
    )
    const result = await testOpenAIConnection("sk-x")
    expect(result.success).toBe(true)
    expect(result.message).toContain("2 models")
    expect(proxyFetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/models")
  })

  it("(browser) supports a custom baseUrl override", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({ data: [] }))
    await testOpenAIConnection("sk-x", "https://custom.openai.example/v1")
    expect(proxyFetchMock.mock.calls[0][0]).toBe("https://custom.openai.example/v1/models")
  })

  it("returns a failure result with status code on non-2xx", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }))
    const result = await testOpenAIConnection("sk-x")
    expect(result.success).toBe(false)
    expect(result.message).toContain("401")
  })

  it("returns a failure result when the call throws", async () => {
    proxyFetchMock.mockRejectedValue(new Error("network down"))
    const result = await testOpenAIConnection("sk-x")
    expect(result.success).toBe(false)
    expect(result.message).toContain("network down")
  })
})

describe("testAnthropicConnection", () => {
  it("delegates to Tauri when available", async () => {
    setTauri(true)
    invokeMock.mockResolvedValue({ success: true, message: "ok" })
    const result = await testAnthropicConnection("sk-ant-xxx-very-long-key-1234567890")
    expect(invokeMock).toHaveBeenCalledWith("test_anthropic_connection", {
      apiKey: expect.any(String),
    })
    expect(result.success).toBe(true)
  })

  it("(browser, valid key shape) returns outcome=limited because CORS blocks verification", async () => {
    const result = await testAnthropicConnection("sk-ant-some-very-long-bearer-token-aaaaaaa")
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("limited")
    expect(result.authoritative).toBe(false)
  })

  it("(browser, short key) returns outcome=failed", async () => {
    const result = await testAnthropicConnection("short")
    expect(result.outcome).toBe("failed")
    expect(result.success).toBe(false)
  })
})

describe("testGoogleConnection", () => {
  it("(browser) appends key as ?key= and reports model count", async () => {
    proxyFetchMock.mockResolvedValue(
      jsonResponse({ models: [{ id: "a" }, { id: "b" }, { id: "c" }] })
    )
    const result = await testGoogleConnection("gkey")
    expect(result.success).toBe(true)
    expect(result.message).toContain("3 models")
    expect(proxyFetchMock.mock.calls[0][0]).toContain("key=gkey")
  })

  it("delegates to Tauri when available", async () => {
    setTauri(true)
    invokeMock.mockResolvedValue({ success: true, message: "tauri-google" })
    await testGoogleConnection("gkey")
    expect(invokeMock).toHaveBeenCalledWith("test_google_connection", { apiKey: "gkey" })
  })

  it("returns failure on 403", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({}, { status: 403 }))
    const result = await testGoogleConnection("gkey")
    expect(result.success).toBe(false)
  })

  it("returns failure when the call throws", async () => {
    proxyFetchMock.mockRejectedValue(new Error("DNS"))
    const result = await testGoogleConnection("gkey")
    expect(result.success).toBe(false)
  })
})

describe("OpenAI-compatible browser fallbacks", () => {
  it.each([
    ["testDeepSeekConnection", testDeepSeekConnection, "https://api.deepseek.com/models"],
    ["testGroqConnection", testGroqConnection, "https://api.groq.com/openai/v1/models"],
    ["testMistralConnection", testMistralConnection, "https://api.mistral.ai/v1/models"],
  ] as const)("%s succeeds with model count on 200", async (_label, fn, expectedUrl) => {
    proxyFetchMock.mockResolvedValue(jsonResponse({ data: [{ id: "x" }] }))
    const result = await fn("sk")
    expect(result.success).toBe(true)
    expect(result.model_info).toBe("1 models")
    expect(proxyFetchMock.mock.calls[0][0]).toBe(expectedUrl)
  })

  it.each([testDeepSeekConnection, testGroqConnection, testMistralConnection])(
    "delegates to Tauri when window.__TAURI_INTERNALS__ is set",
    async (fn) => {
      setTauri(true)
      invokeMock.mockResolvedValue({ success: true, message: "ok" })
      await fn("sk")
      expect(invokeMock).toHaveBeenCalledTimes(1)
    }
  )

  it.each([testDeepSeekConnection, testGroqConnection, testMistralConnection])(
    "returns failure on 401",
    async (fn) => {
      proxyFetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }))
      const result = await fn("sk")
      expect(result.success).toBe(false)
    }
  )
})

describe("testOllamaConnection", () => {
  it("(browser) probes /api/tags and reports local model count", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({ models: [{ name: "llama3" }] }))
    const result = await testOllamaConnection("http://localhost:11434")
    expect(result.success).toBe(true)
    expect(result.message).toContain("1 local models")
    expect(proxyFetchMock.mock.calls[0][0]).toBe("http://localhost:11434/api/tags")
  })

  it("strips a trailing /v1 from the supplied baseUrl before hitting /api/tags", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({ models: [] }))
    await testOllamaConnection("http://localhost:11434/v1")
    expect(proxyFetchMock.mock.calls[0][0]).toBe("http://localhost:11434/api/tags")
  })

  it("delegates to Tauri when available", async () => {
    setTauri(true)
    invokeMock.mockResolvedValue({ success: true, message: "tauri-ollama" })
    await testOllamaConnection("http://localhost:11434")
    expect(invokeMock).toHaveBeenCalledWith("test_ollama_connection", {
      baseUrl: "http://localhost:11434",
    })
  })

  it("returns failure with HTTP code on non-2xx", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({}, { status: 503 }))
    const result = await testOllamaConnection("http://localhost:11434")
    expect(result.success).toBe(false)
    expect(result.message).toContain("503")
  })
})

describe("testLocalProviderConnectionByUrl", () => {
  it("appends /v1 when missing and includes a model preview in the success message", async () => {
    proxyFetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: "phi3" }, { id: "mistral" }, { id: "qwen" }] })
    )
    const result = await testLocalProviderConnectionByUrl("http://localhost:1234", "LM Studio")
    expect(result.success).toBe(true)
    expect(proxyFetchMock.mock.calls[0][0]).toBe("http://localhost:1234/v1/models")
    expect(result.message).toContain("LM Studio")
    expect(result.message).toContain("phi3")
  })

  it("uses 'Local' as the default provider name", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({ data: [] }))
    const result = await testLocalProviderConnectionByUrl("http://localhost:1234")
    expect(result.message).toContain("Local")
  })

  it("returns failure with HTTP code on non-2xx", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({}, { status: 500 }))
    const result = await testLocalProviderConnectionByUrl("http://localhost:1234", "vLLM")
    expect(result.success).toBe(false)
    expect(result.message).toContain("vLLM")
    expect(result.message).toContain("500")
  })
})

describe("testCustomProviderConnection", () => {
  it("delegates to Tauri when available", async () => {
    setTauri(true)
    invokeMock.mockResolvedValue({ success: true, message: "ok" })
    await testCustomProviderConnection("https://x.example", "k")
    expect(invokeMock).toHaveBeenCalledWith("test_custom_provider_connection", {
      baseUrl: "https://x.example",
      apiKey: "k",
    })
  })

  it("(browser) appends /models with a leading slash when baseUrl lacks trailing slash", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({ data: [] }))
    await testCustomProviderConnection("https://api.example", "k")
    expect(proxyFetchMock.mock.calls[0][0]).toBe("https://api.example/models")
  })

  it("(browser) handles a trailing slash without doubling", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({ data: [] }))
    await testCustomProviderConnection("https://api.example/", "k")
    expect(proxyFetchMock.mock.calls[0][0]).toBe("https://api.example/models")
  })
})

describe("probeProviderConnection / testProviderConnection", () => {
  it("routes openai → testOpenAIConnection (browser)", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({ data: [{ id: "a" }] }))
    const result = await probeProviderConnection({ providerId: "openai", apiKey: "sk" })
    expect(result.outcome).toBe("verified")
    expect(result.authoritative).toBe(true)
  })

  it("routes ollama → testOllamaConnection (with default config URL)", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({ models: [] }))
    await probeProviderConnection({ providerId: "ollama" })
    expect(proxyFetchMock.mock.calls[0][0]).toBe(
      `${LOCAL_PROVIDER_TEST_CONFIGS.ollama.url}/api/tags`
    )
  })

  it.each(["lmstudio", "llamacpp", "vllm", "localai", "jan", "tabbyapi"] as const)(
    "routes local provider %s through testLocalProviderConnectionByUrl",
    async (providerId) => {
      proxyFetchMock.mockResolvedValue(jsonResponse({ data: [] }))
      await probeProviderConnection({ providerId })
      const expected = LOCAL_PROVIDER_TEST_CONFIGS[providerId].url
      expect(proxyFetchMock.mock.calls[0][0]).toMatch(new RegExp(`^${expected}`))
    }
  )

  it("falls through to a protocol probe when an unknown provider provides baseURL", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({ data: [] }))
    const result = await probeProviderConnection({
      providerId: "totally-custom",
      apiKey: "k",
      baseURL: "https://custom.example/v1",
      protocol: "openai",
    })
    expect(result.outcome).toBe("verified")
    expect(proxyFetchMock.mock.calls[0][0]).toBe("https://custom.example/v1/models")
  })

  it("returns outcome=failed when an unknown provider has no baseURL", async () => {
    const result = await probeProviderConnection({ providerId: "ghost" })
    expect(result.outcome).toBe("failed")
    expect(result.authoritative).toBe(true)
  })

  it("propagates outcome=limited from Anthropic in the browser fallback", async () => {
    const result = await probeProviderConnection({
      providerId: "anthropic",
      apiKey: "sk-ant-1234567890123456789012345678",
    })
    expect(result.outcome).toBe("limited")
    expect(result.authoritative).toBe(false)
  })

  it("testProviderConnection is a thin wrapper around probeProviderConnection", async () => {
    proxyFetchMock.mockResolvedValue(jsonResponse({ data: [] }))
    const result = await testProviderConnection("openai", "sk")
    expect(result.outcome).toBe("verified")
  })
})

describe("detectLocalProvider (single)", () => {
  it("returns null when neither a known providerId nor a customUrl is given", async () => {
    const result = await detectLocalProvider("not-a-provider")
    expect(result).toBeNull()
  })

  it("(ollama format) reports isRunning=true and extracts model names", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ models: [{ name: "llama3.2" }] }))
    const result = await detectLocalProvider("ollama")
    expect(result?.isRunning).toBe(true)
    expect(result?.models).toEqual(["llama3.2"])
  })

  it("(OpenAI-compatible format) extracts model ids from data[]", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: "phi3" }, { id: "mistral" }] }))
    const result = await detectLocalProvider("lmstudio")
    expect(result?.isRunning).toBe(true)
    expect(result?.models).toEqual(["phi3", "mistral"])
  })

  it("reports isRunning=false when fetch throws", async () => {
    fetchMock.mockRejectedValue(new Error("ECONN"))
    const result = await detectLocalProvider("ollama")
    expect(result?.isRunning).toBe(false)
  })

  it("respects a customUrl over the registered config", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }))
    const result = await detectLocalProvider("ollama", "http://192.168.0.5:11434")
    expect(result?.baseUrl).toBe("http://192.168.0.5:11434")
  })
})

describe("detectLocalProviders (batch)", () => {
  it("checks every registered provider in parallel and returns one result per known id", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }))
    const results = await detectLocalProviders()
    expect(results.length).toBe(Object.keys(LOCAL_PROVIDER_TEST_CONFIGS).length)
  })

  it("filters to the provided id list", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }))
    const results = await detectLocalProviders(["ollama", "lmstudio"])
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.providerId).sort()).toEqual(["lmstudio", "ollama"])
  })

  it("marks unreachable providers as isRunning=false rather than dropping them", async () => {
    fetchMock.mockRejectedValue(new Error("ECONN"))
    const results = await detectLocalProviders(["ollama"])
    expect(results[0].isRunning).toBe(false)
  })

  it("skips unknown provider ids silently", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }))
    const results = await detectLocalProviders(["ollama", "not-a-real-provider"])
    expect(results.length).toBe(1)
    expect(results[0].providerId).toBe("ollama")
  })
})
