import type {
  ChatImportFormat,
  ChatImporter,
  ChatImportOptions,
  ChatImportResult,
  ImportedConversation,
} from "./types"

describe("lib/data/importers/types", () => {
  it("ChatImportFormat accepts the documented union members", () => {
    const formats: ChatImportFormat[] = [
      "chatgpt",
      "claude",
      "gemini",
      "cognia-v3",
      "cognia-v1",
      "unknown",
    ]
    expect(formats).toHaveLength(6)
    expect(new Set(formats).size).toBe(6)
  })

  it("ImportedConversation captures session+messages shape", () => {
    const sample: ImportedConversation = {
      session: { id: "s1" } as ImportedConversation["session"],
      messages: [],
    }
    expect(sample.session.id).toBe("s1")
    expect(Array.isArray(sample.messages)).toBe(true)
  })

  it("ChatImportOptions allows defaultTitle override", () => {
    const opts: ChatImportOptions = { defaultTitle: "Imported" }
    expect(opts.defaultTitle).toBe("Imported")
  })

  it("ChatImportResult bundles format + conversations", () => {
    const result: ChatImportResult = {
      format: "claude",
      conversations: [],
    }
    expect(result.format).toBe("claude")
    expect(result.conversations).toEqual([])
  })

  it("ChatImporter implementation type-checks at runtime", async () => {
    type Sample = { tag: "sample"; value: number }
    const importer: ChatImporter<Sample> = {
      format: "unknown",
      detect: (data: unknown): data is Sample =>
        typeof data === "object" && data !== null && (data as { tag?: string }).tag === "sample",
      parse: async (data, opts) => [
        {
          session: { id: `${data.value}` } as ImportedConversation["session"],
          messages: [],
        } satisfies ImportedConversation,
      ],
    }
    expect(importer.detect({ tag: "sample", value: 1 })).toBe(true)
    expect(importer.detect({ tag: "other" })).toBe(false)
    const out = await importer.parse({ tag: "sample", value: 7 }, { defaultTitle: "T" })
    expect(out[0]?.session.id).toBe("7")
  })
})
