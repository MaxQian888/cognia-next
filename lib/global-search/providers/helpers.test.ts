import { excerptAround, highlightPositions, matchTitles, toProviderResult } from "./helpers"

const NOW = 1_800_000_000_000

describe("matchTitles", () => {
  const rows = [
    { name: "Deploy pipeline", desc: "ci", at: NOW - 1 },
    { name: "Notes", desc: "deploy checklist", at: NOW },
    { name: "Unrelated", desc: "", at: NOW },
    { name: "Redeploy", desc: "", at: NOW - 100 },
  ]

  it("keeps hits sorted by score with total and truncation", () => {
    const out = matchTitles(rows, "deploy", {
      getTitle: (r) => r.name,
      getSecondary: (r) => r.desc,
      getTimestamp: (r) => r.at,
      now: NOW,
      limit: 2,
    })
    expect(out.hits.map((h) => h.row.name)).toEqual(["Deploy pipeline", "Redeploy"])
    expect(out.total).toBe(3)
    expect(out.truncated).toBe(true)
    expect(out.hits[0]!.match.positions).toEqual([0, 1, 2, 3, 4, 5])
  })

  it("matches keywords and returns everything for an empty needle", () => {
    const out = matchTitles(rows, "zzz", {
      getTitle: (r) => r.name,
      getKeywords: (r) => (r.name === "Notes" ? ["zzz-tag"] : undefined),
      now: NOW,
      limit: 10,
    })
    expect(out.hits.map((h) => h.row.name)).toEqual(["Notes"])
    const all = matchTitles(rows, "", { getTitle: (r) => r.name, now: NOW, limit: 10 })
    expect(all.total).toBe(4)
    expect(all.truncated).toBe(false)
  })
})

describe("helpers", () => {
  it("toProviderResult wraps the slice", () => {
    const item = {
      id: "a",
      kind: "skill" as const,
      title: "A",
      score: 1,
      action: { type: "navigate" as const, href: "/" },
    }
    expect(toProviderResult([item], 3, true)).toEqual({ items: [item], total: 3, truncated: true })
  })

  it("highlightPositions finds the first case-insensitive hit", () => {
    expect(highlightPositions("Deploy Notes", "not")).toEqual([7, 8, 9])
    expect(highlightPositions("Deploy", "zzz")).toEqual([])
    expect(highlightPositions(undefined, "a")).toEqual([])
    expect(highlightPositions("abc", "")).toEqual([])
  })

  it("excerptAround collapses whitespace and windows around the needle", () => {
    expect(excerptAround("  short   text ", "x")).toBe("short text")
    const long = `${"a".repeat(100)} needle ${"b".repeat(100)}`
    const around = excerptAround(long, "needle", 40)
    expect(around).toContain("needle")
    expect(around.startsWith("…")).toBe(true)
    expect(around.endsWith("…")).toBe(true)
    expect(around.length).toBeLessThanOrEqual(42)
    const head = excerptAround(long, "zzz", 20)
    expect(head).toBe(`${"a".repeat(19)}…`)
    const noNeedle = excerptAround(long, "", 20)
    expect(noNeedle.endsWith("…")).toBe(true)
    // Needle near the start: no leading ellipsis.
    const early = excerptAround(`needle ${"c".repeat(200)}`, "needle", 30)
    expect(early.startsWith("needle")).toBe(true)
  })
})
