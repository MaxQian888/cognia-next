import type { ImportedConversation } from "@/lib/session-import"
import type { SessionUsageRow } from "@/lib/db/session-usage"

import {
  buildAgentStats,
  buildConvDetail,
  sourceOfSessionId,
  type ConvWithUsage,
} from "./agent-stats-model"

const day = (d: string): number => Date.parse(`${d}T00:00:00Z`)

const row = (over: Partial<SessionUsageRow>): SessionUsageRow => ({
  messageId: "m",
  sessionId: "s",
  at: 1000,
  model: "opus",
  inputTokens: 100,
  outputTokens: 50,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0.01,
  durationMs: 0,
  ...over,
})

function conv(
  source: string,
  id: string,
  msgs: { role: string; parts?: unknown[] }[],
  meta: { createdAt: number; updatedAt: number; title?: string }
): ConvWithUsage {
  const sessionId = `import:${source}:${id}`
  return {
    source,
    conv: {
      session: {
        id: sessionId,
        title: meta.title ?? id,
        kind: "direct",
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      },
      messages: msgs.map((m, i) => ({
        id: `${sessionId}:m${i}`,
        sessionId,
        role: m.role,
        parts: m.parts ?? [],
        createdAt: meta.createdAt + i,
      })),
    } as unknown as ImportedConversation,
    usageRows: [],
  }
}

describe("sourceOfSessionId", () => {
  it("extracts the source, tolerating colons in the original id", () => {
    expect(sourceOfSessionId("import:claude-code:C:\\x")).toBe("claude-code")
    expect(sourceOfSessionId("import:codex:abc")).toBe("codex")
    expect(sourceOfSessionId("weird")).toBe("unknown")
  })
})

describe("buildAgentStats", () => {
  it("aggregates conversations, sources, tools, days, and usage", () => {
    const c1 = conv(
      "claude-code",
      "a",
      [
        { role: "user", parts: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          parts: [
            { type: "tool-Bash", input: {} },
            { type: "tool-Bash", input: {} },
          ],
        },
      ],
      { createdAt: day("2025-01-01"), updatedAt: day("2025-01-01") + 5, title: "First" }
    )
    c1.usageRows = [
      row({
        messageId: "u1",
        sessionId: c1.conv.session.id,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.02,
      }),
    ]
    const c2 = conv(
      "codex",
      "b",
      [{ role: "assistant", parts: [{ type: "tool-Edit", input: {} }] }],
      { createdAt: day("2025-01-02"), updatedAt: day("2025-01-02"), title: "Second" }
    )
    c2.usageRows = [
      row({
        messageId: "u2",
        sessionId: c2.conv.session.id,
        inputTokens: 200,
        outputTokens: 20,
        costUsd: 0.03,
      }),
    ]

    const { overview, rows } = buildAgentStats([c1, c2], { notes: ["note"] })
    expect(overview.conversations).toBe(2)
    expect(overview.messages).toBe(3)
    expect(overview.toolCalls).toBe(3)
    expect(overview.bySource.map((s) => s.source).sort()).toEqual(["claude-code", "codex"])
    expect(overview.topTools[0]).toMatchObject({ name: "Bash", count: 2 })
    expect(overview.notes).toEqual(["note"])
    // tokens = sum(input + output + cacheRead)
    expect(overview.tokens).toBe(370)
    expect(overview.costUsd).toBeCloseTo(0.05, 5)
    expect(overview.convsPerDay).toHaveLength(2)
    // rows sorted newest-first → the later "Second" leads.
    expect(rows[0].title).toBe("Second")
    expect(rows[0].toolCalls).toBe(1)
    expect(rows[1].toolCalls).toBe(2)
  })

  it("handles empty input", () => {
    const { overview, rows } = buildAgentStats([])
    expect(overview.conversations).toBe(0)
    expect(overview.tokens).toBe(0)
    expect(rows).toEqual([])
    expect(overview.notes).toEqual([])
  })

  it("folds two conversations from the same source and defaults a missing title", () => {
    const a = conv("codex", "a", [{ role: "assistant", parts: [] }], {
      createdAt: 10,
      updatedAt: 10,
    })
    // Force a missing title so the "(untitled)" fallback is exercised.
    ;(a.conv.session as { title?: string }).title = undefined
    const b = conv("codex", "b", [{ role: "user", parts: [] }], { createdAt: 20, updatedAt: 20 })
    const { overview, rows } = buildAgentStats([a, b])
    expect(overview.bySource).toHaveLength(1)
    expect(overview.bySource[0].conversations).toBe(2)
    expect(rows.some((r) => r.title === "(untitled)")).toBe(true)
  })
})

describe("buildConvDetail", () => {
  it("produces a SessionReport for one conversation", () => {
    const c = conv(
      "claude-code",
      "a",
      [
        { role: "user", parts: [{ type: "text", text: "hi" }] },
        { role: "assistant", parts: [{ type: "tool-Bash", input: { command: "ls" } }] },
      ],
      { createdAt: 1000, updatedAt: 2000 }
    )
    c.usageRows = [row({ messageId: "r1", at: 1000 }), row({ messageId: "r2", at: 2000 })]
    const report = buildConvDetail(c)
    expect(report.turns).toBe(2)
    expect(report.toolCounts.Bash).toBe(1)
    expect(report.assessments).toHaveLength(7)
  })
})
