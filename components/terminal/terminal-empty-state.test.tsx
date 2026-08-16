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

  it("offers the action on the mobile variant too — ws spawns are real", () => {
    const onNew = jest.fn()
    render(<TerminalEmptyState variant="mobile" onNew={onNew} />)
    expect(screen.getByTestId("terminal-empty-state").getAttribute("data-variant")).toBe("mobile")
    fireEvent.click(screen.getByTestId("terminal-empty-state-new"))
    expect(onNew).toHaveBeenCalled()
  })

  it("renders the remote variant for a desktop driving a remote host", () => {
    const onNew = jest.fn()
    render(<TerminalEmptyState variant="remote" onNew={onNew} />)
    expect(screen.getByTestId("terminal-empty-state").getAttribute("data-variant")).toBe("remote")
    expect(screen.getByTestId("terminal-empty-state-new")).toBeInTheDocument()
  })

  it("renders the cloud variant for a browser paired to a cognia-server", () => {
    const onNew = jest.fn()
    render(<TerminalEmptyState variant="cloud" onNew={onNew} />)
    expect(screen.getByTestId("terminal-empty-state").getAttribute("data-variant")).toBe("cloud")
    fireEvent.click(screen.getByTestId("terminal-empty-state-new"))
    expect(onNew).toHaveBeenCalled()
  })

  it("renders the unsupported variant", () => {
    render(<TerminalEmptyState variant="unsupported" />)
    expect(screen.getByTestId("terminal-empty-state").getAttribute("data-variant")).toBe(
      "unsupported"
    )
  })

  it("never offers an action for the unsupported variant, because the dock passes no onNew", () => {
    // Gating is on `onNew`, not the variant: the dock only supplies it when
    // `canSpawn` is true, which `unsupported` never is.
    render(<TerminalEmptyState variant="unsupported" />)
    expect(screen.queryByTestId("terminal-empty-state-new")).toBeNull()
  })
})
