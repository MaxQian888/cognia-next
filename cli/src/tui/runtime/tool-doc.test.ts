import { buildToolsDocument } from "./tool-doc"

describe("buildToolsDocument", () => {
  it("renders a heading, description, and JSON schema per tool", () => {
    const doc = buildToolsDocument([
      {
        name: "web_fetch",
        description: "Fetch a URL",
        schema: { type: "object", properties: { url: { type: "string" } } },
      },
    ])
    expect(doc).toContain("### web_fetch")
    expect(doc).toContain("Fetch a URL")
    expect(doc).toContain("```json")
    expect(doc).toContain('"url"')
  })

  it("adds a category badge when present", () => {
    const doc = buildToolsDocument([{ name: "bash", category: "core file tools" }])
    expect(doc).toContain("### bash  `core file tools`")
  })

  it("includes the summary lead line", () => {
    const doc = buildToolsDocument([{ name: "x" }], "1 tool advertised by foo")
    expect(doc.startsWith("1 tool advertised by foo")).toBe(true)
  })

  it("omits an empty-object schema block", () => {
    const doc = buildToolsDocument([{ name: "ping", schema: {} }])
    expect(doc).not.toContain("```json")
  })

  it("renders a placeholder for an empty tool list", () => {
    expect(buildToolsDocument([])).toContain("_No tools._")
  })

  it("survives a schema that cannot be stringified", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const doc = buildToolsDocument([{ name: "loop", schema: circular }])
    expect(doc).toContain("### loop")
    expect(doc).not.toContain("```json")
  })
})
