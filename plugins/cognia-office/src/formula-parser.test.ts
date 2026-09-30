import {
  FormulaSyntaxError,
  FormulaUnsupportedError,
  parseFormula,
  type FormulaNode,
} from "./formula-parser"

/** Compact S-expression of a tree, so precedence reads at a glance. */
function show(node: FormulaNode): string {
  switch (node.kind) {
    case "number":
    case "boolean":
      return String(node.value)
    case "string":
      return JSON.stringify(node.value)
    case "error":
      return node.code
    case "ref": {
      const body = node.body
      const text =
        body.type === "area"
          ? `r${body.start.r}c${body.start.c}${body.single ? "" : `:r${body.end.r}c${body.end.c}`}`
          : body.type
      return node.sheet ? `${node.sheet}!${text}` : text
    }
    case "array":
      return `{${node.rows.map((row) => row.map((v) => JSON.stringify(v)).join(",")).join(";")}}`
    case "unary":
      return `(${node.op}${show(node.operand)})`
    case "percent":
      return `(${show(node.operand)}%)`
    case "binary":
      return `(${show(node.left)} ${node.op} ${show(node.right)})`
    case "call":
      return `${node.name}(${node.args.map((arg) => (arg ? show(arg) : "_")).join(", ")})`
  }
}

describe("parseFormula", () => {
  it("follows Excel operator precedence", () => {
    expect(show(parseFormula("1+2*3"))).toBe("(1 + (2 * 3))")
    expect(show(parseFormula("-2^2"))).toBe("((-2) ^ 2)")
    expect(show(parseFormula("2^3^2"))).toBe("((2 ^ 3) ^ 2)")
    expect(show(parseFormula("50%*2"))).toBe("((50%) * 2)")
    expect(show(parseFormula('"a"&1+1'))).toBe('("a" & (1 + 1))')
    expect(show(parseFormula("A1+1>=B2"))).toBe("((r0c0 + 1) >= r1c1)")
    expect(show(parseFormula("(1+2)*3"))).toBe("((1 + 2) * 3)")
  })

  it("reads references through the shared reference grammar", () => {
    expect(show(parseFormula("SUM($A$1:B3)"))).toBe("SUM(r0c0:r2c1)")
    expect(show(parseFormula("'Q1 data'!C4"))).toBe("Q1 data!r3c2")
    expect(show(parseFormula("Sheet2!A:A"))).toBe("Sheet2!columns")
    expect(show(parseFormula("SUM(2:3)"))).toBe("SUM(rows)")
  })

  it("parses literals, errors, omitted arguments and array constants", () => {
    expect(show(parseFormula('"say ""hi"""'))).toBe('"say \\"hi\\""')
    expect(show(parseFormula("1.5e3+.5"))).toBe("(1500 + 0.5)")
    expect(show(parseFormula("IF(TRUE,,#N/A)"))).toBe("IF(true, _, #N/A)")
    expect(show(parseFormula("NOW()"))).toBe("NOW()")
    expect(show(parseFormula('{1,-2;"x",TRUE}'))).toBe('{1,-2;"x",true}')
    expect(show(parseFormula("LOG10(100)"))).toBe("LOG10(100)")
  })

  it("strips the future-function prefix and keeps dotted names", () => {
    expect(show(parseFormula("_xlfn.STDEV.S(A1:A3)"))).toBe("STDEV.S(r0c0:r2c0)")
  })

  it("reports malformed text as a syntax error", () => {
    for (const formula of ["", "1+", "SUM(1", "(1", "1)", '"open', "{1,2;3}", "A1 +* 2"])
      expect(() => parseFormula(formula)).toThrow(FormulaSyntaxError)
  })

  it("reports valid Excel it does not evaluate as unsupported", () => {
    const unsupported = (formula: string) => {
      try {
        parseFormula(formula)
      } catch (error) {
        return error
      }
      return null
    }
    const name = unsupported("TaxRate*2")
    expect(name).toBeInstanceOf(FormulaUnsupportedError)
    expect((name as FormulaUnsupportedError).unknownName).toBe("TaxRate")
    for (const formula of ["Sheet1:Sheet3!A1", "Table1[Amount]", "[1]Sheet1!A1", "A1:B2 B1:C3"]) {
      const error = unsupported(formula)
      expect(error).toBeInstanceOf(FormulaUnsupportedError)
      expect((error as FormulaUnsupportedError).unknownName).toBeUndefined()
    }
  })
})
