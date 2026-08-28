import type { AiBridge } from "../lib/ai"
import { DEFAULT_CONFIG, type EngineDeps, type SearchHit } from "../types"
import { dedupeCitations, mapLimit, normalizeOutline, runDeepResearch } from "./deepresearch"

function orthonormal(i: number): number[] {
  const v = new Array(16).fill(0)
  v[i % 16] = 1
  return v
}

/** Generic scripted ai: outline → per-section search/read/answer → coherence. */
function scriptedAi(outlineJson: string): AiBridge {
  return {
    chat: async function* (messages) {
      const sys = messages[0]?.content ?? ""
      const user = messages[1]?.content ?? ""
      let text = ""
      if (sys.includes("research lead planning a report")) text = outlineJson
      else if (sys.includes("senior analyst assembling"))
        text = "# Final Report\n\nMerged prose [1]."
      else if (sys.includes("controller of an iterative")) {
        const read = Number(/(\d+) sources read/.exec(user)?.[1] ?? "0")
        const unread = Number(/UNREAD SOURCES \((\d+)\)/.exec(user)?.[1] ?? "0")
        if (unread > 0) text = '{"action":"read"}'
        else if (read === 0) text = '{"action":"search","queries":["q"]}'
        else text = '{"action":"answer"}'
      } else if (sys.includes("research analyst")) text = "Section answer [1]."
      else if (sys.includes("answer evaluator")) text = '{"pass":true,"reasons":[]}'
      yield { content: text, usage: { totalTokens: 3 } }
    },
    embed: async (t) => t.map((_, i) => orthonormal(i)),
  }
}

function deps(outlineJson: string, reportProgress?: EngineDeps["reportProgress"]): EngineDeps {
  let n = 0
  const search = async (): Promise<SearchHit[]> => [
    { url: `https://s${n++}.com`, title: `Src ${n}`, content: "snippet", score: 1 },
  ]
  return {
    ai: scriptedAi(outlineJson),
    search,
    read: async (url) => `content for ${url}`,
    logger: { info: () => {}, warn: () => {} },
    reportProgress,
  }
}

describe("normalizeOutline", () => {
  it("keeps valid sections and trims", () => {
    const o = normalizeOutline("topic", {
      title: " My Title ",
      sections: [{ heading: " H ", question: " Q " }, { question: "Q2" }, { heading: "x" }],
    })
    expect(o.title).toBe("My Title")
    expect(o.sections).toEqual([
      { heading: "H", question: "Q" },
      { heading: "Q2", question: "Q2" },
    ])
  })
  it("falls back to a single section when none are valid", () => {
    expect(normalizeOutline("topic", { sections: [] })).toEqual({
      title: "topic",
      sections: [{ heading: "topic", question: "topic" }],
    })
  })
})

describe("dedupeCitations", () => {
  it("removes repeated urls keeping order", () => {
    expect(
      dedupeCitations([
        { url: "https://a.com", title: "A" },
        { url: "https://a.com", title: "A2" },
        { url: "https://b.com", title: "B" },
      ])
    ).toEqual([
      { url: "https://a.com", title: "A" },
      { url: "https://b.com", title: "B" },
    ])
  })
})

describe("mapLimit", () => {
  it("preserves order and respects the concurrency cap", async () => {
    let inFlight = 0
    let maxInFlight = 0
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      inFlight--
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50])
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })
})

describe("runDeepResearch", () => {
  it("scouts, outlines, runs sections and weaves a cited report", async () => {
    const progress: number[] = []
    const outline = JSON.stringify({
      title: "The Report",
      sections: [
        { heading: "Background", question: "what is the background?" },
        { heading: "Outlook", question: "what is the outlook?" },
      ],
    })
    const result = await runDeepResearch(
      "a big topic",
      deps(outline, (p) => progress.push(p))
    )

    expect(result.title).toBe("The Report")
    expect(result.outline.sections).toHaveLength(2)
    expect(result.sections.map((s) => s.heading)).toEqual(["Background", "Outlook"])
    expect(result.report).toContain("Merged prose")
    expect(result.report).toContain("## Sources")
    expect(result.citations.length).toBeGreaterThanOrEqual(2)
    expect(result.usage.totalTokens).toBeGreaterThan(0)
    expect(progress.at(-1)).toBe(1)
  })

  it("falls back to a single-section report when the outline can't be parsed", async () => {
    const result = await runDeepResearch("topic", deps("not json at all"))
    expect(result.outline.sections).toHaveLength(1)
    expect(result.report).toContain("Sources")
  })

  it("survives a failing search provider (scout + sections)", async () => {
    const d = deps(JSON.stringify({ title: "T", sections: [{ heading: "H", question: "q?" }] }))
    d.search = async () => {
      throw new Error("search down")
    }
    const result = await runDeepResearch("topic", d)
    expect(result.report.length).toBeGreaterThan(0)
    expect(result.sections[0].gaveUp).toBe(true)
  })

  it("concatenates sections when the coherence pass fails", async () => {
    const outline = JSON.stringify({ title: "T", sections: [{ heading: "H1", question: "q1?" }] })
    const d = deps(outline)
    const baseChat = d.ai.chat
    d.ai = {
      ...d.ai,
      chat: (messages, opts) => {
        if ((messages[0]?.content ?? "").includes("senior analyst assembling")) {
          throw new Error("coherence down")
        }
        return baseChat(messages, opts)
      },
    }
    const result = await runDeepResearch("topic", d)
    expect(result.report).toContain("## H1")
  })

  it("leaves DEFAULT_CONFIG's search width intact for sections", async () => {
    // `runDeepSearch` merges `{ ...DEFAULT_CONFIG, ...override }`, so a
    // present-but-undefined `searchResultsPerQuery` CLOBBERED the default and
    // every section search asked for `undefined` results. `SearchFn` declares
    // `limit` as a required number, so nothing in the type system caught it.
    const outline = JSON.stringify({ title: "T", sections: [{ heading: "H", question: "q?" }] })
    const d = deps(outline)
    const widths: unknown[] = []
    const base = d.search
    d.search = async (query, limit) => {
      widths.push(limit)
      return base(query, limit)
    }

    await runDeepResearch("topic", d)

    expect(widths.length).toBeGreaterThan(1)
    expect(widths).not.toContain(undefined)
    // 8 is the scout's own constant; 6 is the per-section default under test.
    expect(widths).toContain(DEFAULT_CONFIG.searchResultsPerQuery)
  })

  it("still honours a caller-supplied search width", async () => {
    const outline = JSON.stringify({ title: "T", sections: [{ heading: "H", question: "q?" }] })
    const d = deps(outline)
    const widths: unknown[] = []
    const base = d.search
    d.search = async (query, limit) => {
      widths.push(limit)
      return base(query, limit)
    }

    await runDeepResearch("topic", d, { searchResultsPerQuery: 2 })

    expect(widths).toContain(2)
    expect(widths).not.toContain(DEFAULT_CONFIG.searchResultsPerQuery)
  })
})
