import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MAX_PREVIEW_CHARS, SourceContentPreview } from "./source-content-preview"

const MARKDOWN_WITH_TABLE = [
  "# Report",
  "",
  "| Region | Revenue |",
  "| --- | --- |",
  "| APAC | 1200 |",
  "",
  "Closing prose.",
].join("\n")

describe("SourceContentPreview", () => {
  it("renders detected tables and the body when active", () => {
    render(<SourceContentPreview text={MARKDOWN_WITH_TABLE} active />)
    expect(screen.getByText(/Detected tables \(1\)/i)).toBeInTheDocument()
    const table = screen.getByRole("table")
    expect(within(table).getByText("APAC")).toBeInTheDocument()
    expect(screen.getByTestId("twin-source-preview-body")).toHaveTextContent("Closing prose.")
  })

  it("skips table extraction while inactive", () => {
    render(<SourceContentPreview text={MARKDOWN_WITH_TABLE} active={false} />)
    expect(screen.getByText(/Detected tables \(0\)/i)).toBeInTheDocument()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })

  it("truncates oversized bodies and says so", () => {
    const big = "x".repeat(MAX_PREVIEW_CHARS + 500)
    render(<SourceContentPreview text={big} active />)
    const body = screen.getByTestId("twin-source-preview-body")
    expect(body.textContent?.length).toBe(MAX_PREVIEW_CHARS)
    expect(screen.getByText(/first .* characters/i)).toBeInTheDocument()
  })

  it("caps rendered rows and reports the hidden remainder", () => {
    const rows = Array.from({ length: 60 }, (_, i) => `| r${i} | ${i} |`).join("\n")
    const big = `| A | B |\n| --- | --- |\n${rows}`
    render(<SourceContentPreview text={big} active />)
    expect(screen.getByText(/more rows/i)).toBeInTheDocument()
  })

  it("survives a clipboard failure silently", async () => {
    const writeText = jest.fn().mockRejectedValue(new Error("denied"))
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })
    render(<SourceContentPreview text={MARKDOWN_WITH_TABLE} active />)
    fireEvent.click(screen.getByTestId("twin-source-preview-copy-0"))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    // No crash and no "Copied" confirmation.
    expect(screen.queryByText(/^copied$/i)).not.toBeInTheDocument()
  })

  it("copies a table as markdown", async () => {
    // Plain fireEvent — userEvent.setup() installs its own clipboard stub
    // that would shadow this mock.
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })
    render(<SourceContentPreview text={MARKDOWN_WITH_TABLE} active />)

    fireEvent.click(screen.getByTestId("twin-source-preview-copy-0"))

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("| Region | Revenue |"))
    expect(await screen.findByText(/Copied/i)).toBeInTheDocument()
  })
})
