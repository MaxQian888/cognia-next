/**
 * @jest-environment jsdom
 */

import { createRef } from "react"
import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { TerminalSearchOverlay } from "./terminal-search-overlay"
import type { TerminalInstanceHandle } from "./terminal-instance"

function makeHandle(overrides: Partial<TerminalInstanceHandle> = {}): TerminalInstanceHandle {
  return {
    findNext: jest.fn(() => true),
    findPrevious: jest.fn(() => true),
    clearSearch: jest.fn(),
    clearScreen: jest.fn(),
    jumpToPrevCommand: jest.fn(),
    jumpToNextCommand: jest.fn(),
    copySelection: jest.fn(async () => undefined),
    pasteFromClipboard: jest.fn(async () => undefined),
    selectAll: jest.fn(),
    resetZoom: jest.fn(),
    ...overrides,
  }
}

describe("TerminalSearchOverlay", () => {
  it("renders nothing when closed", () => {
    const ref = createRef<TerminalInstanceHandle | null>()
    const { container } = render(
      <TerminalSearchOverlay open={false} onClose={jest.fn()} instanceRef={ref} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders input + nav buttons when open", () => {
    const handle = makeHandle()
    const ref = { current: handle } as React.RefObject<TerminalInstanceHandle | null>
    render(<TerminalSearchOverlay open onClose={jest.fn()} instanceRef={ref} />)
    expect(screen.getByTestId("terminal-search-input")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-search-next")).toBeInTheDocument()
    expect(screen.getByTestId("terminal-search-prev")).toBeInTheDocument()
  })

  it("Enter triggers findNext with current pattern", () => {
    const handle = makeHandle()
    const ref = { current: handle } as React.RefObject<TerminalInstanceHandle | null>
    render(<TerminalSearchOverlay open onClose={jest.fn()} instanceRef={ref} />)
    const input = screen.getByTestId("terminal-search-input") as HTMLInputElement
    fireEvent.change(input, { target: { value: "hello" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(handle.findNext).toHaveBeenCalledWith("hello", false)
  })

  it("Shift+Enter triggers findPrevious", () => {
    const handle = makeHandle()
    const ref = { current: handle } as React.RefObject<TerminalInstanceHandle | null>
    render(<TerminalSearchOverlay open onClose={jest.fn()} instanceRef={ref} />)
    const input = screen.getByTestId("terminal-search-input") as HTMLInputElement
    fireEvent.change(input, { target: { value: "world" } })
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
    expect(handle.findPrevious).toHaveBeenCalledWith("world", false)
  })

  it("Escape calls onClose", () => {
    const onClose = jest.fn()
    const handle = makeHandle()
    const ref = { current: handle } as React.RefObject<TerminalInstanceHandle | null>
    render(<TerminalSearchOverlay open onClose={onClose} instanceRef={ref} />)
    fireEvent.keyDown(screen.getByTestId("terminal-search-input"), { key: "Escape" })
    expect(onClose).toHaveBeenCalled()
  })

  it("case-sensitive toggle flips the flag passed to findNext", () => {
    const handle = makeHandle()
    const ref = { current: handle } as React.RefObject<TerminalInstanceHandle | null>
    render(<TerminalSearchOverlay open onClose={jest.fn()} instanceRef={ref} />)
    fireEvent.click(screen.getByTestId("terminal-search-case"))
    fireEvent.change(screen.getByTestId("terminal-search-input"), { target: { value: "X" } })
    fireEvent.click(screen.getByTestId("terminal-search-next"))
    expect(handle.findNext).toHaveBeenCalledWith("X", true)
  })

  it("shows error styling when findNext returns false", () => {
    const handle = makeHandle({ findNext: jest.fn(() => false) })
    const ref = { current: handle } as React.RefObject<TerminalInstanceHandle | null>
    render(<TerminalSearchOverlay open onClose={jest.fn()} instanceRef={ref} />)
    fireEvent.change(screen.getByTestId("terminal-search-input"), { target: { value: "nope" } })
    fireEvent.keyDown(screen.getByTestId("terminal-search-input"), { key: "Enter" })
    expect(screen.getByTestId("terminal-search-input").className).toContain("border-red-500")
  })

  it("close button triggers onClose", () => {
    const onClose = jest.fn()
    const handle = makeHandle()
    const ref = { current: handle } as React.RefObject<TerminalInstanceHandle | null>
    render(<TerminalSearchOverlay open onClose={onClose} instanceRef={ref} />)
    fireEvent.click(screen.getByTestId("terminal-search-close"))
    expect(onClose).toHaveBeenCalled()
  })

  it("clears decorations when transitioning closed", () => {
    const handle = makeHandle()
    const ref = { current: handle } as React.RefObject<TerminalInstanceHandle | null>
    const { rerender } = render(
      <TerminalSearchOverlay open onClose={jest.fn()} instanceRef={ref} />
    )
    rerender(<TerminalSearchOverlay open={false} onClose={jest.fn()} instanceRef={ref} />)
    expect(handle.clearSearch).toHaveBeenCalled()
  })
})
