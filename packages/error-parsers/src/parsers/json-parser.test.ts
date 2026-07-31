/**
 * @jest-environment node
 */

import { jsonParser } from "./json-parser"

describe("jsonParser", () => {
  it("parses a flat JSON object", () => {
    const result = jsonParser.parse('{"key": "value", "num": 42}')
    expect(result).not.toBeNull()
    expect(result!.parsed).toBe(true)
    expect(result!.nodes[0].kind).toBe("json")
  })

  it("parses a nested JSON object", () => {
    const result = jsonParser.parse('{"outer": {"inner": "val"}}')
    expect(result).not.toBeNull()
    expect(result!.parsed).toBe(true)
  })

  it("parses a JSON array", () => {
    const result = jsonParser.parse("[1, 2, 3]")
    expect(result).not.toBeNull()
    expect(result!.parsed).toBe(true)
    expect(result!.nodes[0].kind).toBe("json")
  })

  it("returns null for invalid JSON", () => {
    const result = jsonParser.parse('{"broken":}')
    expect(result).toBeNull()
  })

  it("returns null for non-JSON text", () => {
    const result = jsonParser.parse("just some error message")
    expect(result).toBeNull()
  })

  it("returns null for empty string", () => {
    const result = jsonParser.parse("")
    expect(result).toBeNull()
  })

  it("returns null for JSON primitives at root (only objects/arrays)", () => {
    expect(jsonParser.parse('"hello"')).toBeNull()
    expect(jsonParser.parse("42")).toBeNull()
    expect(jsonParser.parse("true")).toBeNull()
    expect(jsonParser.parse("null")).toBeNull()
  })

  it("carries the parsed value on the node (no lossy round-trip)", () => {
    const result = jsonParser.parse('{"nested": {"deep": [1, 2, 3]}}')
    expect(result!.nodes[0].kind).toBe("json")
    expect(result!.nodes[0].value).toEqual({ nested: { deep: [1, 2, 3] } })
  })

  it("extracts a JSON object embedded after a prose/log prefix", () => {
    const result = jsonParser.parse('Exit code 1\nerror: boom\n{"ok": false}')
    expect(result).not.toBeNull()
    expect(result!.nodes.map((n) => n.kind)).toEqual(["text", "json"])
    expect(result!.nodes[0].content).toBe("Exit code 1\nerror: boom")
    expect((result!.nodes[1].value as { ok: boolean }).ok).toBe(false)
  })

  it("preserves prose on both sides of an embedded block", () => {
    const result = jsonParser.parse('before {"a": [1, 2]} after')
    expect(result!.nodes.map((n) => n.kind)).toEqual(["text", "json", "text"])
    expect(result!.nodes[0].content).toBe("before")
    expect(result!.nodes[2].content).toBe("after")
  })

  it("ignores braces and brackets inside strings when finding the boundary", () => {
    const result = jsonParser.parse('{"msg": "a } b ] c"}')
    expect(result).not.toBeNull()
    expect((result!.nodes[0].value as { msg: string }).msg).toBe("a } b ] c")
  })

  it("honours escaped quotes inside strings while scanning", () => {
    const result = jsonParser.parse('{"msg": "a \\" } b"}')
    expect(result).not.toBeNull()
    expect((result!.nodes[0].value as { msg: string }).msg).toBe('a " } b')
  })

  it("skips a balanced-but-invalid brace run and finds a later valid block", () => {
    const result = jsonParser.parse('noise {nope} then {"ok": true}')
    expect(result).not.toBeNull()
    const json = result!.nodes.find((n) => n.kind === "json")
    expect((json!.value as { ok: boolean }).ok).toBe(true)
  })

  it("returns null when a brace never closes", () => {
    expect(jsonParser.parse('prefix {"unterminated": true')).toBeNull()
  })
})
