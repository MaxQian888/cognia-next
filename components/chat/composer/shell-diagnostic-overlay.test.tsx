import { render, screen } from "@testing-library/react"

import { ShellDiagnosticOverlay, sliceDiagnostics } from "./shell-diagnostic-overlay"
import type { ShellDiagnostic } from "@/lib/shell-intelligence/types"

const diagnostic = (over: Partial<ShellDiagnostic> = {}): ShellDiagnostic => ({
  from: 0,
  to: 3,
  severity: "warning",
  code: "command-not-found",
  message: "Command not found: abc",
  ...over,
})

describe("sliceDiagnostics", () => {
  it("splits the value into plain and underlined runs", () => {
    const pieces = sliceDiagnostics("!abc def", [diagnostic({ from: 1, to: 4 })])
    expect(pieces.map((p) => [p.text, p.diagnostic !== null])).toEqual([
      ["!", false],
      ["abc", true],
      [" def", false],
    ])
  })

  it("clamps a range that runs past the current value", () => {
    const pieces = sliceDiagnostics("!ab", [diagnostic({ from: 1, to: 99 })])
    expect(pieces.map((p) => p.text)).toEqual(["!", "ab"])
  })

  it("drops a range that overlaps one already drawn", () => {
    const pieces = sliceDiagnostics("!abcdef", [
      diagnostic({ from: 1, to: 4 }),
      diagnostic({ from: 2, to: 6 }),
    ])
    expect(pieces.filter((p) => p.diagnostic)).toHaveLength(1)
  })

  it("drops an empty range rather than emitting a zero-width run", () => {
    expect(sliceDiagnostics("!ab", [diagnostic({ from: 2, to: 2 })])).toEqual([
      { text: "!ab", diagnostic: null },
    ])
  })

  it("orders out-of-order ranges", () => {
    const pieces = sliceDiagnostics("!abc def", [
      diagnostic({ from: 5, to: 8 }),
      diagnostic({ from: 1, to: 4 }),
    ])
    expect(pieces.filter((p) => p.diagnostic).map((p) => p.text)).toEqual(["abc", "def"])
  })
})

describe("ShellDiagnosticOverlay", () => {
  const setup = (diagnostics: ShellDiagnostic[], value = "!abc def") =>
    render(
      <ShellDiagnosticOverlay
        value={value}
        diagnostics={diagnostics}
        statusLabel="Shell command problems"
      />
    )

  it("underlines only the diagnostic's span", () => {
    setup([diagnostic({ from: 1, to: 4 })])
    const overlay = screen.getByTestId("shell-diagnostic-overlay")
    const marked = overlay.querySelector("[data-diagnostic]")
    expect(marked).toHaveTextContent("abc")
    expect(marked).toHaveAttribute("data-diagnostic", "command-not-found")
    expect(overlay).toHaveTextContent("!abc def")
  })

  it("distinguishes an error from a warning", () => {
    setup([diagnostic({ severity: "error", code: "shell-unavailable", from: 0, to: 8 })])
    expect(
      screen.getByTestId("shell-diagnostic-overlay").querySelector("[data-severity]")
    ).toHaveAttribute("data-severity", "error")
  })

  it("hides the decoration from assistive tech and reports the message instead", () => {
    setup([diagnostic({ from: 1, to: 4 })])
    expect(screen.getByTestId("shell-diagnostic-overlay")).toHaveAttribute("aria-hidden", "true")
    const status = screen.getByRole("status")
    expect(status).toHaveTextContent("Command not found: abc")
    expect(status).toHaveAttribute("aria-live", "polite")
    expect(status).toHaveAccessibleName("Shell command problems")
  })

  it("reports every problem, not only the first", () => {
    setup([
      diagnostic({ from: 1, to: 4, message: "one" }),
      diagnostic({ from: 5, to: 8, message: "two" }),
    ])
    const status = screen.getByRole("status")
    expect(status).toHaveTextContent("one")
    expect(status).toHaveTextContent("two")
  })

  it("paints nothing but stays mounted when there is nothing wrong", () => {
    setup([])
    const overlay = screen.getByTestId("shell-diagnostic-overlay")
    expect(overlay.querySelector("[data-diagnostic]")).toBeNull()
    expect(screen.getByRole("status")).toBeEmptyDOMElement()
  })

  it("stands down while another layer is painting the same glyphs", () => {
    render(
      <ShellDiagnosticOverlay
        value="!abc"
        diagnostics={[diagnostic({ from: 1, to: 4 })]}
        statusLabel="x"
        hidden
      />
    )
    expect(screen.getByTestId("shell-diagnostic-overlay")).toHaveClass("invisible")
  })

  it("forwards the inner ref so the parent can mirror the textarea's scroll", () => {
    const ref = { current: null as HTMLDivElement | null }
    render(
      <ShellDiagnosticOverlay
        ref={ref}
        value="!abc"
        diagnostics={[diagnostic({ from: 1, to: 4 })]}
        statusLabel="x"
      />
    )
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  it("keeps the textarea's wrap width, or every underline drifts off its word", () => {
    render(
      <ShellDiagnosticOverlay
        value="!abc"
        diagnostics={[diagnostic({ from: 1, to: 4 })]}
        statusLabel="x"
        mono
        padEndClass="pe-14"
      />
    )
    const inner = screen.getByTestId("shell-diagnostic-overlay").firstElementChild
    expect(inner).toHaveClass("pe-14")
    expect(inner).toHaveClass("font-mono")
    expect(inner).toHaveClass("whitespace-pre-wrap")
  })
})
