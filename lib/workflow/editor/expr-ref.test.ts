import {
  buildNodeRef,
  formatAccessors,
  formatPath,
  parseExprDrag,
  serializeExprDrag,
  type PathSegment,
} from "./expr-ref"
import { resolveExpression, type ExpressionScope } from "@/lib/workflow/runtime/expression"

function scopeWith(upstream: Record<string, unknown>): ExpressionScope {
  return {
    upstream,
    trigger: { workflowId: "w", kind: "trigger.manual", payload: {}, originAt: 0 },
    staticData: {},
    params: {},
  }
}

describe("formatAccessors / formatPath", () => {
  it("renders identifier segments with dots", () => {
    expect(formatAccessors(["foo", "bar"])).toBe(".foo.bar")
    expect(formatPath(["foo", "bar"])).toBe("foo.bar")
  })

  it("renders numeric segments as array indices", () => {
    expect(formatAccessors(["items", 0, "id"])).toBe(".items[0].id")
    expect(formatPath(["items", 0, "id"])).toBe("items[0].id")
  })

  it("bracket-quotes non-identifier keys", () => {
    expect(formatAccessors(["weird key"])).toBe("['weird key']")
    expect(formatPath(["weird key"])).toBe("['weird key']")
  })

  it("uses double quotes when a key contains a single quote", () => {
    expect(formatAccessors(["it's"])).toBe('["it\'s"]')
  })

  it("falls back to single quotes when a key contains both quote chars", () => {
    expect(formatAccessors([`a'b"c`])).toBe(`['a'b"c']`)
  })

  it("handles an empty segment list", () => {
    expect(formatAccessors([])).toBe("")
    expect(formatPath([])).toBe("")
  })
})

describe("buildNodeRef round-trips through resolveExpression", () => {
  const upstream = {
    n_a: {
      foo: 1,
      nested: { value: 42 },
      items: [{ id: 9 }, { id: 10 }],
      "weird key": "w",
    },
  }

  it("builds a top-level identifier reference", () => {
    const ref = buildNodeRef("n_a", ["foo"])
    expect(ref).toBe("{{ $node['n_a'].foo }}")
    expect(resolveExpression(ref, scopeWith(upstream))).toBe(1)
  })

  it("builds a nested reference", () => {
    const ref = buildNodeRef("n_a", ["nested", "value"])
    expect(ref).toBe("{{ $node['n_a'].nested.value }}")
    expect(resolveExpression(ref, scopeWith(upstream))).toBe(42)
  })

  it("builds an array-index reference", () => {
    const ref = buildNodeRef("n_a", ["items", 0, "id"])
    expect(ref).toBe("{{ $node['n_a'].items[0].id }}")
    expect(resolveExpression(ref, scopeWith(upstream))).toBe(9)
  })

  it("builds a bracket-quoted key reference that still resolves", () => {
    const ref = buildNodeRef("n_a", ["weird key"])
    expect(ref).toBe("{{ $node['n_a']['weird key'] }}")
    expect(resolveExpression(ref, scopeWith(upstream))).toBe("w")
  })

  it("references the whole node output with no segments", () => {
    const ref = buildNodeRef("n_a", [] as PathSegment[])
    expect(ref).toBe("{{ $node['n_a'] }}")
    expect(resolveExpression(ref, scopeWith(upstream))).toEqual(upstream.n_a)
  })
})

describe("drag payload (de)serialization", () => {
  it("round-trips a payload", () => {
    const raw = serializeExprDrag("n_a", ["items", 0, "id"])
    expect(parseExprDrag(raw)).toEqual({ nodeId: "n_a", segments: ["items", 0, "id"] })
  })

  it("returns null for empty / invalid / malformed data", () => {
    expect(parseExprDrag(null)).toBeNull()
    expect(parseExprDrag("")).toBeNull()
    expect(parseExprDrag("not json")).toBeNull()
    expect(parseExprDrag(JSON.stringify({ nodeId: 5, segments: [] }))).toBeNull()
    expect(parseExprDrag(JSON.stringify({ nodeId: "n", segments: "x" }))).toBeNull()
  })

  it("filters out non-string/number segment entries", () => {
    const raw = JSON.stringify({ nodeId: "n", segments: ["a", 1, { bad: true }, null] })
    expect(parseExprDrag(raw)).toEqual({ nodeId: "n", segments: ["a", 1] })
  })
})
