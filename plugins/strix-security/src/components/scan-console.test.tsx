/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useLocale: () => "en" }))

import { ScanConsole } from "./scan-console"

describe("ScanConsole", () => {
  it("shows the empty state until output streams in", () => {
    render(<ScanConsole text="" />)
    expect(screen.queryByTestId("strix-console")).not.toBeInTheDocument()
    expect(screen.getByText(/stream here/i)).toBeInTheDocument()
  })

  it("renders streamed output and stays pinned to the bottom", () => {
    const { rerender } = render(<ScanConsole text="line1" />)
    const pre = screen.getByTestId("strix-console")
    expect(pre).toHaveTextContent("line1")
    // jsdom has no layout; scrollHeight is 0, scrollTop stays 0 — the point is
    // that updating text does not throw and keeps the element mounted.
    rerender(<ScanConsole text="line1\nline2" />)
    expect(pre).toHaveTextContent("line2")
  })

  it("stops following output when the reader scrolls up", () => {
    const { rerender } = render(<ScanConsole text="a" />)
    const pre = screen.getByTestId("strix-console")
    // Simulate "not at the bottom": scrollHeight > scrollTop + clientHeight.
    Object.defineProperty(pre, "scrollHeight", { value: 1000, configurable: true })
    Object.defineProperty(pre, "clientHeight", { value: 100, configurable: true })
    fireEvent.scroll(pre, { target: { scrollTop: 0 } })

    rerender(<ScanConsole text={"a\nb"} />)
    expect(pre.scrollTop).toBe(0)

    // Scrolling back to the bottom re-pins.
    fireEvent.scroll(pre, { target: { scrollTop: 950 } })
    rerender(<ScanConsole text={"a\nb\nc"} />)
    expect(pre.scrollTop).toBe(1000)
  })

  it("notes when earlier output was dropped", () => {
    render(<ScanConsole text="tail" truncated />)
    expect(screen.getByTestId("strix-console-truncated")).toBeInTheDocument()
  })

  it("shows no truncation note while the whole stream fits", () => {
    render(<ScanConsole text="all" />)
    expect(screen.queryByTestId("strix-console-truncated")).not.toBeInTheDocument()
  })
})
