/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"
import { registerPluginI18n, unregisterPluginI18n } from "@cognia/plugin-sdk/api/i18n"

import manifestJson from "../plugin.json"
import { createDocumentResultCard, DOCUMENTS_PLUGIN_ID } from "./card"

const LOCALES = manifestJson.i18n.locales as Record<string, Record<string, string>>

function part(output: unknown, tool = "documents_create"): ToolUIPart {
  return {
    type: `tool-${tool}`,
    state: "output-available",
    input: {},
    output,
  } as unknown as ToolUIPart
}

beforeAll(() => {
  // What the plugin manager does with plugin.json's `i18n.locales` on enable.
  registerPluginI18n({
    pluginId: DOCUMENTS_PLUGIN_ID,
    messages: Object.fromEntries(
      Object.entries(LOCALES).map(([locale, messages]) => [
        locale,
        Object.fromEntries(
          Object.entries(messages).map(([key, value]) => [
            `plugin.${DOCUMENTS_PLUGIN_ID}.${key}`,
            value,
          ])
        ),
      ])
    ),
  })
})

afterAll(() => unregisterPluginI18n(DOCUMENTS_PLUGIN_ID))

describe("DocumentResultCard", () => {
  it("renders the summary, review counts, version, flattening, and findings", () => {
    const Card = createDocumentResultCard({ openArtifact: jest.fn() })
    render(
      <Card
        part={part({
          ok: true,
          artifactId: "d1",
          version: 4,
          summary: {
            title: "Brief",
            blockCount: 12,
            comments: { open: 2, resolved: 1 },
            changes: { pending: 3, accepted: 0 },
          },
          conversionNotes: ['Links were kept as "text (url)".'],
          findings: [{ severity: "warning" }],
        })}
      />
    )
    expect(screen.getByTestId("document-result-title")).toHaveTextContent("Brief")
    expect(screen.getByTestId("document-result-blocks")).toHaveTextContent("Blocks: 12")
    expect(screen.getByTestId("document-result-comments")).toHaveTextContent("Open comments: 2")
    expect(screen.getByTestId("document-result-changes")).toHaveTextContent("Pending changes: 3")
    expect(screen.getByText("v4")).toBeInTheDocument()
    expect(screen.getByText("Formatting flattened")).toBeInTheDocument()
    expect(screen.getByText("Warnings: 1")).toBeInTheDocument()
    expect(screen.queryByText(/Errors:/)).toBeNull()
  })

  it("reads counts from inspect and read_markdown payloads", () => {
    const Card = createDocumentResultCard()
    render(
      <Card
        part={part(
          {
            ok: true,
            artifactId: "d1",
            title: "Memo",
            comments: [{ resolved: false }, { resolved: true }],
            changes: [{ accepted: false }],
          },
          "documents_read_markdown"
        )}
      />
    )
    expect(screen.getByTestId("document-result-title")).toHaveTextContent("Memo")
    expect(screen.getByTestId("document-result-comments")).toHaveTextContent("Open comments: 1")
    expect(screen.getByTestId("document-result-changes")).toHaveTextContent("Pending changes: 1")
  })

  it("shows saved transcripts without an open action, and export sizes only when written", () => {
    const Card = createDocumentResultCard({ openArtifact: jest.fn() })
    const { rerender } = render(
      <Card
        part={part(
          { ok: true, saved: true, filename: "chat.docx", byteLength: 2048 },
          "documents_export_transcript"
        )}
      />
    )
    expect(screen.getByTestId("document-result-title")).toHaveTextContent("chat.docx")
    expect(screen.getByTestId("document-result-exported")).toHaveTextContent("Exported 2.0 KB")
    expect(screen.queryByTestId("document-result-open")).toBeNull()

    rerender(
      <Card
        part={part(
          { ok: false, artifactId: "d1", requiresConfirmation: true, byteLength: 10 },
          "documents_export_docx"
        )}
      />
    )
    expect(screen.queryByTestId("document-result-exported")).toBeNull()
    expect(screen.getByText("Needs confirmation")).toBeInTheDocument()
  })

  it("invokes the bound open action", () => {
    const openArtifact = jest.fn()
    const Card = createDocumentResultCard({ openArtifact })
    render(<Card part={part({ ok: true, artifactId: "d9", versions: [{}], currentVersion: 2 })} />)
    expect(screen.getByTestId("document-result-versions")).toHaveTextContent("Versions: 1")
    fireEvent.click(screen.getByTestId("document-result-open"))
    expect(openArtifact).toHaveBeenCalledWith("d9")
  })

  it("says the call is still running before any output arrives", () => {
    const Card = createDocumentResultCard()
    render(
      <Card
        part={
          {
            type: "tool-documents_create",
            state: "input-available",
            input: {},
          } as unknown as ToolUIPart
        }
      />
    )
    expect(screen.getByTestId("document-result-card-status")).toHaveTextContent("Working…")
  })

  it("reports a thrown tool error with its detail", () => {
    const Card = createDocumentResultCard()
    render(
      <Card
        part={
          {
            type: "tool-documents_create",
            state: "output-error",
            input: {},
            errorText: "artifact version conflict",
          } as unknown as ToolUIPart
        }
      />
    )
    const status = screen.getByTestId("document-result-card-status")
    expect(status).toHaveAttribute("role", "alert")
    expect(status).toHaveTextContent("The tool did not finish.")
    expect(screen.getByText("artifact version conflict")).toBeInTheDocument()
  })

  it.each([
    [
      "a cancelled result",
      { ok: false, cancelled: true, artifactId: "a1" },
      "Cancelled — nothing was saved.",
    ],
    ["an unparseable payload", "not json", "This result could not be read."],
    [
      "a failure without an artifact",
      { ok: false, error: "needs a session" },
      "The tool did not finish.",
    ],
  ])("owns the empty state for %s", (_label, output, message) => {
    const Card = createDocumentResultCard({ openArtifact: jest.fn() })
    render(<Card part={part(output)} />)
    expect(screen.getByTestId("document-result-card-status")).toHaveTextContent(message)
    expect(screen.queryByRole("button")).toBeNull()
  })
})
