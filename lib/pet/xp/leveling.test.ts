import { totalXpForLevel, levelForXp, stageForLevel, levelProgress } from "./leveling"

describe("totalXpForLevel", () => {
  it("follows the quadratic curve", () => {
    expect(totalXpForLevel(1)).toBe(0)
    expect(totalXpForLevel(2)).toBe(100)
    expect(totalXpForLevel(3)).toBe(300)
    expect(totalXpForLevel(4)).toBe(600)
  })
})

describe("levelForXp", () => {
  it("maps xp to the right level", () => {
    expect(levelForXp(0)).toBe(1)
    expect(levelForXp(-5)).toBe(1)
    expect(levelForXp(99)).toBe(1)
    expect(levelForXp(100)).toBe(2)
    expect(levelForXp(299)).toBe(2)
    expect(levelForXp(300)).toBe(3)
  })
})

describe("stageForLevel", () => {
  it("bands levels into stages", () => {
    expect(stageForLevel(1)).toBe("baby")
    expect(stageForLevel(4)).toBe("baby")
    expect(stageForLevel(5)).toBe("juvenile")
    expect(stageForLevel(10)).toBe("adult")
    expect(stageForLevel(20)).toBe("elder")
    expect(stageForLevel(99)).toBe("elder")
  })
})

describe("levelProgress", () => {
  it("reports progress within the current level", () => {
    const p = levelProgress(150) // level 2 (base 100, next 300, span 200)
    expect(p.level).toBe(2)
    expect(p.intoLevel).toBe(50)
    expect(p.span).toBe(200)
    expect(p.fraction).toBeCloseTo(0.25)
  })

  it("is zero progress exactly on a level boundary", () => {
    const p = levelProgress(100)
    expect(p.level).toBe(2)
    expect(p.fraction).toBe(0)
  })
})
