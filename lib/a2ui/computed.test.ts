import {
  A2UI_COMPUTED_LIMITS,
  A2UI_COMPUTED_OPS,
  applyA2UIComputedFields,
  evaluateA2UIComputedExpression,
  isA2UIComputedExpression,
  isA2UIComputedFields,
  isComputedTargetPath,
  mergeA2UIComputedFields,
} from "./computed"
import type { A2UIComputedExpression, A2UIComputedFields } from "@/types/a2ui/schema"

const p = (path: string) => ({ path })

function evaluate(expression: A2UIComputedExpression, data: Record<string, unknown> = {}) {
  return evaluateA2UIComputedExpression(expression, (path) =>
    path
      .split("/")
      .slice(1)
      .reduce<unknown>((value, key) => (value as Record<string, unknown>)?.[key], data)
  )
}

describe("evaluateA2UIComputedExpression", () => {
  const lists = { xs: [4, 2], items: [1, 2, 3], empty: [] }

  it.each<[string, A2UIComputedExpression, unknown]>([
    ["add", { op: "add", args: [1, 2, 3] }, 6],
    ["subtract", { op: "subtract", args: [10, 4] }, 6],
    ["multiply", { op: "multiply", args: [2, 3, 4] }, 24],
    ["divide", { op: "divide", args: [9, 3] }, 3],
    ["divide by zero is null", { op: "divide", args: [1, 0] }, null],
    ["mod", { op: "mod", args: [7, 3] }, 1],
    ["pow", { op: "pow", args: [2, 10] }, 1024],
    ["min over arrays", { op: "min", args: [p("/xs"), 3] }, 2],
    ["max", { op: "max", args: [1, 9, 3] }, 9],
    ["abs", { op: "abs", args: [-5] }, 5],
    ["round to decimals", { op: "round", args: [3.14159, 2] }, 3.14],
    ["floor", { op: "floor", args: [3.9] }, 3],
    ["ceil", { op: "ceil", args: [3.1] }, 4],
    ["sum flattens arrays", { op: "sum", args: [p("/xs"), 3] }, 9],
    ["count", { op: "count", args: [p("/items")] }, 3],
    ["percentage", { op: "percentage", args: [1, 4] }, 25],
    ["concat skips empty parts", { op: "concat", args: [" ", "a", "", "b"] }, "a b"],
    ["currency", { op: "currency", args: [12.5, "¥", 1] }, "¥12.5"],
    ["fixed", { op: "fixed", args: [2, 2] }, "2.00"],
    ["if", { op: "if", args: [true, "yes", "no"] }, "yes"],
    ["eq", { op: "eq", args: ["a", "a"] }, true],
    ["neq", { op: "neq", args: [1, 2] }, true],
    ["gt", { op: "gt", args: [3, 2] }, true],
    ["gte", { op: "gte", args: [2, 2] }, true],
    ["lt", { op: "lt", args: [1, 2] }, true],
    ["lte", { op: "lte", args: [3, 2] }, false],
    ["and", { op: "and", args: [true, 1, "x"] }, true],
    ["or", { op: "or", args: [false, 0, ""] }, false],
    ["not of an empty list", { op: "not", args: [p("/empty")] }, true],
  ])("%s", (_name, expression, expected) => {
    expect(isA2UIComputedExpression(expression)).toBe(true)
    expect(evaluate(expression, lists)).toEqual(expected)
  })

  it("reads paths and treats text-field strings and empty fields as numbers", () => {
    const data = { qty: "3", price: 2.5, note: "" }
    expect(evaluate({ op: "multiply", args: [p("/qty"), p("/price")] }, data)).toBe(7.5)
    expect(evaluate({ op: "add", args: [p("/note"), 1] }, data)).toBe(1)
  })

  it("makes a non-numeric operand a null result instead of a wrong number", () => {
    expect(evaluate({ op: "add", args: ["abc", 1] })).toBeNull()
    expect(evaluate({ op: "currency", args: ["abc"] })).toBeNull()
  })

  it("sums a field across rows and counts matches", () => {
    const data = {
      cart: [
        { price: 3, done: true },
        { price: "4", done: false },
      ],
    }
    expect(evaluate({ op: "sumOf", args: [p("/cart"), "price"] }, data)).toBe(7)
    expect(evaluate({ op: "countWhere", args: [p("/cart"), "done", true] }, data)).toBe(1)
  })

  it("nests expressions (a loan payment)", () => {
    // P * r / (1 - (1 + r)^-n), r = 0.01, n = 12, P = 1200
    const rate: A2UIComputedExpression = { op: "divide", args: [p("/ratePct"), 100] }
    const payment: A2UIComputedExpression = {
      op: "round",
      args: [
        {
          op: "divide",
          args: [
            { op: "multiply", args: [p("/principal"), rate] },
            {
              op: "subtract",
              args: [
                1,
                {
                  op: "pow",
                  args: [
                    { op: "add", args: [1, rate] },
                    { op: "subtract", args: [0, p("/months")] },
                  ],
                },
              ],
            },
          ],
        },
        2,
      ],
    }
    expect(isA2UIComputedExpression(payment)).toBe(true)
    expect(evaluate(payment, { principal: 1200, ratePct: 1, months: 12 })).toBe(106.62)
  })

  it("only evaluates the branch an if takes", () => {
    const read = jest.fn(() => 1)
    evaluateA2UIComputedExpression({ op: "if", args: [false, p("/a"), p("/b")] }, read)
    expect(read.mock.calls).toEqual([["/b"]])
  })
})

describe("validation", () => {
  it("covers every operator in the schema union", () => {
    expect(A2UI_COMPUTED_OPS).toHaveLength(30)
  })

  it.each<[string, unknown]>([
    ["an unknown operator", { op: "eval", args: ["1+1"] }],
    ["a function-like key", { op: "add", args: [1], fn: "x" }],
    ["wrong arity", { op: "subtract", args: [1] }],
    ["a non-finite literal", { op: "add", args: [Number.POSITIVE_INFINITY] }],
    ["an unsafe path", { op: "add", args: [p("/__proto__/x")] }],
    ["a path object with extra keys", { op: "add", args: [{ path: "/a", op: "x" }] }],
    ["non-array args", { op: "add", args: "1" }],
    ["a literal array operand", { op: "sum", args: [[1, 2]] }],
  ])("rejects %s", (_name, value) => {
    expect(isA2UIComputedExpression(value)).toBe(false)
  })

  it("rejects declarations beyond the depth limit", () => {
    let expression: A2UIComputedExpression = { op: "abs", args: [1] }
    for (let depth = 1; depth < A2UI_COMPUTED_LIMITS.depth; depth++) {
      expression = { op: "abs", args: [expression] }
    }
    expect(isA2UIComputedExpression(expression)).toBe(true)
    expect(isA2UIComputedExpression({ op: "abs", args: [expression] })).toBe(false)
  })

  it("rejects declarations beyond the node budget", () => {
    const wide = { op: "add", args: Array.from({ length: A2UI_COMPUTED_LIMITS.args }, () => 1) }
    const huge = { op: "add", args: Array.from({ length: 10 }, () => wide) }
    expect(isA2UIComputedExpression(huge)).toBe(false)
  })

  it("validates declaration maps and their target paths", () => {
    expect(isComputedTargetPath("/total")).toBe(true)
    expect(isComputedTargetPath("/")).toBe(false)
    expect(isComputedTargetPath("total")).toBe(false)
    expect(isComputedTargetPath("/constructor")).toBe(false)
    expect(isA2UIComputedFields({ "/total": { op: "add", args: [1] } })).toBe(true)
    expect(isA2UIComputedFields({ "/total": null })).toBe(false)
    expect(isA2UIComputedFields({ "/total": null }, { allowRemoval: true })).toBe(true)
    expect(isA2UIComputedFields({ total: { op: "add", args: [1] } })).toBe(false)
    expect(isA2UIComputedFields([])).toBe(false)
    const many = Object.fromEntries(
      Array.from({ length: A2UI_COMPUTED_LIMITS.fields + 1 }, (_, i) => [
        `/f${i}`,
        { op: "add", args: [1] },
      ])
    )
    expect(isA2UIComputedFields(many)).toBe(false)
  })

  it.each<[string, A2UIComputedFields]>([
    ["its own target", { "/n": { op: "add", args: [p("/n"), 1] } }],
    ["a value inside its own target", { "/cart": { op: "count", args: [p("/cart/items")] } }],
    ["a container of its own target", { "/cart/total": { op: "count", args: [p("/cart")] } }],
    ["the whole model", { "/total": { op: "count", args: [p("/")] } }],
    [
      "a target declared after it",
      {
        "/a": { op: "add", args: [p("/b"), 1] },
        "/b": { op: "add", args: [p("/x"), 1] },
      },
    ],
    [
      "nothing, but two targets overlap",
      { "/a": { op: "add", args: [1] }, "/a/b": { op: "add", args: [2] } },
    ],
  ])("rejects a map where a declaration reads %s", (_name, value) => {
    expect(isA2UIComputedFields(value)).toBe(false)
  })

  it("accepts reading an earlier target and a sibling with a shared prefix", () => {
    expect(
      isA2UIComputedFields({
        "/sub": { op: "add", args: [p("/subtotals"), 1] },
        "/total": { op: "add", args: [p("/sub"), 1] },
      })
    ).toBe(true)
  })
})

describe("applyA2UIComputedFields", () => {
  const computed: A2UIComputedFields = {
    "/subtotal": { op: "multiply", args: [p("/qty"), p("/price")] },
    "/summary/total": { op: "add", args: [p("/subtotal"), p("/shipping")] },
  }

  it("evaluates in declaration order, so later values read earlier ones", () => {
    const next = applyA2UIComputedFields({ qty: 2, price: 5, shipping: 3 }, computed)
    expect(next).toEqual({ qty: 2, price: 5, shipping: 3, subtotal: 10, summary: { total: 13 } })
  })

  it("returns the same model when nothing changed or nothing is declared", () => {
    const model = { qty: 2, price: 5, shipping: 3, subtotal: 10, summary: { total: 13 } }
    expect(applyA2UIComputedFields(model, computed)).toBe(model)
    expect(applyA2UIComputedFields(model, undefined)).toBe(model)
  })

  it("does not mutate its input", () => {
    const model = { qty: 1, price: 1, shipping: 0 }
    applyA2UIComputedFields(model, computed)
    expect(model).toEqual({ qty: 1, price: 1, shipping: 0 })
  })
})

describe("mergeA2UIComputedFields", () => {
  it("replaces by path and removes with null", () => {
    const current: A2UIComputedFields = {
      "/a": { op: "add", args: [1] },
      "/b": { op: "add", args: [2] },
    }
    expect(
      mergeA2UIComputedFields(current, { "/a": null, "/c": { op: "abs", args: [-1] } })
    ).toEqual({ "/b": { op: "add", args: [2] }, "/c": { op: "abs", args: [-1] } })
    expect(mergeA2UIComputedFields({ "/a": { op: "add", args: [1] } }, { "/a": null })).toBe(
      undefined
    )
  })

  it("keeps the current map when the merged result would feed back into itself", () => {
    const current: A2UIComputedFields = { "/total": { op: "add", args: [p("/x"), 1] } }
    expect(mergeA2UIComputedFields(current, { "/x": { op: "add", args: [p("/total"), 1] } })).toBe(
      current
    )
    expect(mergeA2UIComputedFields(undefined, { "/n": { op: "add", args: [p("/n"), 1] } })).toBe(
      undefined
    )
  })
})

describe("output bounds", () => {
  it("returns null instead of a string longer than the text limit", () => {
    const read = (path: string) => (path === "/chunk" ? "x".repeat(4_000) : undefined)
    const parts = [p("/chunk"), p("/chunk")]
    expect(
      evaluateA2UIComputedExpression({ op: "concat", args: ["", ...parts] }, read)
    ).toHaveLength(8_000)
    expect(
      evaluateA2UIComputedExpression({ op: "concat", args: ["", ...parts, p("/chunk")] }, read)
    ).toBeNull()
  })

  it("stops a chain of declarations from multiplying a string in one pass", () => {
    const thirtyOne = (path: string) => Array.from({ length: 31 }, () => p(path))
    const computed: A2UIComputedFields = {
      "/f1": { op: "concat", args: ["", ...thirtyOne("/f0")] },
      "/f2": { op: "concat", args: ["", ...thirtyOne("/f1")] },
      "/f3": { op: "concat", args: ["", ...thirtyOne("/f2")] },
      "/f4": { op: "concat", args: ["", ...thirtyOne("/f3")] },
    }
    expect(isA2UIComputedFields(computed)).toBe(true)
    const next = applyA2UIComputedFields({ f0: "abcdefgh" }, computed)
    expect((next.f1 as string).length).toBe(248)
    expect((next.f2 as string).length).toBe(7_688)
    expect(next.f3).toBeNull()
    expect(next.f4).toBe("")
  })
})

describe("applyA2UIComputedFields on a model it cannot write", () => {
  it("does not throw when a target runs through a primitive", () => {
    const model = { a: 5 }
    expect(() =>
      applyA2UIComputedFields(model, { "/a/b": { op: "add", args: [1, 1] } })
    ).not.toThrow()
  })
})
