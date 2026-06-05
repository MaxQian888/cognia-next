import { buildJsonInstruction, parseStructured } from "./structured"

describe("parseStructured", () => {
  it("extracts plain JSON", () => {
    expect(parseStructured('{"a":1}')).toEqual({ value: { a: 1 } })
  })

  it("extracts fenced JSON with surrounding prose", () => {
    const r = parseStructured('Sure!\n```json\n{"ok":true}\n```\nDone.')
    expect(r.value).toEqual({ ok: true })
    expect(r.error).toBeUndefined()
  })

  it("returns a parse error instead of throwing on non-JSON", () => {
    const r = parseStructured("no json here at all")
    expect(r.value).toBeNull()
    expect(r.error).toMatch(/no JSON/)
  })
})

describe("buildJsonInstruction", () => {
  it("returns the base instruction without a schema", () => {
    expect(buildJsonInstruction()).toMatch(/ONLY a single valid JSON/)
    expect(buildJsonInstruction("  ")).not.toMatch(/Match this shape/)
  })

  it("appends the schema shape when provided", () => {
    const s = buildJsonInstruction('{"name": "string"}')
    expect(s).toMatch(/Match this shape/)
    expect(s).toContain('{"name": "string"}')
  })
})
