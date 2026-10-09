/**
 * @jest-environment jsdom
 */
import {
  __resetBootFillForTesting,
  clampFillFraction,
  initialBootFill,
  planBootFill,
  readFillFraction,
  rememberBootFill,
} from "./boot-fill"

describe("boot fill memory", () => {
  beforeEach(() => __resetBootFillForTesting())

  it("hands a new sequence an empty bar", () => {
    rememberBootFill(1, 0.9)
    expect(initialBootFill(2)).toBe(0)
  })

  it("hands the same sequence the remembered position", () => {
    rememberBootFill(1, 0.4)
    expect(initialBootFill(1)).toBe(0.4)
  })

  it("only ever raises the position within one sequence", () => {
    rememberBootFill(1, 0.5)
    rememberBootFill(1, 0.3)
    expect(initialBootFill(1)).toBe(0.5)
    rememberBootFill(1, 0.7)
    expect(initialBootFill(1)).toBe(0.7)
  })

  it("replaces the position outright when the sequence changes", () => {
    rememberBootFill(1, 0.9)
    rememberBootFill(2, 0.1)
    expect(initialBootFill(2)).toBe(0.1)
    expect(initialBootFill(1)).toBe(0)
  })

  it("clamps what it stores", () => {
    rememberBootFill(1, 3)
    expect(initialBootFill(1)).toBe(1)
    expect(clampFillFraction(-1)).toBe(0)
    expect(clampFillFraction(Number.NaN)).toBe(0)
  })
})

describe("planBootFill", () => {
  it("snaps to the boundary and creeps to the target", () => {
    expect(planBootFill(0.2, 0.25, 0.46)).toEqual({ snap: 0.25, creep: 0.46 })
  })

  it("holds the bar rather than moving it behind where it visibly is", () => {
    // The visible list widened mid-wait: the new boundary is behind the bar.
    expect(planBootFill(0.6, 0.25, 0.4)).toEqual({ snap: 0.6, creep: 0.6 })
  })

  it("never plans a creep below its snap", () => {
    expect(planBootFill(0, 0.5, 0.3)).toEqual({ snap: 0.5, creep: 0.5 })
  })
})

describe("readFillFraction", () => {
  function fillElement(transform: string, width: number, declared?: string): HTMLElement {
    const el = document.createElement("div")
    if (declared !== undefined) el.style.setProperty("--fill", declared)
    Object.defineProperty(el, "offsetWidth", { configurable: true, value: width })
    jest.spyOn(window, "getComputedStyle").mockReturnValue({
      transform,
    } as unknown as CSSStyleDeclaration)
    return el
  }

  afterEach(() => jest.restoreAllMocks())

  it("reads the animated position from a 2D matrix", () => {
    // 200px wide, translated -150px: a quarter shown.
    expect(readFillFraction(fillElement("matrix(1, 0, 0, 1, -150, 0)", 200), "--fill")).toBe(0.25)
  })

  it("reads the animated position from a 3D matrix", () => {
    const matrix = "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -50, 0, 0, 1)"
    expect(readFillFraction(fillElement(matrix, 200), "--fill")).toBe(0.75)
  })

  it("falls back to the declared value without layout", () => {
    expect(readFillFraction(fillElement("none", 0, "0.4"), "--fill")).toBe(0.4)
    expect(readFillFraction(fillElement("", 0), "--fill")).toBe(0)
  })
})
