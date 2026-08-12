/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import type { UIMessage } from "ai"
import { SessionSourcesPanel } from "./session-sources-panel"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const messages: UIMessage[] = [
  {
    id: "user-1",
    role: "user",
    parts: [
      { type: "text", text: "Review these references" },
      {
        type: "file",
        url: "data:text/plain;base64,cmVwb3J0",
        mediaType: "text/plain",
        filename: "report.txt",
      },
    ],
  },
  {
    id: "assistant-1",
    role: "assistant",
    parts: [
      {
        type: "source-url",
        sourceId: "next-docs",
        url: "https://nextjs.org/docs/app/building-your-application/deploying/static-exports",
        title: "Next.js static exports",
      },
      {
        type: "source-document",
        sourceId: "architecture",
        mediaType: "application/pdf",
        title: "Architecture notes",
        filename: "architecture.pdf",
      },
      {
        type: "sources",
        sources: [
          {
            id: "duplicate-next-docs",
            title: "Next.js docs duplicate",
            url: "https://nextjs.org/docs/app/building-your-application/deploying/static-exports",
            origin: "anthropic",
          },
          {
            id: "memory-1",
            title: "Preferred deployment target",
            snippet: "Use a static export for the desktop shell.",
            origin: "memory",
          },
        ],
      } as unknown as UIMessage["parts"][number],
      {
        type: "dynamic-tool",
        toolCallId: "tool-1",
        toolName: "web_search",
        state: "output-available",
        input: { query: "Next.js static export" },
        output: { count: 5 },
      } as unknown as UIMessage["parts"][number],
    ],
  },
]

describe("SessionSourcesPanel", () => {
  it("groups and deduplicates web, file, and other message sources", () => {
    render(<SessionSourcesPanel messages={messages} />)

    expect(screen.getByRole("link", { name: /Next\.js static exports/ })).toHaveAttribute(
      "href",
      "https://nextjs.org/docs/app/building-your-application/deploying/static-exports"
    )
    expect(screen.getAllByRole("link", { name: /Next\.js/ })).toHaveLength(1)
    expect(screen.getByText("report.txt")).toBeInTheDocument()
    expect(screen.getByText("architecture.pdf")).toBeInTheDocument()
    expect(screen.getByText("Preferred deployment target")).toBeInTheDocument()
    expect(screen.getByText("web_search")).toBeInTheDocument()
  })

  it("searches across titles, details, URLs, and tool inputs", () => {
    render(<SessionSourcesPanel messages={messages} />)

    fireEvent.change(screen.getByPlaceholderText("searchPlaceholder"), {
      target: { value: "static export" },
    })

    expect(screen.getByText("Next.js static exports")).toBeInTheDocument()
    expect(screen.getByText("web_search")).toBeInTheDocument()
    expect(screen.queryByText("report.txt")).not.toBeInTheDocument()
    expect(screen.getByText("Preferred deployment target")).toBeInTheDocument()
  })

  it("filters by source kind and explains an empty conversation", () => {
    const { rerender } = render(<SessionSourcesPanel messages={messages} />)

    fireEvent.click(screen.getByRole("tab", { name: /filters\.files/ }))
    expect(screen.getByText("report.txt")).toBeInTheDocument()
    expect(screen.getByText("architecture.pdf")).toBeInTheDocument()
    expect(screen.queryByText("Next.js static exports")).not.toBeInTheDocument()

    rerender(<SessionSourcesPanel messages={[]} />)
    expect(screen.getByText("emptyTitle")).toBeInTheDocument()
    expect(screen.getByText("emptyDescription")).toBeInTheDocument()
  })

  it("keeps malformed and partial provider parts inspectable with safe fallbacks", () => {
    const circularInput: Record<string, unknown> = {}
    circularInput.self = circularInput
    const edgeMessages: UIMessage[] = [
      {
        id: "edge-1",
        role: "assistant",
        parts: [
          {
            type: "source-url",
            sourceId: "invalid-url",
            url: "not a valid URL",
          },
          {
            type: "file",
            url: "https://example.com/files/spec%20sheet.pdf",
            mediaType: "application/pdf",
          },
          {
            type: "file",
            url: "https://example.com/",
            mediaType: "application/octet-stream",
          },
          {
            type: "file",
            mediaType: "text/markdown",
          } as unknown as UIMessage["parts"][number],
          {
            type: "file",
          } as unknown as UIMessage["parts"][number],
          {
            type: "source-document",
            sourceId: "title-only",
            mediaType: "text/plain",
            title: "Title only",
          },
          {
            type: "source-document",
            sourceId: "source-id-only",
          } as unknown as UIMessage["parts"][number],
          {
            type: "source-document",
          } as unknown as UIMessage["parts"][number],
          {
            type: "sources",
            sources: [
              { id: "rag", title: "Twin chunk", origin: "twin-rag" },
              { id: "style", title: "Style sample", origin: "twin-style" },
              {
                id: "agent-knowledge",
                title: "Agent handbook",
                origin: "agent-knowledge-base",
              },
              {
                id: "note",
                title: "Linked footnote",
                origin: "footnote",
                url: "https://example.com/note",
              },
              {
                id: "provider-context",
                title: "Provider context",
                origin: "anthropic",
              },
            ],
          } as unknown as UIMessage["parts"][number],
          {
            type: "tool-read_file",
            state: "input-available",
            input: " ",
          } as unknown as UIMessage["parts"][number],
          {
            type: "dynamic-tool",
            toolCallId: "circular",
            state: "input-available",
            input: circularInput,
          } as unknown as UIMessage["parts"][number],
          {
            type: "tool-long_output",
            toolCallId: "long",
            state: "input-available",
            input: { value: "x".repeat(300) },
          } as unknown as UIMessage["parts"][number],
          {
            type: "tool-no_input",
            toolCallId: "no-input",
            state: "input-available",
            input: null,
          } as unknown as UIMessage["parts"][number],
        ],
      },
    ]

    render(<SessionSourcesPanel messages={edgeMessages} />)

    expect(screen.getByText("not a valid URL")).toBeInTheDocument()
    expect(screen.getByText("spec sheet.pdf")).toBeInTheDocument()
    expect(screen.getAllByText("application/octet-stream")).toHaveLength(2)
    expect(screen.getAllByText("text/markdown")).toHaveLength(2)
    expect(
      screen.getAllByText("labels.file").some((element) => element.classList.contains("truncate"))
    ).toBe(true)
    expect(screen.getByText("Title only")).toBeInTheDocument()
    expect(screen.getByText("source-id-only")).toBeInTheDocument()
    expect(
      screen
        .getAllByText("labels.document")
        .some((element) => element.classList.contains("truncate"))
    ).toBe(true)
    expect(screen.getByText("Twin chunk")).toBeInTheDocument()
    expect(screen.getByText("Style sample")).toBeInTheDocument()
    expect(screen.getByText("Agent handbook")).toBeInTheDocument()
    expect(screen.getByText("labels.agentKnowledge")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Linked footnote/ })).toBeInTheDocument()
    expect(screen.getByText("Provider context")).toBeInTheDocument()
    expect(screen.getByText("read_file")).toBeInTheDocument()
    expect(screen.getByText("dynamic-tool")).toBeInTheDocument()
    expect(screen.getByText("[object Object]")).toBeInTheDocument()
    expect(screen.getByText(/…$/)).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText("searchPlaceholder"), {
      target: { value: "definitely missing" },
    })
    expect(screen.getByText("noResultsTitle")).toBeInTheDocument()
    expect(screen.getByText("noResultsDescription")).toBeInTheDocument()
  })
})
