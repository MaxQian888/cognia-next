import type { PluginContext, PluginToolContext } from "@/types/plugin"
import type { AiBridge } from "./lib/ai"
import type { EngineDeps, SearchHit } from "./types"

jest.mock("./runtime", () => ({ buildEngineDeps: jest.fn() }))
import { buildEngineDeps } from "./runtime"
import { registerDeepResearchTool, resolveConfig, runResearchTool } from "./tool"

const mockBuild = buildEngineDeps as jest.MockedFunction<typeof buildEngineDeps>

function hit(url: string): SearchHit {
  return { url, title: `T ${url}`, content: "snippet", score: 1 }
}

/** Scripted ai: search → read → answer → pass. */
function scriptedDeps(): EngineDeps {
  const decisions = [
    '{"action":"search","queries":["q"]}',
    '{"action":"read","urls":["https://a.com"]}',
    '{"action":"answer"}',
  ]
  let d = 0
  const ai: AiBridge = {
    chat: async function* (messages) {
      const sys = messages[0]?.content ?? ""
      let text = ""
      if (sys.includes("controller of an iterative"))
        text = decisions[Math.min(d++, decisions.length - 1)]
      else if (sys.includes("research analyst")) text = "Answer [1]."
      else if (sys.includes("answer evaluator")) text = '{"pass":true,"reasons":[]}'
      yield { content: text, usage: { totalTokens: 5 } }
    },
    embed: async (t) => t.map((_, i) => [i + 1, 0]),
  }
  return { ai, search: async () => [hit("https://a.com")], read: async () => "content body" }
}

/** Report-capable deps: outline → per-section loop → coherence. */
function reportDeps(): EngineDeps {
  let n = 0
  const ai: AiBridge = {
    chat: async function* (messages) {
      const sys = messages[0]?.content ?? ""
      const user = messages[1]?.content ?? ""
      let text = ""
      if (sys.includes("research lead planning a report"))
        text = '{"title":"T","sections":[{"heading":"H","question":"q?"}]}'
      else if (sys.includes("senior analyst assembling")) text = "# T\n\nProse [1]."
      else if (sys.includes("controller of an iterative")) {
        const read = Number(/(\d+) sources read/.exec(user)?.[1] ?? "0")
        const unread = Number(/UNREAD SOURCES \((\d+)\)/.exec(user)?.[1] ?? "0")
        text =
          unread > 0
            ? '{"action":"read"}'
            : read === 0
              ? '{"action":"search","queries":["q"]}'
              : '{"action":"answer"}'
      } else if (sys.includes("research analyst")) text = "Answer [1]."
      else if (sys.includes("answer evaluator")) text = '{"pass":true,"reasons":[]}'
      yield { content: text, usage: { totalTokens: 2 } }
    },
    embed: async (t) => t.map((_, i) => [i + 1, 0]),
  }
  return { ai, search: async () => [hit(`https://s${n++}.com`)], read: async () => "body" }
}

function ctx(config: Record<string, unknown> = {}): PluginContext {
  return {
    pluginId: "cognia-deep-research",
    config,
    agent: { registerTool: jest.fn() },
  } as unknown as PluginContext
}

beforeEach(() => mockBuild.mockReset())

describe("resolveConfig", () => {
  it("applies a depth preset", () => {
    expect(resolveConfig({}, "quick")).toMatchObject({ maxSteps: 8, readTopK: 2 })
    expect(resolveConfig({}, "deep")).toMatchObject({ maxSteps: 36 })
    expect(resolveConfig({}, "standard")).toEqual({})
  })
  it("lets explicit config override the preset", () => {
    expect(resolveConfig({ maxSteps: 5 }, "deep").maxSteps).toBe(5)
  })
})

describe("runResearchTool", () => {
  it("requires a query", async () => {
    const out = await runResearchTool(ctx(), { query: "   " })
    expect(out).toEqual({ ok: false, error: "query is required" })
  })

  it("returns a friendly error when deps cannot be built", async () => {
    mockBuild.mockResolvedValue({ ok: false, error: "MISSING_KEY", provider: "exa" })
    const out = (await runResearchTool(ctx(), { query: "q" })) as { ok: boolean; error: string }
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/exa/)
  })

  it("runs the loop and returns a grounded result", async () => {
    mockBuild.mockResolvedValue({ ok: true, deps: scriptedDeps() })
    const out = (await runResearchTool(ctx(), { query: "what is x?", depth: "quick" })) as {
      ok: boolean
      answer: string
      citations: unknown[]
      gaveUp: boolean
      steps: number
    }
    expect(out.ok).toBe(true)
    expect(out.answer).toContain("[1]")
    expect(out.citations).toHaveLength(1)
    expect(out.gaveUp).toBe(false)
    expect(out.steps).toBeGreaterThanOrEqual(3)
  })

  it("produces a multi-section report in report mode", async () => {
    mockBuild.mockResolvedValue({ ok: true, deps: reportDeps() })
    const out = (await runResearchTool(ctx(), { query: "topic", mode: "report" })) as {
      ok: boolean
      mode: string
      report: string
      title: string
      sections: number
    }
    expect(out.ok).toBe(true)
    expect(out.mode).toBe("report")
    expect(out.title).toBe("T")
    expect(out.report).toContain("Sources")
    expect(out.sections).toBe(1)
  })

  it("threads reportProgress + signal from the tool context into buildEngineDeps", async () => {
    mockBuild.mockResolvedValue({ ok: true, deps: scriptedDeps() })
    const toolCtx = {
      reportProgress: jest.fn(),
      signal: new AbortController().signal,
    } as unknown as PluginToolContext
    await runResearchTool(ctx(), { query: "q" }, toolCtx)
    expect(mockBuild).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reportProgress: toolCtx.reportProgress, signal: toolCtx.signal })
    )
  })
})

describe("registerDeepResearchTool", () => {
  it("registers a deep_research tool whose execute delegates to the loop", async () => {
    mockBuild.mockResolvedValue({ ok: true, deps: scriptedDeps() })
    const c = ctx()
    registerDeepResearchTool(c)
    const registerTool = (c.agent as unknown as { registerTool: jest.Mock }).registerTool
    expect(registerTool).toHaveBeenCalledTimes(1)
    const tool = registerTool.mock.calls[0][0]
    expect(tool.name).toBe("deep_research")
    const out = (await tool.execute({ query: "q" }, undefined)) as { ok: boolean }
    expect(out.ok).toBe(true)
  })
})
