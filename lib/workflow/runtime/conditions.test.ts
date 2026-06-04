import { evaluateCondition, evaluateConditionGroup, type ResolvedCondition } from "./conditions"

function cond(partial: Partial<ResolvedCondition> & Pick<ResolvedCondition, "operator">) {
  return { left: undefined, ...partial }
}

describe("evaluateCondition", () => {
  describe("eq / neq", () => {
    it("compares strings case-insensitively by default", () => {
      expect(evaluateCondition(cond({ left: "OK", operator: "eq", right: "ok" }))).toBe(true)
      expect(evaluateCondition(cond({ left: "OK", operator: "neq", right: "ok" }))).toBe(false)
    })

    it("honors caseSensitive", () => {
      expect(
        evaluateCondition(cond({ left: "OK", operator: "eq", right: "ok", caseSensitive: true }))
      ).toBe(false)
      expect(
        evaluateCondition(cond({ left: "OK", operator: "neq", right: "ok", caseSensitive: true }))
      ).toBe(true)
    })

    it("numeric-coerces when one side is a number", () => {
      expect(evaluateCondition(cond({ left: 5, operator: "eq", right: "5" }))).toBe(true)
      expect(evaluateCondition(cond({ left: "5.0", operator: "eq", right: 5 }))).toBe(true)
      expect(evaluateCondition(cond({ left: 5, operator: "neq", right: "6" }))).toBe(true)
    })

    it("compares booleans and null strictly", () => {
      expect(evaluateCondition(cond({ left: true, operator: "eq", right: true }))).toBe(true)
      expect(evaluateCondition(cond({ left: null, operator: "eq", right: null }))).toBe(true)
      expect(evaluateCondition(cond({ left: true, operator: "eq", right: "true" }))).toBe(true)
    })

    it("deep-compares objects and arrays", () => {
      expect(evaluateCondition(cond({ left: { a: 1 }, operator: "eq", right: { a: 1 } }))).toBe(
        true
      )
      expect(evaluateCondition(cond({ left: [1, 2], operator: "eq", right: [1, 2] }))).toBe(true)
      expect(evaluateCondition(cond({ left: [1, 2], operator: "eq", right: [2, 1] }))).toBe(false)
    })
  })

  describe("ordering operators numeric-coerce", () => {
    it("compares numbers", () => {
      expect(evaluateCondition(cond({ left: 3, operator: "gt", right: 2 }))).toBe(true)
      expect(evaluateCondition(cond({ left: 2, operator: "gte", right: 2 }))).toBe(true)
      expect(evaluateCondition(cond({ left: 1, operator: "lt", right: 2 }))).toBe(true)
      expect(evaluateCondition(cond({ left: 2, operator: "lte", right: 2 }))).toBe(true)
      expect(evaluateCondition(cond({ left: 2, operator: "gt", right: 2 }))).toBe(false)
    })

    it("coerces numeric strings", () => {
      expect(evaluateCondition(cond({ left: "10", operator: "gt", right: "9" }))).toBe(true)
      expect(evaluateCondition(cond({ left: "10", operator: "gt", right: 9 }))).toBe(true)
    })

    it("falls back to string compare when not numeric", () => {
      // Lexicographic: "b" > "a"
      expect(evaluateCondition(cond({ left: "b", operator: "gt", right: "a" }))).toBe(true)
      expect(evaluateCondition(cond({ left: "a", operator: "lt", right: "b" }))).toBe(true)
    })

    it("returns false when an operand is missing", () => {
      expect(evaluateCondition(cond({ left: undefined, operator: "gt", right: 1 }))).toBe(false)
      expect(evaluateCondition(cond({ left: 1, operator: "gt", right: undefined }))).toBe(false)
    })
  })

  describe("string operators", () => {
    it("contains / notContains on strings (case toggle)", () => {
      expect(
        evaluateCondition(cond({ left: "Hello World", operator: "contains", right: "world" }))
      ).toBe(true)
      expect(
        evaluateCondition(
          cond({ left: "Hello World", operator: "contains", right: "world", caseSensitive: true })
        )
      ).toBe(false)
      expect(evaluateCondition(cond({ left: "Hello", operator: "notContains", right: "x" }))).toBe(
        true
      )
    })

    it("contains on arrays checks membership", () => {
      expect(evaluateCondition(cond({ left: ["a", "b"], operator: "contains", right: "a" }))).toBe(
        true
      )
      expect(evaluateCondition(cond({ left: [1, 2], operator: "contains", right: 2 }))).toBe(true)
      expect(evaluateCondition(cond({ left: [1, 2], operator: "contains", right: "2" }))).toBe(true)
      expect(evaluateCondition(cond({ left: [1, 2], operator: "notContains", right: 3 }))).toBe(
        true
      )
    })

    it("startsWith / endsWith with case toggle", () => {
      expect(evaluateCondition(cond({ left: "Hello", operator: "startsWith", right: "he" }))).toBe(
        true
      )
      expect(
        evaluateCondition(
          cond({ left: "Hello", operator: "startsWith", right: "he", caseSensitive: true })
        )
      ).toBe(false)
      expect(evaluateCondition(cond({ left: "Hello", operator: "endsWith", right: "LO" }))).toBe(
        true
      )
    })

    it("regex tests the stringified left operand", () => {
      expect(
        evaluateCondition(cond({ left: "abc-123", operator: "regex", right: "^abc-\\d+$" }))
      ).toBe(true)
      expect(evaluateCondition(cond({ left: "ABC-123", operator: "regex", right: "^abc-" }))).toBe(
        true
      )
      expect(
        evaluateCondition(
          cond({ left: "ABC-123", operator: "regex", right: "^abc-", caseSensitive: true })
        )
      ).toBe(false)
      expect(evaluateCondition(cond({ left: 42, operator: "regex", right: "^\\d+$" }))).toBe(true)
    })

    it("invalid regex evaluates to false instead of throwing", () => {
      expect(evaluateCondition(cond({ left: "x", operator: "regex", right: "(" }))).toBe(false)
    })

    it("regex without a pattern evaluates to false", () => {
      expect(evaluateCondition(cond({ left: "x", operator: "regex" }))).toBe(false)
    })
  })

  describe("inRange", () => {
    it("is inclusive on both bounds", () => {
      expect(
        evaluateCondition(cond({ left: 5, operator: "inRange", right: 1, rightUpper: 10 }))
      ).toBe(true)
      expect(
        evaluateCondition(cond({ left: 1, operator: "inRange", right: 1, rightUpper: 10 }))
      ).toBe(true)
      expect(
        evaluateCondition(cond({ left: 10, operator: "inRange", right: 1, rightUpper: 10 }))
      ).toBe(true)
      expect(
        evaluateCondition(cond({ left: 11, operator: "inRange", right: 1, rightUpper: 10 }))
      ).toBe(false)
    })

    it("coerces string operands", () => {
      expect(
        evaluateCondition(cond({ left: "5", operator: "inRange", right: "1", rightUpper: "10" }))
      ).toBe(true)
    })

    it("returns false on non-numeric operands", () => {
      expect(
        evaluateCondition(cond({ left: "abc", operator: "inRange", right: "1", rightUpper: "10" }))
      ).toBe(false)
      expect(evaluateCondition(cond({ left: 5, operator: "inRange", right: "1" }))).toBe(false)
    })
  })

  describe("unary operators", () => {
    it("isEmpty true for null/undefined/empty string/array/object", () => {
      for (const v of [null, undefined, "", [], {}]) {
        expect(evaluateCondition(cond({ left: v, operator: "isEmpty" }))).toBe(true)
        expect(evaluateCondition(cond({ left: v, operator: "isNotEmpty" }))).toBe(false)
      }
    })

    it("isEmpty false for 0, false, non-empty values", () => {
      for (const v of [0, false, "x", [0], { a: 1 }]) {
        expect(evaluateCondition(cond({ left: v, operator: "isEmpty" }))).toBe(false)
        expect(evaluateCondition(cond({ left: v, operator: "isNotEmpty" }))).toBe(true)
      }
    })

    it("truthy follows JS truthiness with 'false'/'0' strings treated as false", () => {
      expect(evaluateCondition(cond({ left: 1, operator: "truthy" }))).toBe(true)
      expect(evaluateCondition(cond({ left: "yes", operator: "truthy" }))).toBe(true)
      expect(evaluateCondition(cond({ left: 0, operator: "truthy" }))).toBe(false)
      expect(evaluateCondition(cond({ left: "", operator: "truthy" }))).toBe(false)
      expect(evaluateCondition(cond({ left: "false", operator: "truthy" }))).toBe(false)
      expect(evaluateCondition(cond({ left: "0", operator: "truthy" }))).toBe(false)
    })
  })

  it("unknown operator evaluates to false", () => {
    expect(
      evaluateCondition({ left: 1, operator: "nope" as ResolvedCondition["operator"], right: 1 })
    ).toBe(false)
  })
})

describe("evaluateConditionGroup", () => {
  const T: ResolvedCondition = { left: 1, operator: "eq", right: 1 }
  const F: ResolvedCondition = { left: 1, operator: "eq", right: 2 }

  it("all requires every condition to pass", () => {
    expect(evaluateConditionGroup({ combinator: "all", conditions: [T, T] })).toBe(true)
    expect(evaluateConditionGroup({ combinator: "all", conditions: [T, F] })).toBe(false)
  })

  it("any requires at least one condition to pass", () => {
    expect(evaluateConditionGroup({ combinator: "any", conditions: [F, T] })).toBe(true)
    expect(evaluateConditionGroup({ combinator: "any", conditions: [F, F] })).toBe(false)
  })

  it("empty group: all is vacuously true, any is false", () => {
    expect(evaluateConditionGroup({ combinator: "all", conditions: [] })).toBe(true)
    expect(evaluateConditionGroup({ combinator: "any", conditions: [] })).toBe(false)
  })
})
