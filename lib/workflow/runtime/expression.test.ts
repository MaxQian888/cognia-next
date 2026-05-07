import {
  evalToken,
  parseExpression,
  resolveDeep,
  resolveExpression,
  tokenize,
  type ExpressionScope,
} from "./expression"
import type { TriggerEvent } from "@/types/workflow/visual"

const trigger: TriggerEvent = {
  workflowId: "wf_test",
  kind: "trigger.manual",
  payload: { text: "hello", count: 7 },
  originAt: 1_000_000,
}

const scope: ExpressionScope = {
  upstream: {
    n_a: { result: { value: 42, items: ["x", "y", "z"] } },
    n_b: { ok: true },
  },
  trigger,
  staticData: { counter: 5, nested: { deep: "v" } },
  params: { mode: "live" },
}

describe("parseExpression", () => {
  it("returns a single literal for plain strings", () => {
    expect(parseExpression("hello")).toEqual([{ kind: "literal", value: "hello" }])
  })

  it("splits a single expression with surrounding text", () => {
    const segs = parseExpression("count is {{ $static.counter }} now")
    expect(segs).toHaveLength(3)
    expect(segs[0]).toEqual({ kind: "literal", value: "count is " })
    expect(segs[1]).toEqual({ kind: "expr", value: "$static.counter" })
    expect(segs[2]).toEqual({ kind: "literal", value: " now" })
  })

  it("treats unterminated braces as literal tail", () => {
    const segs = parseExpression("oops {{ $static")
    expect(segs[segs.length - 1].kind).toBe("literal")
  })
})

describe("tokenize", () => {
  it("handles $node['id'].field access", () => {
    expect(tokenize("$node['n_a'].result.value")).toEqual([
      { kind: "node", id: "n_a" },
      { kind: "field", name: "result" },
      { kind: "field", name: "value" },
    ])
  })

  it("handles $ident.field['key'][0] access", () => {
    expect(tokenize("$static.nested['deep']")).toEqual([
      { kind: "ident", name: "$static" },
      { kind: "field", name: "nested" },
      { kind: "key", name: "deep" },
    ])
  })

  it("returns [] on syntactic garbage", () => {
    expect(tokenize("not_dollar.x")).toEqual([])
    expect(tokenize("$node[no_quote]")).toEqual([])
    expect(tokenize("$static..x")).toEqual([])
  })
})

describe("evalToken", () => {
  it("walks $node accessors", () => {
    expect(evalToken("$node['n_a'].result.value", scope)).toBe(42)
    expect(evalToken("$node['n_a'].result.items[1]", scope)).toBe("y")
  })

  it("walks $static and $trigger and $params", () => {
    expect(evalToken("$static.counter", scope)).toBe(5)
    expect(evalToken("$trigger.payload.text", scope)).toBe("hello")
    expect(evalToken("$params.mode", scope)).toBe("live")
  })

  it("returns undefined on missing paths instead of throwing", () => {
    expect(evalToken("$node['n_missing'].x", scope)).toBeUndefined()
    expect(evalToken("$static.absent.deep.path", scope)).toBeUndefined()
  })

  it("returns undefined on unknown identifier", () => {
    expect(evalToken("$nope.x", scope)).toBeUndefined()
  })
})

describe("resolveExpression", () => {
  it("returns the typed value when the input is a single expression", () => {
    expect(resolveExpression("{{ $node['n_a'].result.value }}", scope)).toBe(42)
    expect(resolveExpression("{{ $node['n_a'].result.items }}", scope)).toEqual(["x", "y", "z"])
  })

  it("concatenates strings when literals surround the expression", () => {
    expect(resolveExpression("text:{{ $static.counter }};done", scope)).toBe("text:5;done")
  })

  it("renders objects via JSON when concatenated as strings", () => {
    expect(resolveExpression("v={{ $node['n_a'].result }}", scope)).toContain('"value":42')
  })

  it("renders null/undefined as empty when concatenated", () => {
    expect(resolveExpression("a={{ $static.absent }}b", scope)).toBe("a=b")
  })

  it("returns plain strings unchanged when no expression is present", () => {
    expect(resolveExpression("plain text", scope)).toBe("plain text")
  })

  it("returns non-string inputs unchanged", () => {
    // The runtime calls resolveExpression on every leaf; non-strings pass.
    expect(resolveExpression(42 as unknown as string, scope)).toBe(42)
  })
})

describe("resolveDeep", () => {
  it("walks objects and arrays, resolving every string leaf", () => {
    const out = resolveDeep(
      {
        msg: "{{ $trigger.payload.text }}",
        list: ["{{ $node['n_a'].result.value }}", 7],
        nested: { value: "{{ $static.counter }}" },
      },
      scope
    )
    expect(out).toEqual({
      msg: "hello",
      list: [42, 7],
      nested: { value: 5 },
    })
  })

  it("preserves primitives untouched", () => {
    expect(resolveDeep(true, scope)).toBe(true)
    expect(resolveDeep(0, scope)).toBe(0)
    expect(resolveDeep(null, scope)).toBe(null)
  })
})
