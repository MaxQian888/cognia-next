import {
  extractAnthropicCitations,
  extractFootnoteSources,
  extractTwinRagSources,
  mergeSources,
  type TwinRetrievedChunk,
} from "./citations"
import type { BetaContentBlock } from "./types"

describe("extractAnthropicCitations", () => {
  it("returns [] when no text block carries citations", () => {
    const blocks = [
      { type: "text", text: "hello" },
      { type: "tool_use", id: "t1", name: "Read", input: {} },
    ] as unknown as BetaContentBlock[]
    expect(extractAnthropicCitations(blocks)).toEqual([])
  })

  it("converts URL citations into Source items with origin=anthropic", () => {
    const blocks = [
      {
        type: "text",
        text: "see",
        citations: [
          {
            type: "url_citation",
            url: "https://example.com/a",
            title: "Example A",
            cited_text: "evidence body",
          },
        ],
      },
    ] as unknown as BetaContentBlock[]
    const out = extractAnthropicCitations(blocks)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      origin: "anthropic",
      url: "https://example.com/a",
      title: "Example A",
      snippet: "evidence body",
    })
  })

  it("falls back to document_title when url/title absent", () => {
    const blocks = [
      {
        type: "text",
        text: "see",
        citations: [
          {
            type: "page_location",
            document_title: "Onboarding PDF",
            cited_text: "page 4",
          },
        ],
      },
    ] as unknown as BetaContentBlock[]
    const out = extractAnthropicCitations(blocks)
    expect(out[0].title).toBe("Onboarding PDF")
    expect(out[0].url).toBeUndefined()
  })

  it("deduplicates citations sharing the same URL", () => {
    const blocks = [
      {
        type: "text",
        text: "...",
        citations: [
          { type: "url_citation", url: "https://example.com/x", title: "X" },
          { type: "url_citation", url: "https://example.com/x", title: "X again" },
        ],
      },
    ] as unknown as BetaContentBlock[]
    const out = extractAnthropicCitations(blocks)
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe("X")
  })

  it("truncates long cited_text snippets at 200 chars", () => {
    const long = "a".repeat(500)
    const blocks = [
      {
        type: "text",
        text: "see",
        citations: [{ type: "url_citation", url: "u", title: "t", cited_text: long }],
      },
    ] as unknown as BetaContentBlock[]
    const out = extractAnthropicCitations(blocks)
    expect(out[0].snippet?.length).toBeLessThanOrEqual(200)
    expect(out[0].snippet?.endsWith("…")).toBe(true)
  })
})

describe("extractTwinRagSources", () => {
  it("returns [] for null / undefined / empty input", () => {
    expect(extractTwinRagSources(undefined)).toEqual([])
    expect(extractTwinRagSources(null)).toEqual([])
    expect(extractTwinRagSources([])).toEqual([])
  })

  it("maps retrieved chunks to source items with origin=twin-rag", () => {
    const chunks: TwinRetrievedChunk[] = [
      {
        chunk: { vectorDocId: "v1", content: "chunk body 1", sourceId: "s1" },
        score: 0.87,
        sourceTitle: "doc-a.md",
      },
      {
        chunk: { vectorDocId: "v2", content: "chunk body 2", sourceId: "s1" },
        score: 0.5,
      },
    ]
    const out = extractTwinRagSources(chunks)
    expect(out).toEqual([
      {
        id: "twin-v1",
        title: "doc-a.md",
        snippet: "chunk body 1",
        origin: "twin-rag",
        score: 0.87,
      },
      {
        id: "twin-v2",
        title: "Twin chunk 2",
        snippet: "chunk body 2",
        origin: "twin-rag",
        score: 0.5,
      },
    ])
  })
})

describe("extractFootnoteSources", () => {
  it("extracts markdown footnotes by ref", () => {
    const text = `Body[^1] and another[^a].

[^1]: First note
[^a]: Second note with https://ex.com/x link`
    const out = extractFootnoteSources(text)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      id: "footnote-1",
      title: "Note 1",
      origin: "footnote",
      snippet: "First note",
    })
    expect(out[1].url).toBe("https://ex.com/x")
  })

  it("handles empty / non-string input", () => {
    expect(extractFootnoteSources("")).toEqual([])
    expect(extractFootnoteSources(undefined)).toEqual([])
  })
})

describe("mergeSources", () => {
  it("preserves order across lists and dedups by url/title", () => {
    const a = [{ id: "a1", title: "T1", origin: "anthropic" as const, url: "https://x" }]
    const b = [
      { id: "b1", title: "T2", origin: "twin-rag" as const },
      { id: "b2", title: "T1", origin: "twin-rag" as const, url: "https://x" }, // dup with a1
    ]
    const merged = mergeSources(a, b)
    expect(merged.map((s) => s.id)).toEqual(["a1", "b1"])
  })
})
