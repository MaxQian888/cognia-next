import {
  JSON_OUTPUT_PROMPT,
  JSON_OUTPUT_SHAPE_PROMPT,
  buildJsonInstruction,
  parseStructured,
} from "./structured"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"

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

describe("JSON output protocol entries (ADR-0236)", () => {
  afterEach(() => {
    __setPromptOverrideSnapshotForTests(null)
    __resetPromptVerdictsForTests()
  })

  it("renders the shipped protocol text byte-for-byte", () => {
    expect(buildJsonInstruction()).toBe(
      "Respond with ONLY a single valid JSON value — no prose, no markdown code fences."
    )
    expect(buildJsonInstruction(' {"a": 1} ')).toBe(
      'Respond with ONLY a single valid JSON value — no prose, no markdown code fences.\nMatch this shape:\n{"a": 1}'
    )
  })

  it("is inspect-only: a stored override never changes the protocol", () => {
    expect(JSON_OUTPUT_PROMPT.operation).toBe("inspect-only")
    expect(JSON_OUTPUT_SHAPE_PROMPT.scopes).toEqual([])
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob-json",
          promptId: JSON_OUTPUT_PROMPT.id,
          scope: "account",
          targetId: "",
          revisionId: "por-json-output",
          body: "Reply however you like.",
          contractVersion: 1,
        },
      ])
    )
    expect(buildJsonInstruction()).toBe(JSON_OUTPUT_PROMPT.defaultBody)
  })
})
