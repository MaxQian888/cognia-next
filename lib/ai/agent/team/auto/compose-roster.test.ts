import { composeRoster, heuristicRoster, DEFAULT_MAX_ROSTER } from "./compose-roster"
import type { CapabilityCatalog } from "./types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { TeamRoutingAssessment } from "@/types/agent/agent-team"

const assessment: TeamRoutingAssessment = {
  recommendedPattern: "parallel_specialists",
  confidence: 0.7,
  reason: "x",
  factors: {
    taskComplexity: "moderate",
    specializationNeeded: true,
    contextIsolationNeeded: false,
    delegationCandidate: false,
    budgetPressure: "low",
  },
  createdAt: new Date("2026-06-14T00:00:00Z"),
}

const catalog: CapabilityCatalog = {
  skillIds: ["web-research", "ocr-extraction"],
  mcpServerIds: [],
  nativeAnthropicToolIds: [],
  characterPackIds: [],
  externalAgentPresetIds: ["claude-code"],
  subagentIds: ["workflow-designer"],
}

const client = (text: string): LlmClient => ({ complete: async () => text })
const base = { assessment, catalog, objective: "review the codebase" }

describe("composeRoster (model path)", () => {
  it("normalizes a valid roster and forces exactly one lead", async () => {
    const roster = await composeRoster({
      ...base,
      client: client(
        JSON.stringify({
          teammates: [
            { name: "Sec", role: "teammate", specialization: "security", description: "sec" },
            { name: "Perf", role: "lead", specialization: "performance", description: "perf" },
          ],
        })
      ),
    })
    expect(roster).toHaveLength(2)
    expect(roster[0].role).toBe("lead")
    expect(roster[0].name).toBe("Sec")
    expect(roster[1].role).toBe("teammate")
    expect(roster[1].specialization).toBe("performance")
  })

  it("keeps only catalog-valid capability ids (drops hallucinated ones)", async () => {
    const roster = await composeRoster({
      ...base,
      client: client(
        JSON.stringify({
          teammates: [
            {
              name: "Researcher",
              description: "r",
              capabilities: {
                skillIds: ["web-research", "totally-made-up"],
                subagentIds: ["workflow-designer"],
                mcpServerIds: ["nope"],
              },
            },
            { name: "Helper", description: "h" },
          ],
        })
      ),
    })
    expect(roster[0].capabilities?.skillIds?.add).toEqual(["web-research"])
    expect(roster[0].capabilities?.subagentIds?.add).toEqual(["workflow-designer"])
    expect(roster[0].capabilities?.mcpServerIds).toBeUndefined()
  })

  it("dedupes capability ids", async () => {
    const roster = await composeRoster({
      ...base,
      client: client(
        JSON.stringify({
          teammates: [
            {
              name: "A",
              description: "a",
              capabilities: { skillIds: ["web-research", "web-research"] },
            },
            { name: "B", description: "b" },
          ],
        })
      ),
    })
    expect(roster[0].capabilities?.skillIds?.add).toEqual(["web-research"])
  })

  it("pads a single-member roster up to the minimum of 2", async () => {
    const roster = await composeRoster({
      ...base,
      client: client(JSON.stringify({ teammates: [{ name: "Solo", description: "s" }] })),
    })
    expect(roster.length).toBeGreaterThanOrEqual(2)
    expect(roster[0].role).toBe("lead")
  })

  it("caps the roster at maxRoster", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `T${i}`, description: "d" }))
    const roster = await composeRoster({
      ...base,
      maxRoster: 3,
      client: client(JSON.stringify({ teammates: many })),
    })
    expect(roster).toHaveLength(3)
  })

  it("skips entries with no name", async () => {
    const roster = await composeRoster({
      ...base,
      client: client(
        JSON.stringify({
          teammates: [{ description: "no name" }, { name: "Real", description: "r" }],
        })
      ),
    })
    expect(roster.every((m) => m.name)).toBe(true)
    expect(roster.some((m) => m.name === "Real")).toBe(true)
  })
})

describe("composeRoster (fail-open)", () => {
  it("returns the heuristic roster when the model throws", async () => {
    const roster = await composeRoster({
      ...base,
      client: {
        complete: async () => {
          throw new Error("boom")
        },
      },
    })
    expect(roster).toEqual(heuristicRoster())
  })

  it("returns the heuristic roster on non-JSON output", async () => {
    const roster = await composeRoster({ ...base, client: client("here you go") })
    expect(roster).toHaveLength(3)
  })

  it("returns the heuristic roster on empty teammates array", async () => {
    const roster = await composeRoster({ ...base, client: client('{"teammates":[]}') })
    expect(roster).toEqual(heuristicRoster())
  })

  it("short-circuits to heuristic when already aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    const spy = jest.fn()
    const roster = await composeRoster({ ...base, client: { complete: spy }, signal: ac.signal })
    expect(spy).not.toHaveBeenCalled()
    expect(roster).toEqual(heuristicRoster())
  })

  it("falls back to heuristic when aborted mid-call", async () => {
    const ac = new AbortController()
    const roster = await composeRoster({
      ...base,
      signal: ac.signal,
      client: {
        complete: async () => {
          ac.abort()
          return JSON.stringify({ teammates: [{ name: "A", description: "a" }] })
        },
      },
    })
    expect(roster).toEqual(heuristicRoster())
  })

  it("ignores a non-object capabilities field", async () => {
    const roster = await composeRoster({
      ...base,
      client: client(
        JSON.stringify({
          teammates: [
            { name: "A", description: "a", capabilities: "not-an-object" },
            { name: "B", description: "b" },
          ],
        })
      ),
    })
    expect(roster[0].capabilities).toBeUndefined()
  })

  it("skips non-object roster entries", async () => {
    const roster = await composeRoster({
      ...base,
      client: client(
        JSON.stringify({ teammates: [null, "x", { name: "Real", description: "r" }] })
      ),
    })
    expect(roster.some((m) => m.name === "Real")).toBe(true)
  })
})

describe("heuristicRoster", () => {
  it("is a lead plus two generalists", () => {
    const r = heuristicRoster()
    expect(r).toHaveLength(3)
    expect(r[0].role).toBe("lead")
    expect(r.filter((m) => m.role === "lead")).toHaveLength(1)
  })
})

describe("DEFAULT_MAX_ROSTER", () => {
  it("is a sane default", () => {
    expect(DEFAULT_MAX_ROSTER).toBe(6)
  })
})
