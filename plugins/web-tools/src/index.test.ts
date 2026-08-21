/**
 * @jest-environment jsdom
 */

import type { PluginContext } from "@/types/plugin"

jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))

// Controllable settings + search-service doubles so `web_search` unit-tests
// without the real Zustand store / provider network calls.
let mockSettings: Record<string, unknown> = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: mockSettings }) },
}))
const mockSearch = jest.fn()
jest.mock("@/lib/search/search-service", () => ({
  // Lazy wrappers (the factory is hoisted above the `const`s, so reference them
  // only when invoked); cast to a rest-param callable so the spread type-checks.
  search: (...args: unknown[]) => (mockSearch as (...a: unknown[]) => unknown)(...args),
  formatSearchResultsForLLM: () => "FORMATTED_RESULTS",
}))
// `parseHTML` pulls in cheerio (ESM), which Jest's CJS transform can't load
// (its own test is skipped for the same reason), so mock it to assert the
// plugin's extraction branch without exercising cheerio.
const mockParseHTML = jest.fn(async () => ({ text: "Readable body text.", title: "My Page" }))
jest.mock("@cognia/document/parsers/html-parser", () => ({
  parseHTML: (...args: unknown[]) => (mockParseHTML as (...a: unknown[]) => unknown)(...args),
}))
// Virtual fs double for the desktop `web_download` path.
const mockWriteFile = jest.fn(async (_p: string, _data: Uint8Array) => undefined)
jest.mock(
  "@tauri-apps/plugin-fs",
  () => ({ writeFile: (...a: unknown[]) => (mockWriteFile as (...x: unknown[]) => unknown)(...a) }),
  { virtual: true }
)

import webTools from "./index"

/** A search provider record that `isProviderConfigured` accepts (enabled + key). */
const tavilyConfigured = {
  tavily: { providerId: "tavily", apiKey: "tvly-xxx", enabled: true, priority: 1 },
}

interface AgentMock {
  invokeTool?: jest.Mock
  runStreamed?: jest.Mock
}

const makeCtx = (config: Record<string, unknown> = {}, agentOverride: AgentMock = {}) => {
  const tools: Record<string, (args: unknown) => Promise<unknown>> = {}
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-web-tools",
    config,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    agent: {
      registerTool: ({
        name,
        execute,
      }: {
        name: string
        execute: (args: unknown) => Promise<unknown>
      }) => {
        tools[name] = execute
      },
      ...agentOverride,
    } as never,
  }
  return { ctx: ctx as PluginContext, tools }
}

// Build a runStreamed mock that yields the given events then resolves `result`.
function streamMock(
  events: Array<{ type: string; delta?: string }>,
  result: Record<string, unknown>
) {
  return jest.fn((_prompt: string, _opts: unknown) => ({
    agentId: "run-1",
    result: Promise.resolve(result),
    cancel: jest.fn(),
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e
      yield { type: "result", result }
    },
  }))
}

describe("web-tools (built-in)", () => {
  beforeEach(() => {
    // jsdom 22+ has fetch; we replace with a controlled mock per test.
    ;(globalThis as { fetch: unknown }).fetch = jest.fn()
    mockSettings = {}
    mockSearch.mockReset()
    mockParseHTML.mockClear()
  })

  it("registers web_search + web_fetch + web_download + web_research on activate", async () => {
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    expect(Object.keys(tools).sort()).toEqual([
      "web_download",
      "web_fetch",
      "web_research",
      "web_search",
    ])
  })

  // ADR-0127: the plugin's own tools ship rich chat cards through the
  // host's tool-result renderer registry (previously zero first-party
  // registrations); deactivate disposes them.
  it("registers web_search + web_fetch result cards on activate and disposes them on deactivate", async () => {
    const { ctx } = makeCtx()
    const dispose = jest.fn()
    const registerToolResultRenderer = jest.fn((_tool: string, _render: unknown) => dispose)
    ;(ctx as { toolResult?: unknown }).toolResult = { registerToolResultRenderer }
    await webTools.activate?.(ctx)
    expect(registerToolResultRenderer.mock.calls.map((c) => c[0]).sort()).toEqual([
      "web_fetch",
      "web_search",
    ])
    for (const call of registerToolResultRenderer.mock.calls) {
      expect(typeof call[1]).toBe("function")
    }
    await webTools.deactivate?.(ctx)
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it("activates without a toolResult API (older hosts)", async () => {
    const { ctx, tools } = makeCtx()
    await expect(webTools.activate?.(ctx)).resolves.not.toThrow()
    expect(Object.keys(tools)).toContain("web_search")
  })

  it("web_fetch requires a url", async () => {
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    const result = await tools.web_fetch({})
    expect(result).toMatchObject({ ok: false })
  })

  it("web_fetch returns body / status from a successful request", async () => {
    ;(globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "text/plain"]]),
      text: async () => "hello world",
    }))
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    const result = (await tools.web_fetch({ url: "https://example.com" })) as {
      ok: boolean
      status: number
      body: string
    }
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.body).toContain("hello world")
  })

  it("web_fetch extracts readable text + title from an HTML response", async () => {
    ;(globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "text/html; charset=utf-8"]]),
      text: async () =>
        "<html><head><title>My Page</title></head><body><h1>Heading</h1><p>Readable body text.</p></body></html>",
    }))
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    const result = (await tools.web_fetch({ url: "https://example.com" })) as {
      ok: boolean
      body?: string
      text?: string
      title?: string
    }
    expect(result.ok).toBe(true)
    // Token-optimized core (web-tools-core) drops the raw HTML body for the
    // extracted-HTML path — it returns only the readable text + title so the
    // model isn't billed for the same content twice ("drop double-content").
    expect(result.body).toBeUndefined()
    expect(mockParseHTML).toHaveBeenCalled()
    // Non-distilled page text is framed as untrusted for injection safety.
    expect(result.text).toContain("Readable body text.")
    expect(result.text).toContain("Untrusted web content")
    expect(result.title).toBe("My Page")
  })

  it("web_fetch skips extraction when format is 'raw'", async () => {
    ;(globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "text/html"]]),
      text: async () => "<p>hi</p>",
    }))
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    const result = (await tools.web_fetch({ url: "https://example.com", format: "raw" })) as {
      text?: string
    }
    expect(result.text).toBeUndefined()
    expect(mockParseHTML).not.toHaveBeenCalled()
  })

  it("web_fetch does not extract for non-HTML content", async () => {
    ;(globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => '{"a":1}',
    }))
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    const result = (await tools.web_fetch({ url: "https://x.test/api" })) as {
      body: string
      text?: string
    }
    expect(result.body).toBe('{"a":1}')
    expect(result.text).toBeUndefined()
    expect(mockParseHTML).not.toHaveBeenCalled()
  })

  it("web_search requires a query", async () => {
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    expect(await tools.web_search({})).toMatchObject({ ok: false })
  })

  it("web_search errors when no provider is configured", async () => {
    mockSettings = { searchProviders: {} }
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    const result = (await tools.web_search({ query: "weather" })) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no web search provider/i)
    expect(mockSearch).not.toHaveBeenCalled()
  })

  it("web_search delegates to lib/search and returns structured results", async () => {
    mockSettings = { searchProviders: tavilyConfigured, searchMaxResults: 7 }
    mockSearch.mockResolvedValue({
      provider: "tavily",
      query: "weather",
      answer: "Sunny.",
      results: [{ title: "T", url: "https://x.test", content: "c", score: 0.9 }],
      responseTime: 12,
      totalResults: 1,
    })
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    const result = (await tools.web_search({ query: "weather" })) as {
      ok: boolean
      provider: string
      answer: string
      results: Array<{ title: string; url: string }>
      formatted?: string
    }
    expect(result.ok).toBe(true)
    expect(result.provider).toBe("tavily")
    expect(result.answer).toBe("Sunny.")
    expect(result.results[0]).toMatchObject({ title: "T", url: "https://x.test" })
    // Token-optimized core returns structured results only — the legacy
    // `formatted` markdown block was removed to avoid sending the same content
    // twice (structured + prose). Assert it's no longer present.
    expect(result.formatted).toBeUndefined()
    // Provider settings + the configured maxResults default were passed through.
    const opts = mockSearch.mock.calls[0][1] as { providerSettings: unknown; maxResults?: number }
    expect(opts.providerSettings).toEqual(tavilyConfigured)
    expect(opts.maxResults).toBe(7)
  })

  it("web_search surfaces a thrown provider error", async () => {
    mockSettings = { searchProviders: tavilyConfigured }
    mockSearch.mockRejectedValue(new Error("rate limited"))
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    expect(await tools.web_search({ query: "x" })).toMatchObject({
      ok: false,
      error: "rate limited",
    })
  })

  it("web_fetch traps fetch errors", async () => {
    ;(globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => {
      throw new Error("boom")
    })
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    const result = await tools.web_fetch({ url: "https://example.com" })
    expect(result).toMatchObject({ ok: false, error: "boom" })
  })

  it("web_download falls back to a browser <a> when not in Tauri", async () => {
    ;(globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    }))
    // jsdom doesn't ship URL.createObjectURL — stub it for this test.
    ;(URL as unknown as { createObjectURL: jest.Mock }).createObjectURL = jest.fn(() => "blob:mock")
    ;(URL as unknown as { revokeObjectURL: jest.Mock }).revokeObjectURL = jest.fn()
    const click = jest.fn()
    const create = jest.spyOn(document, "createElement").mockImplementation((tag) => {
      if (tag === "a") {
        return { href: "", download: "", click } as unknown as HTMLAnchorElement
      }
      return document.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElement
    })
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    const result = (await tools.web_download({
      url: "https://example.com/foo.bin",
    })) as { ok: boolean; downloadedAs: string; bytes: number }
    expect(result.ok).toBe(true)
    expect(result.bytes).toBe(8)
    expect(click).toHaveBeenCalled()
    create.mockRestore()
  })

  it("web_download requires a url", async () => {
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    expect(await tools.web_download({})).toMatchObject({ ok: false })
  })

  it("web_download falls back to download.bin when the url has no parseable name", async () => {
    ;(globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(1),
    }))
    ;(URL as unknown as { createObjectURL: jest.Mock }).createObjectURL = jest.fn(() => "blob:mock")
    ;(URL as unknown as { revokeObjectURL: jest.Mock }).revokeObjectURL = jest.fn()
    const create = jest
      .spyOn(document, "createElement")
      .mockImplementation(
        (tag) =>
          (tag === "a"
            ? { href: "", download: "", click: jest.fn() }
            : document.createElementNS("http://www.w3.org/1999/xhtml", tag)) as HTMLElement
      )
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    // "::::" is not a valid URL → basenameFromUrl's catch returns the default.
    const result = (await tools.web_download({ url: "::::" })) as {
      ok: boolean
      downloadedAs: string
    }
    expect(result.ok).toBe(true)
    expect(result.downloadedAs).toBe("download.bin")
    create.mockRestore()
  })

  it("web_download surfaces an HTTP error", async () => {
    ;(globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
    }))
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    const result = (await tools.web_download({ url: "https://x.test/f.bin" })) as {
      ok: boolean
      error: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/503/)
  })

  it("web_download traps fetch errors", async () => {
    ;(globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => {
      throw new Error("network down")
    })
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    const result = (await tools.web_download({ url: "https://x.test/f.bin" })) as {
      ok: boolean
      error: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/network down/)
  })

  it("web_download writes to disk on the Tauri path", async () => {
    ;(globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(5),
    }))
    mockWriteFile.mockClear()
    const tools: Record<string, (a: unknown) => Promise<unknown>> = {}
    const ctx = {
      pluginId: "cognia-web-tools",
      capabilities: { tauri: true },
      config: { downloadDirectory: "/tmp/dl" },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      agent: {
        registerTool: ({
          name,
          execute,
        }: {
          name: string
          execute: (a: unknown) => Promise<unknown>
        }) => {
          tools[name] = execute
        },
      },
    } as unknown as PluginContext
    await webTools.activate?.(ctx)
    const result = (await tools.web_download({ url: "https://x.test/report.pdf" })) as {
      ok: boolean
      path: string
      bytes: number
    }
    expect(result.ok).toBe(true)
    expect(result.path).toBe("/tmp/dl/report.pdf")
    expect(result.bytes).toBe(5)
    expect(mockWriteFile).toHaveBeenCalledWith("/tmp/dl/report.pdf", expect.any(Uint8Array))
  })

  it("web_download (Tauri) errors when no download directory is configured", async () => {
    ;(globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(2),
    }))
    const tools: Record<string, (a: unknown) => Promise<unknown>> = {}
    const ctx = {
      pluginId: "cognia-web-tools",
      capabilities: { tauri: true },
      config: {},
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      agent: {
        registerTool: ({
          name,
          execute,
        }: {
          name: string
          execute: (a: unknown) => Promise<unknown>
        }) => {
          tools[name] = execute
        },
      },
    } as unknown as PluginContext
    await webTools.activate?.(ctx)
    const result = (await tools.web_download({ url: "https://x.test/f.bin" })) as {
      ok: boolean
      error: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/downloadDirectory/)
  })

  it("registers an availability context provider when the host exposes agent.context", async () => {
    const registerProvider = jest.fn()
    const { ctx } = makeCtx({}, {})
    ;(ctx.agent as unknown as { context?: { registerProvider: jest.Mock } }).context = {
      registerProvider,
    }
    await webTools.activate?.(ctx)
    expect(registerProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: "web-tools:availability" })
    )
    // The provider's `provide()` returns the availability blurb.
    const provider = registerProvider.mock.calls[0][0] as { provide: () => string }
    expect(provider.provide()).toMatch(/web_search/)
  })

  it("deactivate runs without throwing", async () => {
    const { ctx } = makeCtx()
    await webTools.activate?.(ctx)
    await expect(webTools.deactivate?.(ctx)).resolves.not.toThrow()
  })

  describe("web_research (Agent SDK dogfood)", () => {
    it("requires a query", async () => {
      const { ctx, tools } = makeCtx()
      await webTools.activate?.(ctx)
      const result = await tools.web_research({})
      expect(result).toMatchObject({ ok: false })
    })

    it("errors when the host doesn't expose the Agent SDK", async () => {
      const { ctx, tools } = makeCtx() // no invokeTool / runStreamed
      await webTools.activate?.(ctx)
      const result = await tools.web_research({ query: "what is x" })
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Agent SDK/) })
    })

    it("fetches urls via invokeTool, runs a structured PII-gated summary, returns the object", async () => {
      const invokeTool = jest.fn(async () => ({ body: "page body text" }))
      const runStreamed = streamMock([{ type: "text-delta", delta: "sum" }], {
        text: '{"summary":"ok"}',
        channel: "text",
        object: { summary: "ok", sources: [{ url: "https://a.com", title: "A" }] },
        parseError: null,
        agentId: "run-1",
        toolsAvailable: false,
      })
      const { ctx, tools } = makeCtx({}, { invokeTool, runStreamed })
      await webTools.activate?.(ctx)

      const result = (await tools.web_research({
        query: "summarize",
        urls: ["https://a.com"],
      })) as { ok: boolean; object: unknown; fetched: string[]; channel: string }

      expect(invokeTool).toHaveBeenCalledWith("web_fetch", {
        url: "https://a.com",
        maxBytes: 20_000,
      })
      // runStreamed got structured output + a canUseTool gate.
      const runOpts = runStreamed.mock.calls[0][1] as { outputFormat: unknown; canUseTool: unknown }
      expect(runOpts.outputFormat).toMatchObject({ type: "json_schema" })
      expect(typeof runOpts.canUseTool).toBe("function")
      expect(result.ok).toBe(true)
      expect(result.channel).toBe("text")
      expect(result.object).toEqual({
        summary: "ok",
        sources: [{ url: "https://a.com", title: "A" }],
      })
      expect(result.fetched).toEqual(["https://a.com"])
    })

    it("tolerates a failing invokeTool and still summarizes", async () => {
      const invokeTool = jest.fn(async () => {
        throw new Error("fetch denied")
      })
      const runStreamed = streamMock([], {
        text: "{}",
        channel: "text",
        object: { summary: "no sources" },
        parseError: null,
        agentId: "r",
        toolsAvailable: false,
      })
      const { ctx, tools } = makeCtx({}, { invokeTool, runStreamed })
      await webTools.activate?.(ctx)
      const result = (await tools.web_research({
        query: "q",
        urls: ["https://bad.com"],
      })) as { ok: boolean; fetched: string[] }
      expect(result.ok).toBe(true)
      expect(result.fetched).toEqual([])
      expect(ctx.logger?.warn).toHaveBeenCalled()
    })

    it("wires a non-empty-summary output guardrail", async () => {
      const runStreamed = streamMock([], {
        text: "{}",
        channel: "text",
        object: { summary: "x" },
        parseError: null,
      })
      const { ctx, tools } = makeCtx({}, { invokeTool: jest.fn(), runStreamed })
      await webTools.activate?.(ctx)
      await tools.web_research({ query: "q" })
      const runOpts = runStreamed.mock.calls[0][1] as {
        guardrails: Array<{
          id: string
          run: (a: { output: string }) => { tripwireTriggered: boolean }
        }>
      }
      const guard = runOpts.guardrails[0]
      expect(guard.id).toBe("web-research:non-empty-summary")
      expect(guard.run({ output: "   " }).tripwireTriggered).toBe(true)
      expect(guard.run({ output: "real summary" }).tripwireTriggered).toBe(false)
    })

    it("survives a delta-stream iteration error and still returns run.result", async () => {
      // An async iterator that throws mid-drain — the best-effort logging loop
      // must swallow it and fall through to the authoritative run.result.
      const runStreamed = jest.fn(() => ({
        agentId: "r",
        result: Promise.resolve({
          text: "{}",
          channel: "text",
          object: { summary: "ok" },
          parseError: null,
        }),
        cancel: jest.fn(),
        async *[Symbol.asyncIterator](): AsyncGenerator<never> {
          throw new Error("stream blew up")
        },
      }))
      const { ctx, tools } = makeCtx({}, { invokeTool: jest.fn(), runStreamed })
      await webTools.activate?.(ctx)
      const result = (await tools.web_research({ query: "q" })) as { ok: boolean; object: unknown }
      expect(result.ok).toBe(true)
      expect(result.object).toEqual({ summary: "ok" })
      expect(ctx.logger?.warn).toHaveBeenCalledWith(expect.stringMatching(/stream logging error/))
    })
  })
})
