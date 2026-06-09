/**
 * @jest-environment jsdom
 */

import type { PluginContext } from "@/types/plugin"

jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))

import webTools from "./index"

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
  return jest.fn(() => ({
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
  })

  it("registers web_fetch + web_download + web_research on activate", async () => {
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    expect(Object.keys(tools).sort()).toEqual(["web_download", "web_fetch", "web_research"])
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
      const runOpts = runStreamed.mock.calls[0][1]
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
  })
})
