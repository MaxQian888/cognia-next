/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

const copyMock = jest.fn(async () => true)
jest.mock("@/hooks/ui/use-copy", () => ({
  useCopy: () => ({ copied: false, copy: copyMock }),
}))

import { CLIPBOARD_PREVIEW_ENTRIES, ClipboardHistoryCard } from "./clipboard-history-card"

const part = (output: unknown): ToolUIPart =>
  ({
    type: "tool-clipboard_history_list",
    state: "output-available",
    input: {},
    output,
  }) as unknown as ToolUIPart

describe("ClipboardHistoryCard", () => {
  beforeEach(() => copyMock.mockClear())

  it("renders entries newest-first with a copy button each and a count badge", () => {
    const now = Date.now()
    render(
      <ClipboardHistoryCard
        part={part({
          ok: true,
          entries: [
            { text: "older", capturedAt: now - 120_000 },
            { text: "newest", capturedAt: now - 1_000 },
          ],
        })}
      />
    )
    expect(screen.getByTestId("clipboard-history-card-badge")).toHaveTextContent("2 entries")
    const items = screen.getByTestId("clipboard-history-entries").querySelectorAll("li")
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent("newest")
    expect(items[1]).toHaveTextContent("older")
    fireEvent.click(items[1].querySelector("button")!)
    expect(copyMock).toHaveBeenCalledWith("older")
  })

  it("collapses long lists behind a show-all toggle", () => {
    const entries = Array.from({ length: CLIPBOARD_PREVIEW_ENTRIES + 3 }, (_, i) => ({
      text: `entry ${i}`,
      capturedAt: 1_700_000_000_000 + i,
    }))
    render(<ClipboardHistoryCard part={part({ ok: true, entries })} />)
    expect(screen.getByTestId("clipboard-history-entries").querySelectorAll("li")).toHaveLength(
      CLIPBOARD_PREVIEW_ENTRIES
    )
    fireEvent.click(screen.getByTestId("clipboard-history-toggle"))
    expect(screen.getByTestId("clipboard-history-entries").querySelectorAll("li")).toHaveLength(
      entries.length
    )
  })

  it("shows the empty state and declines payloads without entries", () => {
    render(<ClipboardHistoryCard part={part(JSON.stringify({ ok: true, entries: [] }))} />)
    expect(screen.getByText("No clipboard entries yet.")).toBeInTheDocument()
    const { container } = render(<ClipboardHistoryCard part={part({ ok: true })} />)
    expect(container).toBeEmptyDOMElement()
  })
})
