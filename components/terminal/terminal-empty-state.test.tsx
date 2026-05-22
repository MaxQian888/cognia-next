/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { TerminalEmptyState } from "./terminal-empty-state"

describe("TerminalEmptyState", () => {
  it("renders the desktop variant with a + New action when onNew is provided", () => {
    const onNew = jest.fn()
    render(<TerminalEmptyState variant="desktop" onNew={onNew} />)
    expect(screen.getByTestId("terminal-empty-state").getAttribute("data-variant")).toBe("desktop")
    fireEvent.click(screen.getByTestId("terminal-empty-state-new"))
    expect(onNew).toHaveBeenCalled()
  })

  it("renders the desktop variant WITHOUT the action when onNew is absent", () => {
    render(<TerminalEmptyState variant="desktop" />)
    expect(screen.queryByTestId("terminal-empty-state-new")).toBeNull()
  })

  it("renders the mobile variant (no spawn button — LAN-only path is task #14)", () => {
    render(<TerminalEmptyState variant="mobile" onNew={() => undefined} />)
    expect(screen.queryByTestId("terminal-empty-state-new")).toBeNull()
  })

  it("renders the unsupported variant", () => {
    render(<TerminalEmptyState variant="unsupported" />)
    expect(screen.getByTestId("terminal-empty-state").getAttribute("data-variant")).toBe(
      "unsupported"
    )
  })
})
