/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { UsageAttributionRow } from "./usage-attribution-row"

// next-intl is globally mocked against en.json in jest.setup.ts.

// The count-up animates toward its target, so pin it to the target for
// assertions rather than racing a timer.
jest.mock("@/hooks/usage/use-count-up", () => ({
  useCountUp: (value: number) => value,
}))

describe("UsageAttributionRow", () => {
  it("renders the share, the money and a bar named after the row", () => {
    render(
      <ul>
        <UsageAttributionRow
          id="chat"
          label="Chat"
          pct={42}
          costUsd={1.5}
          unpricedTurns={0}
          turns={10}
        />
      </ul>
    )
    const row = screen.getByTestId("usage-attribution-chat")
    expect(row).toHaveTextContent("42%")
    expect(row).toHaveTextContent("$1.50")
    expect(screen.getByRole("progressbar", { name: "Chat" })).toHaveAttribute("aria-valuenow", "42")
  })

  it("marks a partially unpriced bucket as a lower bound", () => {
    render(
      <ul>
        <UsageAttributionRow
          id="ocr"
          label="OCR"
          pct={5}
          costUsd={0.25}
          unpricedTurns={2}
          turns={10}
        />
      </ul>
    )
    expect(screen.getByTestId("usage-attribution-ocr")).toHaveTextContent("≥ $0.25")
  })

  it("shows no figure at all when every turn in the bucket is unpriced", () => {
    render(
      <ul>
        <UsageAttributionRow
          id="tts"
          label="Speech"
          pct={null}
          costUsd={0}
          unpricedTurns={4}
          turns={4}
        />
      </ul>
    )
    const row = screen.getByTestId("usage-attribution-tts")
    expect(row).not.toHaveTextContent("$0.00")
    expect(row).toHaveTextContent("—")
  })

  it("only renders the detail line when one is supplied", () => {
    const { rerender } = render(
      <ul>
        <UsageAttributionRow
          id="chat"
          label="Chat"
          pct={10}
          costUsd={1}
          unpricedTurns={0}
          turns={2}
        />
      </ul>
    )
    expect(screen.getByTestId("usage-attribution-chat")).not.toHaveTextContent("2 turns")

    rerender(
      <ul>
        <UsageAttributionRow
          id="chat"
          label="Chat"
          pct={10}
          costUsd={1}
          unpricedTurns={0}
          turns={2}
          detail="2 turns"
        />
      </ul>
    )
    expect(screen.getByTestId("usage-attribution-chat")).toHaveTextContent("2 turns")
  })

  it("lets the caller override the test id prefix so two lists can coexist", () => {
    render(
      <ul>
        <UsageAttributionRow
          id="chat"
          label="Chat"
          pct={1}
          costUsd={0}
          unpricedTurns={0}
          turns={1}
          testidPrefix="usage-surface-row"
        />
      </ul>
    )
    expect(screen.getByTestId("usage-surface-row-chat")).toBeInTheDocument()
  })
})
