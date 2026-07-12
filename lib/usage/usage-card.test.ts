import { buildUsageCardHtml, collectUsageCardStats, renderUsageCardFragment } from "./usage-card"
import { THEMES } from "@/lib/export/html/syntax-themes"
import type { SessionUsageRow } from "@/lib/db/session-usage"

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 10, 12, 0, 0)

function row(overrides: Partial<SessionUsageRow>): SessionUsageRow {
  return {
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    sessionId: "s1",
    at: T0,
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0.01,
    durationMs: 1000,
    ...overrides,
  }
}

describe("collectUsageCardStats", () => {
  it("returns zeroed stats for no rows", () => {
    const s = collectUsageCardStats([])
    expect(s).toEqual({
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      durationMs: 0,
      turns: 0,
      sessions: 0,
      activeDays: 0,
      topModel: null,
      from: null,
      to: null,
    })
  })

  it("aggregates tokens, cost, sessions, active days and range", () => {
    const rows = [
      row({ messageId: "a", at: T0, model: "haiku" }),
      row({ messageId: "b", at: T0 + 1000, sessionId: "s2", cacheReadTokens: 200, model: "opus" }),
      row({ messageId: "c", at: T0 + 2 * DAY, sessionId: "s2", model: "opus" }),
    ]
    const s = collectUsageCardStats(rows)
    expect(s.turns).toBe(3)
    expect(s.sessions).toBe(2)
    expect(s.activeDays).toBe(2)
    expect(s.inputTokens).toBe(300)
    expect(s.outputTokens).toBe(150)
    expect(s.cacheReadTokens).toBe(200)
    expect(s.totalTokens).toBe(650)
    expect(s.costUsd).toBeCloseTo(0.03)
    expect(s.durationMs).toBe(3000)
    expect(s.from).toBe(T0)
    expect(s.to).toBe(T0 + 2 * DAY)
  })

  it("picks the model with the highest token volume as topModel", () => {
    const rows = [
      row({ messageId: "a", model: "haiku", inputTokens: 10, outputTokens: 10 }),
      row({ messageId: "b", model: "opus", inputTokens: 5000, outputTokens: 100 }),
      row({ messageId: "c", model: "haiku", inputTokens: 10, outputTokens: 10 }),
    ]
    expect(collectUsageCardStats(rows).topModel).toBe("opus")
  })
})

describe("renderUsageCardFragment", () => {
  const stats = collectUsageCardStats([
    row({ messageId: "a", model: "opus", inputTokens: 1_200_000, outputTokens: 300_000 }),
  ])

  it("defaults to the arknights style with flavor labels", () => {
    const frag = renderUsageCardFragment({ stats, generatedAt: new Date(T0) })
    expect(frag).toContain('data-theme="arknights"')
    expect(frag).toContain("ORIGINIUM COMPUTE")
    expect(frag).toContain("SUPPLY COST")
    expect(frag).toContain("PRIMARY OPERATOR")
    expect(frag).toContain("TACTICAL COMMUNICATION LOG")
    expect(frag).toContain(THEMES.arknights.accent)
    expect(frag).toContain("1.5M")
  })

  it("uses generic labels for non-arknights styles", () => {
    const frag = renderUsageCardFragment({ stats, theme: "light", generatedAt: new Date(T0) })
    expect(frag).toContain("TOTAL TOKENS")
    expect(frag).not.toContain("ORIGINIUM")
    expect(frag).not.toContain("preset")
  })

  it("applies preset chrome for each styled theme", () => {
    for (const theme of ["cyberpunk", "terminal", "sakura"] as const) {
      const frag = renderUsageCardFragment({ stats, theme, generatedAt: new Date(T0) })
      expect(frag).toContain(`data-theme="${theme}"`)
      expect(frag).toContain(THEMES[theme].bg)
    }
  })

  it("escapes owner name, range label and title", () => {
    const frag = renderUsageCardFragment({
      stats,
      title: "<b>Title</b>",
      ownerName: "<script>",
      rangeLabel: "7 <days>",
      generatedAt: new Date(T0),
    })
    expect(frag).toContain("&lt;b&gt;Title&lt;/b&gt;")
    expect(frag).toContain("@&lt;script&gt;")
    expect(frag).toContain("7 &lt;days&gt;")
    expect(frag).not.toContain("<script>")
  })

  it("omits owner, range and top-model blocks when absent", () => {
    const empty = collectUsageCardStats([])
    const frag = renderUsageCardFragment({ stats: empty, generatedAt: new Date(T0) })
    expect(frag).not.toContain('class="ucard-owner"')
    expect(frag).not.toContain('class="ucard-range"')
    expect(frag).not.toContain('class="ucard-model"')
  })

  it("honors an inline custom theme", () => {
    const frag = renderUsageCardFragment({
      stats,
      theme: "arknights",
      customTheme: { ...THEMES.arknights, bg: "#654321" },
      generatedAt: new Date(T0),
    })
    expect(frag).toContain("#654321")
  })
})

describe("buildUsageCardHtml", () => {
  it("wraps the fragment in a self-contained document", () => {
    const stats = collectUsageCardStats([row({ messageId: "a" })])
    const html = buildUsageCardHtml({ stats, generatedAt: new Date(T0), title: "My Card" })
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true)
    expect(html).toContain("<title>My Card</title>")
    expect(html).toContain('class="ucard"')
    expect(html).toContain(THEMES.arknights.bg)
  })
})
