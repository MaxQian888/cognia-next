/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { TerminalCommandMenu, formatDuration } from "./terminal-command-menu"

const base = {
  commandLine: "git status",
  exitCode: 0 as number | null,
  durationMs: 1500 as number | null,
  hasOutput: true,
  left: 10,
  top: 20,
  onRerun: jest.fn(),
  onCopyCommand: jest.fn(),
  onCopyOutput: jest.fn(),
  onCopyCommandAndOutput: jest.fn(),
  onClose: jest.fn(),
}

function renderMenu(over: Partial<typeof base> = {}) {
  const props = { ...base, ...over }
  render(<TerminalCommandMenu {...props} />)
  return props
}

beforeEach(() => jest.clearAllMocks())

describe("formatDuration", () => {
  const t = (key: string, values?: Record<string, string>) =>
    key === "commandMenu.durationMs" ? `${values?.value} ms` : `${values?.value} s`
  it("renders sub-second durations in ms", () => {
    expect(formatDuration(450, t)).toBe("450 ms")
  })
  it("renders >=1s durations in one-decimal seconds", () => {
    expect(formatDuration(1500, t)).toBe("1.5 s")
  })
})

describe("TerminalCommandMenu", () => {
  it("renders the action rows and duration", () => {
    renderMenu()
    expect(screen.getByTestId("terminal-command-menu")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-command-menu-duration")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-command-menu-rerun")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-command-menu-copy-output")).toBeInTheDocument()
  })

  it("fires rerun and closes", () => {
    const props = renderMenu()
    fireEvent.mouseDown(screen.getByTestId("terminal-command-menu-rerun"))
    expect(props.onRerun).toHaveBeenCalledTimes(1)
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it("disables copy-output when there is no output", () => {
    renderMenu({ hasOutput: false })
    expect(screen.getByTestId("terminal-command-menu-copy-output")).toBeDisabled()
  })

  it("disables rerun + copy-command when the command line is empty", () => {
    renderMenu({ commandLine: "   " })
    expect(screen.getByTestId("terminal-command-menu-rerun")).toBeDisabled()
    expect(screen.getByTestId("terminal-command-menu-copy-command")).toBeDisabled()
  })

  it("does not fire a disabled action", () => {
    const props = renderMenu({ hasOutput: false })
    fireEvent.mouseDown(screen.getByTestId("terminal-command-menu-copy-output"))
    expect(props.onCopyOutput).not.toHaveBeenCalled()
  })

  it("closes on Escape", () => {
    const props = renderMenu()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it("closes on backdrop click", () => {
    const props = renderMenu()
    fireEvent.mouseDown(screen.getByTestId("terminal-command-menu-backdrop"))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it("hides the duration when timings are unavailable", () => {
    renderMenu({ durationMs: null })
    expect(screen.queryByTestId("terminal-command-menu-duration")).not.toBeInTheDocument()
  })

  it("shows the running status while the exit code is unknown", () => {
    renderMenu({ exitCode: null })
    expect(screen.getByTestId("terminal-command-menu-status")).toHaveTextContent(
      "commandMenu.running"
    )
  })

  it("shows the failed status for a non-zero exit", () => {
    renderMenu({ exitCode: 1 })
    expect(screen.getByTestId("terminal-command-menu-status")).toHaveTextContent(
      "commandMenu.failed"
    )
  })
})
