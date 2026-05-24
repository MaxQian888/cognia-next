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
})
