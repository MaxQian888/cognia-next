import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TwinSourcePreviewDialog } from "./twin-source-preview-dialog"
import type { TwinSource } from "@/types/twin"

function makeSource(overrides: Partial<TwinSource> = {}): TwinSource {
  return {
    id: "tws_1",
    twinId: "twin_alice",
    kind: "document",
    format: "markdown",
    source: "",
    title: "Quarterly Report",
    bytes: 0,
    fingerprint: "fp",
    chunkCount: 0,
    status: "parsed",
    importedAt: 0,
    redacted: false,
    ...overrides,
  }
}

const MARKDOWN_WITH_TABLE = [
  "# Quarterly Report",
  "",
  "| Region | Revenue | Growth |",
  "| --- | --- | --- |",
  "| APAC | 1200 | 12 |",
  "| EMEA | 900 | 8 |",
  "",
  "Some closing prose.",
].join("\n")

describe("TwinSourcePreviewDialog", () => {
  it("renders tables detected in the source text", () => {
    render(
      <TwinSourcePreviewDialog
        source={makeSource({ source: MARKDOWN_WITH_TABLE })}
        open
        onOpenChange={() => {}}
      />
    )

    expect(screen.getByText(/Detected tables \(1\)/i)).toBeInTheDocument()
    const table = screen.getByRole("table")
    expect(within(table).getByText("Region")).toBeInTheDocument()
    expect(within(table).getByText("APAC")).toBeInTheDocument()
    expect(within(table).getByText("EMEA")).toBeInTheDocument()
    // 2 data rows × 3 columns; Revenue + Growth are numeric, Region is not.
    expect(screen.getByText(/2 rows .* 3 cols .* 2 numeric/i)).toBeInTheDocument()
    // The raw body is still rendered alongside the tables.
    expect(screen.getByTestId("twin-source-preview-body")).toHaveTextContent("Some closing prose.")
  })

  it("shows an empty state when the source has no tables", () => {
    render(
      <TwinSourcePreviewDialog
        source={makeSource({ source: "Just prose, no tables here." })}
        open
        onOpenChange={() => {}}
      />
    )

    expect(screen.getByText(/No tables detected/i)).toBeInTheDocument()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
    expect(screen.getByTestId("twin-source-preview-body")).toHaveTextContent("Just prose")
  })

  it("copies a detected table to the clipboard as Markdown", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })

    render(
      <TwinSourcePreviewDialog
        source={makeSource({ source: MARKDOWN_WITH_TABLE })}
        open
        onOpenChange={() => {}}
      />
    )
    await userEvent.click(screen.getByTestId("twin-source-preview-copy-0"))

    expect(writeText).toHaveBeenCalledTimes(1)
    const md = writeText.mock.calls[0][0] as string
    expect(md).toContain("| Region | Revenue | Growth |")
    expect(md).toContain("| APAC | 1200 | 12 |")
    expect(await screen.findByText(/Copied/i)).toBeInTheDocument()
  })

  it("swallows a clipboard failure without surfacing 'Copied'", async () => {
    const writeText = jest.fn().mockRejectedValue(new Error("denied"))
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })

    render(
      <TwinSourcePreviewDialog
        source={makeSource({ source: MARKDOWN_WITH_TABLE })}
        open
        onOpenChange={() => {}}
      />
    )
    await userEvent.click(screen.getByTestId("twin-source-preview-copy-0"))

    expect(writeText).toHaveBeenCalledTimes(1)
    // The catch keeps the button in its default state — no "Copied" flash.
    expect(screen.queryByText(/Copied/i)).not.toBeInTheDocument()
  })

  it("does not throw when the clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true })

    render(
      <TwinSourcePreviewDialog
        source={makeSource({ source: MARKDOWN_WITH_TABLE })}
        open
        onOpenChange={() => {}}
      />
    )
    await userEvent.click(screen.getByTestId("twin-source-preview-copy-0"))

    // Optional-chained call short-circuits: no throw, and the success flash still
    // shows since nothing rejected.
    expect(await screen.findByText(/Copied/i)).toBeInTheDocument()
  })

  it("renders nothing to preview while closed", () => {
    render(
      <TwinSourcePreviewDialog
        source={makeSource({ source: MARKDOWN_WITH_TABLE })}
        open={false}
        onOpenChange={() => {}}
      />
    )

    expect(screen.queryByRole("table")).not.toBeInTheDocument()
    expect(screen.queryByTestId("twin-source-preview-tables")).not.toBeInTheDocument()
  })

  it("caps a very long source body and flags the truncation", () => {
    render(
      <TwinSourcePreviewDialog
        source={makeSource({ source: "x".repeat(25_000) })}
        open
        onOpenChange={() => {}}
      />
    )

    expect(screen.getByText(/Showing the first 20000 characters/i)).toBeInTheDocument()
    expect((screen.getByTestId("twin-source-preview-body").textContent ?? "").length).toBe(20_000)
  })

  it("caps rendered table rows and notes how many were hidden", () => {
    const dataRows = Array.from({ length: 60 }, (_, i) => `| r${i} | ${i} |`).join("\n")
    const bigTable = ["| A | B |", "| --- | --- |", dataRows].join("\n")

    render(
      <TwinSourcePreviewDialog
        source={makeSource({ source: bigTable })}
        open
        onOpenChange={() => {}}
      />
    )

    // 60 data rows, capped at 50 → 10 hidden.
    expect(screen.getByText(/\+10 more rows/i)).toBeInTheDocument()
  })
})
