import type { PluginContext } from "@cognia/plugin-sdk"
import type { AiBridge } from "./lib/ai"
import type { EngineDeps, SearchHit } from "./types"

jest.mock("./runtime", () => ({ buildEngineDeps: jest.fn() }))
import { buildEngineDeps } from "./runtime"
import { ResearchToolError } from "./errors"
import { handleResearchSlash, parseResearchArgs } from "./slash"
import manifestJson from "../plugin.json"

const mockBuild = buildEngineDeps as jest.MockedFunction<typeof buildEngineDeps>

function hit(url: string): SearchHit {
  return { url, title: `T ${url}`, content: "snippet", score: 1 }
}

function okDeps(): EngineDeps {
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
      else if (sys.includes("research analyst")) text = "Cited answer [1]."
      else if (sys.includes("answer evaluator")) text = '{"pass":true,"reasons":[]}'
      yield { content: text }
    },
    embed: async (t) => t.map((_, i) => [i + 1, 0]),
  }
  return { ai, search: async () => [hit("https://a.com")], read: async () => "content body" }
}

type Locale = keyof typeof manifestJson.i18n.locales

/** `ctx.i18n.t` over the plugin's own bundle, failing loudly on a missing key. */
function translator(locale: Locale = "en") {
  const bundle = manifestJson.i18n.locales[locale] as Record<string, string>
  return (key: string, params?: Record<string, string | number>) => {
    const value = bundle[key]
    if (value === undefined) throw new Error(`missing ${locale} key ${key}`)
    return value.replace(/\{(\w+)\}/g, (match, name: string) =>
      params?.[name] !== undefined ? String(params[name]) : match
    )
  }
}
const t = translator()

function ctx(config: Record<string, unknown> = {}): PluginContext {
  return {
    pluginId: "cognia-deep-research",
    configuration: { getAll: () => config },
    artifact: { createArtifact: jest.fn(async () => "art-7"), openArtifact: jest.fn() },
    logger: { info: jest.fn(), warn: jest.fn() },
    i18n: { t },
  } as unknown as PluginContext
}

beforeEach(() => {
  mockBuild.mockReset()
})

describe("handleResearchSlash", () => {
  it("passes cancellation and progress to the research engine", async () => {
    const controller = new AbortController()
    const reportProgress = jest.fn()
    mockBuild.mockImplementation((_ctx, options) => ({ ...okDeps(), ...options }))
    controller.abort()
    const res = await handleResearchSlash(ctx(), "question", {
      sessionId: "s1",
      signal: controller.signal,
      reportProgress,
    })
    expect(mockBuild).toHaveBeenCalledWith(expect.anything(), {
      sessionId: "s1",
      signal: controller.signal,
      reportProgress,
    })
    expect(res.payload).toMatchObject({ aborted: true })
  })

  it("reports engine progress to the command caller", async () => {
    const reportProgress = jest.fn()
    mockBuild.mockImplementation((_ctx, options) => ({ ...okDeps(), ...options }))
    await handleResearchSlash(ctx(), "question", { reportProgress })
    expect(reportProgress).toHaveBeenCalledWith(expect.any(Number), expect.any(String))
  })

  it("returns usage for an empty query", async () => {
    const res = await handleResearchSlash(ctx(), "  ")
    expect(res.message).toMatch(/Usage/)
    // One language per message: no Chinese appended to the English usage.
    expect(res.message).not.toMatch(/[\u4e00-\u9fff]/)
    expect(mockBuild).not.toHaveBeenCalled()
  })

  it("answers in the user's locale", async () => {
    const zhCtx = { ...ctx(), i18n: { t: translator("zh-CN") } } as unknown as PluginContext
    const res = await handleResearchSlash(zhCtx, "  ")
    expect(res.message).toContain("用法")
  })

  it("renders an actionable card when the host has no model provider", async () => {
    const failure = Object.assign(new Error("nope"), { code: "NO_PROVIDER_AVAILABLE" })
    mockBuild.mockReturnValue({
      ai: {
        chat: async function* () {
          throw failure
        },
        embed: async () => [],
      },
      search: async () => [],
      read: async () => "",
    })
    const res = await handleResearchSlash(ctx(), "some question")
    expect(res.handled).toBe(true)
    expect(res.message).toContain("AI model provider")
  })

  it("renders an actionable card when no search provider is configured", async () => {
    mockBuild.mockReturnValue({
      ai: okDeps().ai,
      search: async () => {
        throw new ResearchToolError("NO_SEARCH_PROVIDER", "none")
      },
      read: async () => "",
    })
    const res = await handleResearchSlash(ctx(), "some question")
    expect(res.message).toContain("Settings → Search")
  })

  it("returns a cited result card on success", async () => {
    mockBuild.mockReturnValue(okDeps())
    const res = await handleResearchSlash(ctx(), "what is x?")
    expect(res.message).toContain("Deep Research")
    expect(res.message).toContain("Cited answer [1].")
    expect(res.message).toContain("Sources")
  })

  it("runs report mode for `/research report <topic>`", async () => {
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
        yield { content: text }
      },
      embed: async (t) => t.map((_, i) => [i + 1, 0]),
    }
    mockBuild.mockReturnValue({
      ai,
      search: async () => [hit(`https://s${n++}.com`)],
      read: async () => "body",
    })
    const res = await handleResearchSlash(ctx(), "report the big topic")
    expect(res.message).toContain("deep research report")
    expect(res.message).toContain("Sources")
  })

  it("files the report as an artifact and opens it — the user asked for a document", async () => {
    mockBuild.mockReturnValue({
      ai: okDeps().ai,
      search: async () => [hit("https://a.com")],
      read: async () => "body",
    })
    const c = ctx()
    const res = await handleResearchSlash(c, "report the big topic", { sessionId: "s-1" })
    expect(res.payload).toMatchObject({ artifactId: "art-7" })
    expect(c.artifact.createArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "report", sessionId: "s-1" })
    )
    expect(c.artifact.openArtifact).toHaveBeenCalledWith("art-7")
  })

  it("honours a depth prefix on the slash command", async () => {
    // `/research deep <q>` must reach the engine as the deep preset — the
    // point of the prefix is a bigger budget than the configured default.
    mockBuild.mockReturnValue(okDeps())
    const res = await handleResearchSlash(ctx(), "deep what is x?")
    expect(res.handled).toBe(true)
    expect(res.message).toContain("Cited answer")
  })

  it("reports a failure when the loop throws", async () => {
    const throwingAi: AiBridge = {
      chat: async function* () {
        throw new Error("model exploded")
      },
      embed: async () => [],
    }
    mockBuild.mockReturnValue({ ai: throwingAi, search: async () => [], read: async () => "" })
    const res = await handleResearchSlash(ctx({ maxSteps: 2 }), "q")
    expect(res.message).toMatch(/model exploded/)
  })
})

describe("parseResearchArgs", () => {
  it("parses a bare question as a standard-depth search", () => {
    expect(parseResearchArgs("what is x?")).toEqual({ topic: "what is x?", mode: "search" })
  })

  it("parses report mode and depth prefixes in either order", () => {
    expect(parseResearchArgs("report climate")).toEqual({ topic: "climate", mode: "report" })
    expect(parseResearchArgs("deep report climate")).toEqual({
      topic: "climate",
      mode: "report",
      depth: "deep",
    })
    expect(parseResearchArgs("report deep climate")).toEqual({
      topic: "climate",
      mode: "report",
      depth: "deep",
    })
    expect(parseResearchArgs("quick how do antacids work")).toEqual({
      topic: "how do antacids work",
      mode: "search",
      depth: "quick",
    })
  })

  it("returns null for a keyword without a topic", () => {
    expect(parseResearchArgs("")).toBeNull()
    expect(parseResearchArgs("   ")).toBeNull()
  })
})

it("does not persist or open a cancelled report", async () => {
  const controller = new AbortController()
  controller.abort()
  mockBuild.mockImplementation((_ctx, options) => ({ ...okDeps(), ...options }))
  const context = ctx()
  const result = await handleResearchSlash(context, "report topic", { signal: controller.signal })
  expect(result.handled).toBe(true)
  expect(context.artifact.createArtifact).not.toHaveBeenCalled()
  expect(context.artifact.openArtifact).not.toHaveBeenCalled()
})

it("keeps the report response when opening its artifact fails", async () => {
  mockBuild.mockReturnValue(okDeps())
  const context = ctx()
  jest.mocked(context.artifact.openArtifact).mockImplementation(() => {
    throw new Error("panel unavailable")
  })
  const result = await handleResearchSlash(context, "report topic")
  expect(result.payload).toMatchObject({ artifactId: "art-7" })
  expect(context.logger.warn).toHaveBeenCalled()
})

it("renders non-Error failures", async () => {
  mockBuild.mockReturnValue({
    ...okDeps(),
    ai: {
      chat: async function* () {
        throw "model unavailable"
      },
      embed: async () => [],
    },
  })
  const result = await handleResearchSlash(ctx(), "question")
  expect(result.message).toContain("model unavailable")
})

it("does not open an artifact if cancelled while saving it", async () => {
  const controller = new AbortController()
  mockBuild.mockReturnValue(okDeps())
  const context = ctx()
  jest.mocked(context.artifact.createArtifact).mockImplementation(async () => {
    controller.abort()
    return "saved"
  })
  await handleResearchSlash(context, "report topic", { signal: controller.signal })
  expect(context.artifact.createArtifact).toHaveBeenCalled()
  expect(context.artifact.openArtifact).not.toHaveBeenCalled()
})
