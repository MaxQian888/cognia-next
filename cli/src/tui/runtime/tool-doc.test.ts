import { buildPromptsDocument, buildResourcesDocument, buildToolsDocument } from "./tool-doc"

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

describe("buildResourcesDocument", () => {
  it("renders uri, mime, and description", () => {
    const doc = buildResourcesDocument(
      [{ uri: "file://a.txt", name: "A", description: "the a file", mimeType: "text/plain" }],
      "1 resource"
    )
    expect(doc).toContain("1 resource")
    expect(doc).toContain("### A")
    expect(doc).toContain("`file://a.txt`")
    expect(doc).toContain("text/plain")
    expect(doc).toContain("the a file")
  })
  it("falls back to the uri as heading and handles empties", () => {
    expect(buildResourcesDocument([{ uri: "x://y" }])).toContain("### x://y")
    expect(buildResourcesDocument([])).toContain("_No resources._")
  })
})

describe("buildPromptsDocument", () => {
  it("renders name, description, and arguments", () => {
    const doc = buildPromptsDocument(
      [
        {
          name: "summarize",
          description: "summarize text",
          arguments: [{ name: "text", required: true, description: "input" }, { name: "tone" }],
        },
      ],
      "1 prompt"
    )
    expect(doc).toContain("### summarize")
    expect(doc).toContain("summarize text")
    expect(doc).toContain("`text` _(required)_ — input")
    expect(doc).toContain("`tone`")
  })
  it("handles an empty prompt list", () => {
    expect(buildPromptsDocument([])).toContain("_No prompts._")
  })
})
