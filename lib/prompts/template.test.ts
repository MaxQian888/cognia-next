import { listPlaceholders, renderPromptTemplate, validatePromptBody } from "./template"
import { definePrompt } from "./types"

const def = definePrompt({
  id: "test.template",
  contractVersion: 1,
  kind: "feature-template",
  group: "generation",
  operation: "replace-template",
  scopes: ["account"],
  activation: "next-operation",
  risk: "protocol",
  hosts: ["app"],
  defaultBody: 'Summarize {{chunks}} in {{locale}}. Reply as JSON with "done".',
  variables: [
    { name: "chunks", required: true, maxChars: 10 },
    { name: "locale", required: false, maxChars: 5 },
  ],
  requiredFragments: ['"done"'],
  maxChars: 200,
  consumers: [],
})

describe("listPlaceholders", () => {
  it("returns names in body order, tolerating inner spaces", () => {
    expect(listPlaceholders("{{a}} and {{ b }} then {{a}}")).toEqual(["a", "b", "a"])
  })
})

describe("renderPromptTemplate", () => {
  it("returns the body untouched when the definition declares no variables", () => {
    const plain = { variables: [] }
    expect(renderPromptTemplate(plain, "Use {{x}} literally", { x: "no" })).toBe(
      "Use {{x}} literally"
    )
  })

  it("substitutes declared values once, clipped to their limit", () => {
    expect(
      renderPromptTemplate(def, "A {{chunks}} B {{ locale }}", {
        chunks: "0123456789abc",
        locale: "en-US-x",
      })
    ).toBe("A 0123456789 B en-US")
  })

  it("never re-scans a substituted value", () => {
    expect(renderPromptTemplate(def, "{{chunks}}", { chunks: "{{locale}}", locale: "zh" })).toBe(
      "{{locale}}"
    )
  })

  it("renders a missing value as empty and leaves undeclared placeholders verbatim", () => {
    expect(renderPromptTemplate(def, "[{{locale}}] {{other}}")).toBe("[] {{other}}")
  })
})

describe("validatePromptBody", () => {
  it("accepts the shipped default", () => {
    expect(validatePromptBody(def, def.defaultBody)).toEqual([])
  })

  it("reports every contract violation", () => {
    const issues = validatePromptBody(def, "Use {{nope}} and {{ broken")
    expect(issues).toEqual(
      expect.arrayContaining([
        { code: "malformed-placeholder" },
        { code: "unknown-variable", name: "nope" },
        { code: "missing-variable", name: "chunks" },
        { code: "missing-fragment", fragment: '"done"' },
      ])
    )
  })

  it("rejects empty and oversized bodies", () => {
    expect(validatePromptBody(def, "   ")).toEqual(expect.arrayContaining([{ code: "empty" }]))
    expect(validatePromptBody(def, `{{chunks}} "done" ${"x".repeat(300)}`)).toEqual(
      expect.arrayContaining([{ code: "too-long", limit: 200, length: expect.any(Number) }])
    )
  })

  it("refuses a body that would send a secret", () => {
    expect(
      validatePromptBody(
        def,
        '{{chunks}} "done" key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
      )
    ).toEqual(expect.arrayContaining([{ code: "pii" }]))
  })

  it("refuses any edit to an inspect-only entry", () => {
    const protocol = definePrompt({
      ...def,
      id: "test.protocol",
      operation: "inspect-only",
      scopes: [],
    })
    expect(validatePromptBody(protocol, protocol.defaultBody)).toEqual([{ code: "not-editable" }])
  })
})
