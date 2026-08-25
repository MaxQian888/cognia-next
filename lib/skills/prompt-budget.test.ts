import {
  DEFAULT_SKILL_CATALOG_TOKEN_BUDGET,
  SHORTENED_DESCRIPTION_CHARS,
  budgetCatalogEntries,
  budgetSkillBodies,
  didDegrade,
  type BodyEntry,
  type CatalogEntry,
} from "./prompt-budget"

const entry = (id: string, description?: string): CatalogEntry => ({
  id,
  head: `- \`${id}\` — Skill ${id}`,
  ...(description ? { description } : {}),
})

const body = (id: string, chars: number): BodyEntry => ({
  id,
  text: `## Skill ${id}\n\n${"x".repeat(chars)}`,
})

describe("budgetCatalogEntries", () => {
  it("renders everything and reports under-budget when no budget is set", () => {
    const out = budgetCatalogEntries([entry("a", "does a thing"), entry("b")])
    expect(out.level).toBe("under-budget")
    expect(out.omitted).toEqual([])
    expect(out.kept).toEqual(["- `a` — Skill a: does a thing", "- `b` — Skill b"])
    expect(didDegrade(out)).toBe(false)
  })

  it("treats a zero or negative budget as no budget rather than as empty", () => {
    for (const maxTokens of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = budgetCatalogEntries([entry("a", "d")], { maxTokens })
      expect(out.level).toBe("under-budget")
      expect(out.kept).toHaveLength(1)
    }
  })

  it("shortens descriptions before dropping them", () => {
    const long = "d".repeat(400)
    const entries = [entry("a", long), entry("b", long)]
    const unbounded = budgetCatalogEntries(entries)
    const out = budgetCatalogEntries(entries, { maxTokens: Math.floor(unbounded.tokens / 2) })
    expect(out.level).toBe("shortened-descriptions")
    expect(out.omitted).toEqual([])
    expect(out.kept[0]).toContain("…")
    expect(out.kept[0]!.length).toBeLessThan(`- \`a\` — Skill a: ${long}`.length)
    expect(out.kept[0]).toContain("d".repeat(SHORTENED_DESCRIPTION_CHARS))
  })

  it("drops descriptions before omitting any skill", () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry(`s${i}`, "e".repeat(200)))
    const headsOnly = entries.map((e) => e.head).join("\n")
    const out = budgetCatalogEntries(entries, {
      maxTokens: Math.ceil(headsOnly.length / 3),
    })
    expect(out.level).toBe("dropped-descriptions")
    expect(out.omitted).toEqual([])
    expect(out.kept).toHaveLength(20)
    expect(out.kept.every((line) => !line.includes(":"))).toBe(true)
  })

  it("omits from the tail only when even bare names do not fit", () => {
    const entries = Array.from({ length: 40 }, (_, i) => entry(`s${i}`))
    const out = budgetCatalogEntries(entries, { maxTokens: 20 })
    expect(out.level).toBe("omitted-skills")
    expect(out.omitted.length).toBeGreaterThan(0)
    expect(out.kept.length).toBeLessThan(40)
    expect(out.kept.length + out.omitted.length).toBe(40)
    expect(out.tokens).toBeLessThanOrEqual(20)
  })

  it("keeps protected ids when it has to omit", () => {
    const entries = Array.from({ length: 40 }, (_, i) => entry(`s${i}`))
    const out = budgetCatalogEntries(entries, { maxTokens: 20, protectedIds: ["s39"] })
    expect(out.level).toBe("omitted-skills")
    expect(out.omitted).not.toContain("s39")
    expect(out.kept.some((line) => line.includes("`s39`"))).toBe(true)
  })

  it("emits survivors in the caller's order, not protection order", () => {
    const entries = [entry("a"), entry("b"), entry("c")]
    const out = budgetCatalogEntries(entries, { maxTokens: 1_000, protectedIds: ["c"] })
    expect(out.kept).toEqual(["- `a` — Skill a", "- `b` — Skill b", "- `c` — Skill c"])
  })

  it("charges the caller's surrounding prose against the same budget", () => {
    const entries = [entry("a"), entry("b")]
    const withoutOverhead = budgetCatalogEntries(entries, { maxTokens: 1_000 })
    const withOverhead = budgetCatalogEntries(entries, { maxTokens: 1_000 }, 900)
    expect(withOverhead.tokens).toBeGreaterThan(withoutOverhead.tokens)
  })

  it("is empty and under-budget for no entries", () => {
    const out = budgetCatalogEntries([], { maxTokens: 10 })
    expect(out.kept).toEqual([])
    expect(out.level).toBe("under-budget")
  })

  it("ships a documented default ceiling", () => {
    expect(DEFAULT_SKILL_CATALOG_TOKEN_BUDGET).toBe(4_000)
  })
})

describe("budgetSkillBodies", () => {
  it("keeps every body when no budget is set", () => {
    const out = budgetSkillBodies([body("a", 5_000), body("b", 5_000)])
    expect(out.level).toBe("under-budget")
    expect(out.kept).toHaveLength(2)
  })

  it("never truncates a body — it omits whole skills instead", () => {
    const entries = [body("a", 4_000), body("b", 4_000), body("c", 4_000)]
    const out = budgetSkillBodies(entries, { maxTokens: 400 })
    expect(out.level).toBe("omitted-skills")
    expect(out.omitted.length).toBeGreaterThan(0)
    for (const text of out.kept) {
      expect(entries.some((e) => e.text === text)).toBe(true)
    }
  })

  it("has no intermediate level — bodies are whole or gone", () => {
    const entries = [body("a", 40), body("b", 40)]
    expect(budgetSkillBodies(entries, { maxTokens: 10_000 }).level).toBe("under-budget")
    expect(budgetSkillBodies(entries, { maxTokens: 5 }).level).toBe("omitted-skills")
  })

  it("keeps protected bodies over unprotected ones", () => {
    const entries = [body("a", 4_000), body("b", 40)]
    const out = budgetSkillBodies(entries, { maxTokens: 60, protectedIds: ["b"] })
    expect(out.omitted).toContain("a")
    expect(out.kept).toEqual([entries[1]!.text])
  })

  it("can omit everything rather than overflow", () => {
    const out = budgetSkillBodies([body("a", 10_000)], { maxTokens: 1 })
    expect(out.kept).toEqual([])
    expect(out.omitted).toEqual(["a"])
    expect(didDegrade(out)).toBe(true)
  })
})
