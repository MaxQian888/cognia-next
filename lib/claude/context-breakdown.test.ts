import type { UIMessage } from "ai"
import type { SdkContextUsage } from "@cognia/agent-config-types"

import {
  buildEstimateContextBreakdown,
  buildSdkContextBreakdown,
  classifyCategory,
  resolveAutoCompaction,
} from "./context-breakdown"
import { AUTO_COMPACT_FRACTION } from "./usage"

const base: SdkContextUsage = { totalTokens: 0, maxTokens: 100_000, percentage: 0 }

describe("classifyCategory", () => {
  it("maps the SDK's own category names onto stable ids", () => {
    expect(classifyCategory("Messages")).toBe("messages")
    expect(classifyCategory("Memory files")).toBe("memory")
    expect(classifyCategory("System tools")).toBe("systemTools")
    expect(classifyCategory("MCP tools")).toBe("mcp")
    expect(classifyCategory("System prompt")).toBe("systemPrompt")
    expect(classifyCategory("Custom agents")).toBe("agents")
    expect(classifyCategory("Skills")).toBe("skills")
    expect(classifyCategory("Free space")).toBe("free")
  })

  it("ignores a trailing deferred marker", () => {
    expect(classifyCategory("MCP tools (deferred)")).toBe("mcp")
  })

  it("falls back to `other` for a category this build doesn't know", () => {
    expect(classifyCategory("Quantum widgets")).toBe("other")
  })
})

describe("buildSdkContextBreakdown — categories path", () => {
  const usage: SdkContextUsage = {
    ...base,
    totalTokens: 60_000,
    categories: [
      { name: "Messages", tokens: 40_000 },
      { name: "MCP tools", tokens: 15_000 },
      { name: "MCP tools (deferred)", tokens: 5_000, isDeferred: true },
      { name: "Skills", tokens: 0 },
      { name: "Free space", tokens: 40_000 },
    ],
    mcpTools: [
      { name: "wiki_read", serverName: "wiki", tokens: 4_000 },
      { name: "wiki_write", serverName: "wiki", tokens: 11_000 },
    ],
  }

  it("orders occupied groups largest-first and splits out free space", () => {
    const out = buildSdkContextBreakdown(usage)
    expect(out.groups.map((g) => g.key)).toEqual(["messages", "mcp", "mcp:deferred"])
    expect(out.free?.tokens).toBe(40_000)
    expect(out.source).toBe("live")
  })

  it("drops zero-token categories", () => {
    const out = buildSdkContextBreakdown(usage)
    expect(out.groups.find((g) => g.id === "skills")).toBeUndefined()
  })

  it("computes each group's share of the whole window", () => {
    const out = buildSdkContextBreakdown(usage)
    expect(out.groups[0].fraction).toBeCloseTo(0.4)
  })

  it("attaches item detail to the loaded group only, sorted by weight", () => {
    const out = buildSdkContextBreakdown(usage)
    const loaded = out.groups.find((g) => g.key === "mcp")
    expect(loaded?.items.map((i) => i.label)).toEqual(["wiki_write", "wiki_read"])
    expect(loaded?.items[0].hint).toBe("wiki")
    expect(loaded?.itemCount).toBe(2)
    // The deferred twin describes tools that are NOT in the window.
    expect(out.groups.find((g) => g.key === "mcp:deferred")?.items).toEqual([])
  })

  it("keeps an unknown category under its upstream name", () => {
    const out = buildSdkContextBreakdown({
      ...base,
      totalTokens: 10,
      categories: [{ name: "Quantum widgets", tokens: 10 }],
    })
    expect(out.groups[0]).toMatchObject({ id: "other", rawName: "Quantum widgets" })
  })
})

describe("buildSdkContextBreakdown — derived path (no categories)", () => {
  const usage: SdkContextUsage = {
    ...base,
    totalTokens: 30_000,
    systemPromptSections: [{ name: "core", tokens: 2_000 }],
    systemTools: [{ name: "Bash", tokens: 3_000 }],
    memoryFiles: [{ path: "CLAUDE.md", type: "project", tokens: 5_000 }],
    slashCommands: { totalCommands: 12, includedCommands: 12, tokens: 1_000 },
  }

  it("infers the unattributed remainder as conversation messages", () => {
    const out = buildSdkContextBreakdown(usage)
    const messages = out.groups.find((g) => g.id === "messages")
    expect(messages?.tokens).toBe(30_000 - 11_000)
  })

  it("reports a declared count for groups that have no item list", () => {
    const out = buildSdkContextBreakdown(usage)
    const commands = out.groups.find((g) => g.id === "commands")
    expect(commands?.itemCount).toBe(12)
    expect(commands?.items).toEqual([])
  })

  it("derives free space from the window when no category reports it", () => {
    expect(buildSdkContextBreakdown(usage).free?.tokens).toBe(70_000)
  })

  it("omits free space for a full window", () => {
    expect(buildSdkContextBreakdown({ ...base, totalTokens: 100_000 }).free).toBeNull()
  })
})

describe("buildEstimateContextBreakdown", () => {
  const messages = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "x".repeat(400) }] },
    { id: "a1", role: "assistant", parts: [{ type: "reasoning", text: "y".repeat(800) }] },
  ] as unknown as UIMessage[]

  it("labels itself an estimate and scores groups against what it could attribute", () => {
    const out = buildEstimateContextBreakdown(messages, 5_000, 100_000)
    expect(out.source).toBe("estimate")
    expect(out.denominator).toBe("attributed")
    expect(out.usedTokens).toBe(5_000)
    expect(out.groups.length).toBeGreaterThan(0)
    expect(out.groups[0].tokens).toBeGreaterThanOrEqual(out.groups[out.groups.length - 1].tokens)
    // Shares add up to the transcript it measured, not to the window.
    const total = out.groups.reduce((acc, g) => acc + g.fraction, 0)
    expect(total).toBeCloseTo(1, 5)
  })

  it("never invents free space it did not measure", () => {
    // `max - used` is the part of the window the transcript estimate is BLIND
    // to (system prompt, tool schemas, memory) — not headroom.
    expect(buildEstimateContextBreakdown(messages, 5_000, 100_000).free).toBeNull()
  })

  it("returns no groups for an empty transcript", () => {
    const out = buildEstimateContextBreakdown([], 0, 100_000)
    expect(out.groups).toEqual([])
    expect(out.free).toBeNull()
  })
})

describe("buildSdkContextBreakdown — item detail the SDK actually ships", () => {
  it("lists skill frontmatter and the declared skill count", () => {
    const out = buildSdkContextBreakdown({
      ...base,
      totalTokens: 900,
      categories: [{ name: "Skills", tokens: 900 }],
      skills: {
        totalSkills: 7,
        includedSkills: 2,
        tokens: 900,
        skillFrontmatter: [
          { name: "pdf", source: "bundled", tokens: 400 },
          { name: "xlsx", source: "bundled", tokens: 500 },
        ],
      },
    })
    const skills = out.groups.find((g) => g.id === "skills")
    expect(skills?.items.map((i) => i.label)).toEqual(["xlsx", "pdf"])
    expect(skills?.itemCount).toBe(7)
  })

  it("gives the deferred built-in tools row its own inventory, not the loaded one", () => {
    const out = buildSdkContextBreakdown({
      ...base,
      totalTokens: 5_000,
      categories: [
        { name: "System tools", tokens: 3_000 },
        { name: "System tools (deferred)", tokens: 2_000, isDeferred: true },
      ],
      systemTools: [{ name: "Bash", tokens: 3_000 }],
      deferredBuiltinTools: [{ name: "NotebookEdit", tokens: 2_000 }],
    })
    expect(out.groups.find((g) => g.key === "systemTools")?.items.map((i) => i.label)).toEqual([
      "Bash",
    ])
    expect(
      out.groups.find((g) => g.key === "systemTools:deferred")?.items.map((i) => i.label)
    ).toEqual(["NotebookEdit"])
  })
})

// The panel keys React rows AND its expansion set off `key`, so a duplicate
// would expand two rows together and let React reuse the wrong row's DOM.
describe("buildSdkContextBreakdown — row keys", () => {
  it("disambiguates categories that classify onto the same id", () => {
    const out = buildSdkContextBreakdown({
      totalTokens: 6_000,
      maxTokens: 200_000,
      categories: [
        { name: "System tools", tokens: 1_000 },
        { name: "Built-in tools", tokens: 2_000 },
        { name: "Whatever v2", tokens: 1_500 },
        { name: "Something else", tokens: 1_500 },
      ],
    } as never)
    const keys = out.groups.map((g) => g.key)
    expect(new Set(keys).size).toBe(keys.length)
    // The first row of a kind keeps the bare id — existing keys do not move.
    expect(keys).toEqual(expect.arrayContaining(["systemTools", "other"]))
  })
})

describe("resolveAutoCompaction", () => {
  const ctx = { occupancyReported: true, agentOwned: false }

  it("uses the CLI's own threshold when the SDK reports one", () => {
    const p = resolveAutoCompaction({ ...base, autoCompactThreshold: 0.92 }, ctx)
    expect(p).toEqual({ threshold: 0.92, enabled: true, source: "sdk" })
  })

  it("drops the marker when the CLI says auto-compaction is off", () => {
    const p = resolveAutoCompaction({ ...base, isAutoCompactEnabled: false }, ctx)
    expect(p.threshold).toBeNull()
    expect(p.enabled).toBe(false)
  })

  it("normalises an absolute-token threshold against the window", () => {
    const p = resolveAutoCompaction(
      { ...base, maxTokens: 200_000, autoCompactThreshold: 160_000 },
      ctx
    )
    expect(p.threshold).toBeCloseTo(0.8, 5)
  })

  it("never claims our sidecar's policy over an external agent's turn", () => {
    const p = resolveAutoCompaction(null, { occupancyReported: true, agentOwned: true })
    expect(p).toEqual({ threshold: null, enabled: false, source: "agent-owned" })
  })

  it("stays silent when the runtime reported no occupancy at all", () => {
    const p = resolveAutoCompaction(null, { occupancyReported: false, agentOwned: false })
    expect(p.source).toBe("unknown")
    expect(p.threshold).toBeNull()
  })

  it("falls back to the built-in sidecar constant for a built-in turn", () => {
    const p = resolveAutoCompaction(null, ctx)
    expect(p).toEqual({ threshold: AUTO_COMPACT_FRACTION, enabled: true, source: "builtin" })
  })
})
