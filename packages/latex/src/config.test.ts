import {
  KATEX_MACROS,
  KATEX_ERROR_COLOR,
  KATEX_BASE_OPTIONS,
  KATEX_UNTRUSTED_OPTIONS,
  getKatexOptions,
  MATH_CACHE_MAX_SIZE,
  MATH_CACHE_MAX_AGE,
} from "./config"

describe("KATEX_MACROS", () => {
  it("includes the expected math shortcuts", () => {
    expect(KATEX_MACROS["\\R"]).toBe("\\mathbb{R}")
    expect(KATEX_MACROS["\\softmax"]).toBe("\\operatorname{softmax}")
    expect(KATEX_MACROS["\\set"]).toContain("#1")
  })
})

describe("KATEX_BASE_OPTIONS / KATEX_UNTRUSTED_OPTIONS", () => {
  it("base options enable trust and use macros", () => {
    expect(KATEX_BASE_OPTIONS.trust).toBe(true)
    expect(KATEX_BASE_OPTIONS.errorColor).toBe(KATEX_ERROR_COLOR)
    expect(KATEX_BASE_OPTIONS.macros).toBe(KATEX_MACROS)
  })

  it("untrusted options invert trust", () => {
    expect(KATEX_UNTRUSTED_OPTIONS.trust).toBe(false)
  })
})

describe("getKatexOptions", () => {
  it("inherits base options and sets displayMode", () => {
    const opts = getKatexOptions(true)
    expect(opts.displayMode).toBe(true)
    expect(opts.macros).toBe(KATEX_MACROS)
    // Trust defaults to base value (true)
    expect(opts.trust).toBe(true)
  })

  it("honors an explicit trust override", () => {
    const opts = getKatexOptions(false, { trust: false })
    expect(opts.trust).toBe(false)
    expect(opts.displayMode).toBe(false)
  })

  it("falls back to false when KATEX_BASE_OPTIONS.trust is undefined", () => {
    const original = KATEX_BASE_OPTIONS.trust
    ;(KATEX_BASE_OPTIONS as { trust?: unknown }).trust = undefined
    try {
      const opts = getKatexOptions(true)
      expect(opts.trust).toBe(false)
    } finally {
      ;(KATEX_BASE_OPTIONS as { trust?: unknown }).trust = original
    }
  })

  it("honors explicit trust=true override", () => {
    const opts = getKatexOptions(false, { trust: true })
    expect(opts.trust).toBe(true)
  })
})

describe("cache limits", () => {
  it("exposes the configured limits", () => {
    expect(MATH_CACHE_MAX_SIZE).toBeGreaterThan(0)
    expect(MATH_CACHE_MAX_AGE).toBeGreaterThan(0)
  })
})
