import type { PluginContext } from "@cognia/plugin-sdk"
import type { AiBridge } from "./lib/ai"
import type { EngineDeps, SearchHit } from "./types"

jest.mock("./runtime", () => ({ buildEngineDeps: jest.fn() }))
import { buildEngineDeps } from "./runtime"
import { ResearchToolError } from "./errors"
import { handleResearchSlash } from "./slash"

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

function ctx(config: Record<string, unknown> = {}): PluginContext {
  return {
    pluginId: "cognia-deep-research",
    configuration: { getAll: () => config },
  } as unknown as PluginContext
}

beforeEach(() => {
  mockBuild.mockReset()
})

describe("handleResearchSlash", () => {
  it("returns usage for an empty query", async () => {
    const res = await handleResearchSlash(ctx(), "  ")
    expect(res.message).toMatch(/Usage/)
    expect(mockBuild).not.toHaveBeenCalled()
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
