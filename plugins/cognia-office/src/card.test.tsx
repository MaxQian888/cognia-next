/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"
import { registerPluginI18n, unregisterPluginI18n } from "@cognia/plugin-sdk/api/i18n"

import manifestJson from "../plugin.json"
import { createWorkbookResultCard, OFFICE_PLUGIN_ID } from "./card"

const LOCALES = manifestJson.i18n.locales as Record<string, Record<string, string>>

function part(output: unknown, tool = "office_create_workbook"): ToolUIPart {
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
    pluginId: OFFICE_PLUGIN_ID,
    messages: Object.fromEntries(
      Object.entries(LOCALES).map(([locale, messages]) => [
        locale,
        Object.fromEntries(
          Object.entries(messages).map(([key, value]) => [
            `plugin.${OFFICE_PLUGIN_ID}.${key}`,
            value,
          ])
        ),
      ])
    ),
  })
})

afterAll(() => unregisterPluginI18n(OFFICE_PLUGIN_ID))

describe("WorkbookResultCard", () => {
  it("renders the summary title, sheet count, version, and findings badges", () => {
    const Card = createWorkbookResultCard({ openArtifact: jest.fn() })
    render(
      <Card
        part={part({
          ok: true,
          artifactId: "a1",
          version: 2,
          summary: { title: "Budget", sheets: [{ title: "Q1" }, { title: "Q2" }] },
          findings: [{ severity: "error" }, { severity: "warning" }],
        })}
      />
    )
    expect(screen.getByTestId("workbook-result-card")).toBeInTheDocument()
    expect(screen.getByTestId("workbook-result-title")).toHaveTextContent("Budget")
    expect(screen.getByTestId("workbook-result-sheets")).toHaveTextContent("Sheets: 2")
    expect(screen.getByText("v2")).toBeInTheDocument()
    expect(screen.getByText("Errors: 1")).toBeInTheDocument()
    expect(screen.getByText("Warnings: 1")).toBeInTheDocument()
  })

  it("describes reads, version lists, exports, confirmations, and Lark syncs", () => {
    const Card = createWorkbookResultCard()
    const { rerender } = render(
      <Card
        part={part(
          { ok: true, artifactId: "a1", title: "Budget", cellsReturned: 40, truncated: true },
          "office_read_range"
        )}
      />
    )
    expect(screen.getByTestId("workbook-result-read")).toHaveTextContent("Cells read: 40")
    expect(screen.getByText("Truncated")).toBeInTheDocument()

    rerender(
      <Card
        part={part(
          { ok: true, artifactId: "a1", currentVersion: 3, versions: [{}, {}] },
          "office_list_versions"
        )}
      />
    )
    expect(screen.getByTestId("workbook-result-versions")).toHaveTextContent("Versions: 2")
    expect(screen.getByText("v3")).toBeInTheDocument()

    rerender(
      <Card
        part={part(
          { ok: true, saved: true, artifactId: "a1", byteLength: 4096 },
          "office_export_xlsx"
        )}
      />
    )
    expect(screen.getByTestId("workbook-result-exported")).toHaveTextContent("Exported 4.0 KB")

    rerender(
      <Card
        part={part(
          { ok: false, artifactId: "a1", requiresConfirmation: true, byteLength: 4096 },
          "office_export_xlsx"
        )}
      />
    )
    expect(screen.queryByTestId("workbook-result-exported")).toBeNull()
    expect(screen.getByText("Needs confirmation")).toBeInTheDocument()

    rerender(<Card part={part({ ok: true, artifactId: "a1" }, "office_sync_lark")} />)
    expect(screen.getByTestId("workbook-result-synced")).toHaveTextContent("Synced to Lark Sheets")
  })

  it("invokes the bound open action with a touch-sized button", () => {
    const openArtifact = jest.fn()
    const Card = createWorkbookResultCard({ openArtifact })
    render(<Card part={part({ ok: true, artifactId: "a7" })} />)
    const open = screen.getByTestId("workbook-result-open")
    expect(open.className).toContain("h-9")
    fireEvent.click(open)
    expect(openArtifact).toHaveBeenCalledWith("a7")
  })

  it("says the call is still running before any output arrives", () => {
    const Card = createWorkbookResultCard()
    render(
      <Card
        part={
          {
            type: "tool-office_create_workbook",
            state: "input-available",
            input: {},
          } as unknown as ToolUIPart
        }
      />
    )
    expect(screen.getByTestId("workbook-result-card-status")).toHaveTextContent("Working…")
  })

  it("reports a thrown tool error with its detail", () => {
    const Card = createWorkbookResultCard()
    render(
      <Card
        part={
          {
            type: "tool-office_create_workbook",
            state: "output-error",
            input: {},
            errorText: "artifact version conflict",
          } as unknown as ToolUIPart
        }
      />
    )
    const status = screen.getByTestId("workbook-result-card-status")
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
    const Card = createWorkbookResultCard({ openArtifact: jest.fn() })
    render(<Card part={part(output)} />)
    expect(screen.getByTestId("workbook-result-card-status")).toHaveTextContent(message)
    expect(screen.queryByRole("button")).toBeNull()
  })
})
