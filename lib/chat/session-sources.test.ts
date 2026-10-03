import type { UIMessage } from "ai"

import { collectSessionSources, groupSessionSourcesByLabel } from "./session-sources"

const LABELS = { document: "Document", file: "File" }

function message(id: string, parts: unknown[]): UIMessage {
  return { id, role: "assistant", parts } as unknown as UIMessage
}

describe("collectSessionSources", () => {
  it("records the message id and 1-based number each source first appeared in", () => {
    const sources = collectSessionSources(
      [
        message("m1", [{ type: "text", text: "hi" }]),
        message("m2", [{ type: "source-url", url: "https://example.com/a", title: "A" }]),
      ],
      LABELS
    )
    expect(sources).toEqual([
      expect.objectContaining({
        id: "web:https://example.com/a",
        kind: "web",
        label: "web",
        title: "A",
        detail: "example.com",
        messageNumber: 2,
        messageId: "m2",
      }),
    ])
  })

  it("keeps the first sighting of a repeated source but adopts a detail it lacked", () => {
    const sources = collectSessionSources(
      [
        message("m1", [{ type: "source-document", sourceId: "doc-1", filename: "spec.pdf" }]),
        message("m2", [
          {
            type: "source-document",
            sourceId: "doc-1",
            filename: "spec.pdf",
            mediaType: "application/pdf",
          },
        ]),
      ],
      LABELS
    )
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      messageId: "m1",
      detail: "application/pdf",
      label: "document",
    })
  })

  it("maps grounded sources by origin and folds web citations onto the url id", () => {
    const sources = collectSessionSources(
      [
        message("m1", [
          {
            type: "sources",
            sources: [
              { id: "c1", title: "Docs", url: "https://docs.dev/x", origin: "anthropic" },
              { id: "k1", title: "Notes", origin: "project-knowledge" },
              { id: "h1", title: "Old claim", origin: "project-history" },
            ],
          },
        ]),
        message("m2", [{ type: "source-url", url: "https://docs.dev/x" }]),
      ],
      LABELS
    )
    expect(sources.map((s) => [s.id, s.kind, s.label])).toEqual([
      ["web:https://docs.dev/x", "web", "anthropic"],
      ["other:project-knowledge:k1", "other", "projectKnowledge"],
      ["other:project-history:h1", "other", "memory"],
    ])
  })

  it("names untitled files from the url or the fallback label, and records tool calls", () => {
    const sources = collectSessionSources(
      [
        message("m1", [
          { type: "file", url: "https://cdn.dev/files/report%20v2.csv", mediaType: "text/csv" },
          { type: "file", url: "data:image/png;base64,AAAA" },
          { type: "tool-web_fetch", toolCallId: "t1", input: { url: "https://a.dev" } },
          { type: "dynamic-tool", toolName: "mcp__gh__search", toolCallId: "t2", input: "q" },
        ]),
      ],
      LABELS
    )
    expect(sources.map((s) => s.title)).toEqual([
      "report v2.csv",
      "File",
      "web_fetch",
      "mcp__gh__search",
    ])
    expect(sources[2]).toMatchObject({ label: "tool", detail: '{"url":"https://a.dev"}' })
    expect(sources[3]).toMatchObject({ detail: "q" })
  })
})

describe("groupSessionSourcesByLabel", () => {
  it("orders by count and keeps first-appearance order on ties", () => {
    const groups = groupSessionSourcesByLabel(
      collectSessionSources(
        [
          message("m1", [
            { type: "tool-read", toolCallId: "t1" },
            { type: "source-url", url: "https://a.dev" },
          ]),
          message("m2", [
            { type: "source-url", url: "https://b.dev" },
            { type: "source-document", sourceId: "d" },
          ]),
        ],
        LABELS
      )
    )
    expect(groups).toEqual([
      { label: "web", count: 2, messageId: "m1" },
      { label: "tool", count: 1, messageId: "m1" },
      { label: "document", count: 1, messageId: "m2" },
    ])
  })

  it("returns an empty list for a conversation with no sources", () => {
    expect(groupSessionSourcesByLabel([])).toEqual([])
  })
})
