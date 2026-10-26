import { segmentRules } from "./segment"
import { contentWords, findOverlaps, OVERLAP_MAX_PAIRS } from "./overlap"

describe("contentWords", () => {
  it("drops stop words, stems lightly and keeps code spans", () => {
    const words = contentWords("Always run the `pnpm typecheck` script before committing changes")
    expect(words.has("pnpm")).toBe(true)
    expect(words.has("typecheck")).toBe(true)
    expect(words.has("committ")).toBe(true)
    expect(words.has("the")).toBe(false)
  })

  it("uses bigrams for CJK text", () => {
    const words = contentWords("提交前运行测试")
    expect(words.has("提交")).toBe(true)
    expect(words.has("测试")).toBe(true)
  })
})

describe("findOverlaps", () => {
  it("pairs rules from different surfaces that rule on the same point", () => {
    const a = {
      surfaceKey: "a",
      units: segmentRules("- Run pnpm typecheck before committing any change"),
    }
    const b = {
      surfaceKey: "b",
      units: segmentRules("- Never run pnpm typecheck before committing a change"),
    }
    const c = { surfaceKey: "c", units: segmentRules("- Write commit messages in English") }
    const pairs = findOverlaps([a, b, c])
    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.a.surfaceKey).toBe("a")
    expect(pairs[0]!.b.surfaceKey).toBe("b")
    expect(pairs[0]!.shared).toEqual(expect.arrayContaining(["pnpm", "typecheck"]))
  })

  it("never pairs rules within one surface and caps the list", () => {
    const same = {
      surfaceKey: "a",
      units: segmentRules("- run pnpm typecheck now\n- run pnpm typecheck now"),
    }
    expect(findOverlaps([same])).toEqual([])
    const many = Array.from({ length: 12 }, (_, i) => ({
      surfaceKey: `s${i}`,
      units: segmentRules("- run pnpm typecheck before commit"),
    }))
    expect(findOverlaps(many)).toHaveLength(OVERLAP_MAX_PAIRS)
  })
})
