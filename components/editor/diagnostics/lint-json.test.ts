import { lintJson } from "./lint-json"

describe("lintJson", () => {
  it("returns no diagnostics for valid JSON", () => {
    expect(lintJson('{ "a": 1, "b": [2, 3] }')).toEqual([])
    expect(lintJson('"a string"')).toEqual([])
    expect(lintJson("null")).toEqual([])
  })

  it("treats an empty / whitespace document as clean", () => {
    expect(lintJson("")).toEqual([])
    expect(lintJson("   \n\t ")).toEqual([])
  })

  it("flags a syntax error with a single error diagnostic", () => {
    const diags = lintJson('{ "a": }')
    expect(diags).toHaveLength(1)
    expect(diags[0].severity).toBe("error")
    expect(diags[0].source).toBe("json")
    expect(diags[0].message.length).toBeGreaterThan(0)
  })

  it("locates the error within document bounds", () => {
    const text = '{\n  "a": 1\n  "b": 2\n}'
    const [diag] = lintJson(text)
    expect(diag.from).toBeGreaterThanOrEqual(0)
    expect(diag.from).toBeLessThanOrEqual(text.length)
    expect(diag.to).toBeGreaterThanOrEqual(diag.from)
    expect(diag.to).toBeLessThanOrEqual(text.length)
  })

  it("derives an offset from an 'at position' message", () => {
    // Force the legacy message shape regardless of the runtime's V8 wording.
    const spy = jest.spyOn(JSON, "parse").mockImplementation(() => {
      throw new SyntaxError("Unexpected token } in JSON at position 7")
    })
    const [diag] = lintJson("{bad}json")
    expect(diag.from).toBe(7)
    expect(diag.to).toBe(8)
    spy.mockRestore()
  })

  it("derives an offset from a 'line/column' message", () => {
    const text = "line1\nlineTwoX"
    const spy = jest.spyOn(JSON, "parse").mockImplementation(() => {
      throw new SyntaxError("Bad value in JSON at line 2 column 3")
    })
    const [diag] = lintJson(text)
    // line 2 starts at offset 6; column 3 (1-based) → offset 6 + 2 = 8
    expect(diag.from).toBe(8)
    spy.mockRestore()
  })

  it("falls back to offset 0 when no position is present", () => {
    const spy = jest.spyOn(JSON, "parse").mockImplementation(() => {
      throw new SyntaxError("totally opaque failure")
    })
    const [diag] = lintJson("whatever")
    expect(diag.from).toBe(0)
    expect(diag.message).toBe("totally opaque failure")
    spy.mockRestore()
  })

  it("handles a non-Error throw", () => {
    const spy = jest.spyOn(JSON, "parse").mockImplementation(() => {
      throw "string failure"
    })
    const [diag] = lintJson("x")
    expect(diag.message).toBe("Invalid JSON")
    spy.mockRestore()
  })
})
