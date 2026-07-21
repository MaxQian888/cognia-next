import type { PluginContext } from "@/types/plugin"
import type { AiBridge } from "./lib/ai"
import type { EngineDeps, SearchHit } from "./types"

jest.mock("./runtime", () => ({ buildEngineDeps: jest.fn() }))
import { buildEngineDeps } from "./runtime"
import { __resetSlashCommandsForTesting } from "@/lib/slash-commands/registry"
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
  return { pluginId: "cognia-deep-research", config } as unknown as PluginContext
}

beforeEach(() => {
  mockBuild.mockReset()
  __resetSlashCommandsForTesting()
})

describe("handleResearchSlash", () => {
  it("returns usage for an empty query", async () => {
    const res = await handleResearchSlash(ctx(), "  ")
    expect(res.message).toMatch(/Usage/)
    expect(mockBuild).not.toHaveBeenCalled()
  })

  it("returns an error card when deps cannot be built", async () => {
    mockBuild.mockResolvedValue({ ok: false, error: "NO_PROVIDER" })
    const res = await handleResearchSlash(ctx(), "some question")
    expect(res.message).toContain("AI model provider")
  })

  it("returns a cited result card on success", async () => {
    mockBuild.mockResolvedValue({ ok: true, deps: okDeps() })
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
    mockBuild.mockResolvedValue({
      ok: true,
      deps: { ai, search: async () => [hit(`https://s${n++}.com`)], read: async () => "body" },
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
    mockBuild.mockResolvedValue({
      ok: true,
      deps: { ai: throwingAi, search: async () => [], read: async () => "" },
    })
    const res = await handleResearchSlash(ctx({ maxSteps: 2 }), "q")
    expect(res.message).toMatch(/failed: model exploded/)
  })
})
