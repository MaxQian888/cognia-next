import { lintBabel, locate, cleanMessage } from "./lint-babel"

// Delegate to the real parser by default; individual tests override the
// implementation to exercise the fatal-throw branches (errorRecovery normally
// prevents throws, so they're otherwise unreachable).
jest.mock("@babel/parser", () => {
  const actual = jest.requireActual("@babel/parser")
  return { ...actual, parse: jest.fn(actual.parse) }
})
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parse: mockParse } = require("@babel/parser") as { parse: jest.Mock }

describe("lintBabel", () => {
  it("returns no diagnostics for valid TypeScript", async () => {
    expect(await lintBabel("const a: number = 1\nexport { a }")).toEqual([])
  })

  it("returns no diagnostics for valid JSX", async () => {
    expect(await lintBabel("const el = <div className='x'>hi</div>\nexport { el }")).toEqual([])
  })

  it("treats an empty document as clean", async () => {
    expect(await lintBabel("")).toEqual([])
    expect(await lintBabel("   \n  ")).toEqual([])
  })

  it("flags a syntax error with an in-bounds error diagnostic", async () => {
    const text = "const a: = 1"
    const diags = await lintBabel(text)
    expect(diags.length).toBeGreaterThanOrEqual(1)
    expect(diags[0].severity).toBe("error")
    expect(diags[0].source).toBe("babel")
    expect(diags[0].from).toBeGreaterThanOrEqual(0)
    expect(diags[0].from).toBeLessThanOrEqual(text.length)
    expect(diags[0].to).toBeLessThanOrEqual(text.length)
  })

  it("collects multiple errors via error recovery", async () => {
    const diags = await lintBabel("function (\nconst ;")
    expect(diags.length).toBeGreaterThanOrEqual(1)
  })

  it("strips the trailing (line:col) suffix from messages", async () => {
    const diags = await lintBabel("const a: = 1")
    expect(diags[0].message).not.toMatch(/\(\d+:\d+\)\s*$/)
  })

  it("caps the number of diagnostics", async () => {
    // A long run of broken statements should not flood the UI.
    const text = Array.from({ length: 300 }, () => "const ;").join("\n")
    const diags = await lintBabel(text)
    expect(diags.length).toBeLessThanOrEqual(100)
  })

  it("surfaces a fatal throw that carries a location", async () => {
    mockParse.mockImplementationOnce(() => {
      const e = new Error("fatal") as Error & { loc: { index: number } }
      e.loc = { index: 3 }
      throw e
    })
    const diags = await lintBabel("abcdef")
    expect(diags).toHaveLength(1)
    expect(diags[0].from).toBe(3)
    expect(diags[0].message).toBe("fatal")
  })

  it("swallows a fatal throw without a location", async () => {
    mockParse.mockImplementationOnce(() => {
      throw new Error("no location here")
    })
    expect(await lintBabel("abc")).toEqual([])
  })
})

describe("locate", () => {
  const text = "line1\nlineTwo"
  it("prefers an absolute index when finite", () => {
    expect(locate(text, { index: 4 })).toBe(4)
    expect(locate(text, { index: 999 })).toBe(text.length)
    expect(locate(text, { index: -2 })).toBe(0)
  })
  it("falls back to line/column when index is not finite", () => {
    expect(locate(text, { index: NaN, line: 2, column: 2 })).toBe(8)
    expect(locate(text, { line: 2 })).toBe(6) // column undefined → line start
  })
  it("returns 0 with no location info", () => {
    expect(locate(text, undefined)).toBe(0)
    expect(locate(text, {})).toBe(0)
  })
})

describe("cleanMessage", () => {
  it("strips a trailing (line:col) suffix", () => {
    expect(cleanMessage({ message: "Unexpected token (3:12)" })).toBe("Unexpected token")
  })
  it("falls back to reasonCode then a default", () => {
    expect(cleanMessage({ reasonCode: "UnexpectedToken" })).toBe("UnexpectedToken")
    expect(cleanMessage({})).toBe("Syntax error")
  })
})
