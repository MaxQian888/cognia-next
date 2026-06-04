/**
 * @jest-environment jsdom
 */

import { forwardRef, useImperativeHandle } from "react"
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Stub the heavy xterm-backed instance with a forwardRef component that
// exposes a dummy imperative handle, so the pane group's handle plumbing
// (callback ref → onFocusedChange) is exercised without loading xterm.
const fakeHandle = {
  findNext: jest.fn(() => true),
  findPrevious: jest.fn(() => true),
  clearSearch: jest.fn(),
  clearScreen: jest.fn(),
  copySelection: jest.fn(async () => undefined),
  pasteFromClipboard: jest.fn(async () => undefined),
}
jest.mock("./terminal-instance", () => ({
  TerminalInstance: forwardRef<unknown, { sessionId: string }>(function MockInstance(
    { sessionId },
    ref
  ) {
    useImperativeHandle(ref, () => fakeHandle, [])
    return <div data-testid="mock-instance" data-session-id={sessionId} />
  }),
}))

// Passthrough the resizable primitives so we don't depend on
// react-resizable-panels' layout behaviour in jsdom.
jest.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    className,
    "data-testid": testId,
    "data-panes": panes,
  }: {
    children: React.ReactNode
    className?: string
    "data-testid"?: string
    "data-panes"?: string
  }) => (
    <div className={className} data-testid={testId} data-panes={panes}>
      {children}
    </div>
  ),
  ResizablePanel: ({
    children,
    defaultSize,
    minSize,
  }: {
    children: React.ReactNode
    defaultSize?: number | string
    minSize?: number | string
  }) => (
    <div
      data-testid="resizable-panel"
      data-default-size={defaultSize === undefined ? undefined : String(defaultSize)}
      data-min-size={minSize === undefined ? undefined : String(minSize)}
    >
      {children}
    </div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}))

import { TerminalPaneGroup } from "./terminal-pane-group"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import type { SessionInfo } from "@/lib/terminal/types"

function info(id: string): SessionInfo {
  return { id, projectId: "p", extensionId: null, origin: "local", shell: "/bin/bash" }
}

beforeEach(() => {
  cleanup()
  useTerminalStore.getState().reset()
  fakeHandle.findNext.mockClear()
})

describe("TerminalPaneGroup", () => {
  it("renders a single pane without close chrome", () => {
    useTerminalStore.getState().registerSession(info("a"))
    render(<TerminalPaneGroup anchorId="a" onFocusedChange={jest.fn()} onClosePane={jest.fn()} />)
    expect(screen.getByTestId("terminal-pane-group").getAttribute("data-panes")).toBe("1")
    expect(screen.getAllByTestId("terminal-pane")).toHaveLength(1)
    // single pane → no per-pane close button
    expect(screen.queryByTestId("terminal-pane-close")).toBeNull()
  })

  it("reports the focused pane + handle to the dock on mount", () => {
    useTerminalStore.getState().registerSession(info("a"))
    const onFocusedChange = jest.fn()
    render(
      <TerminalPaneGroup anchorId="a" onFocusedChange={onFocusedChange} onClosePane={jest.fn()} />
    )
    expect(onFocusedChange).toHaveBeenCalledWith("a", fakeHandle)
  })

  it("renders one pane per group member with close buttons when split", () => {
    useTerminalStore.getState().registerSession(info("a"))
    useTerminalStore.getState().registerSession(info("b"))
    useTerminalStore.getState().addPaneToGroup("a", "b")
    render(<TerminalPaneGroup anchorId="a" onFocusedChange={jest.fn()} onClosePane={jest.fn()} />)
    expect(screen.getByTestId("terminal-pane-group").getAttribute("data-panes")).toBe("2")
    const panes = screen.getAllByTestId("terminal-pane")
    expect(panes.map((p) => p.getAttribute("data-session-id"))).toEqual(["a", "b"])
    expect(screen.getAllByTestId("terminal-pane-close")).toHaveLength(2)
  })

  // react-resizable-panels v4 interprets bare numbers as PIXELS; sizes must
  // be percent strings or split panes collapse to px-wide slivers.
  it("passes percent-string sizes to split panes", () => {
    useTerminalStore.getState().registerSession(info("a"))
    useTerminalStore.getState().registerSession(info("b"))
    useTerminalStore.getState().addPaneToGroup("a", "b")
    render(<TerminalPaneGroup anchorId="a" onFocusedChange={jest.fn()} onClosePane={jest.fn()} />)
    const percent = /^\d+(\.\d+)?%$/
    const panels = screen.getAllByTestId("resizable-panel")
    expect(panels).toHaveLength(2)
    for (const panel of panels) {
      expect(panel.dataset.defaultSize).toMatch(percent)
      expect(panel.dataset.minSize).toMatch(percent)
    }
  })

  it("focuses a pane on mouse-down and reports it upward", () => {
    useTerminalStore.getState().registerSession(info("a"))
    useTerminalStore.getState().registerSession(info("b"))
    useTerminalStore.getState().addPaneToGroup("a", "b") // focus starts on b
    const onFocusedChange = jest.fn()
    render(
      <TerminalPaneGroup anchorId="a" onFocusedChange={onFocusedChange} onClosePane={jest.fn()} />
    )
    const paneA = screen
      .getAllByTestId("terminal-pane")
      .find((p) => p.getAttribute("data-session-id") === "a")!
    act(() => {
      fireEvent.mouseDown(paneA)
    })
    expect(useTerminalStore.getState().focusedPaneByAnchor["a"]).toBe("a")
    expect(onFocusedChange).toHaveBeenLastCalledWith("a", fakeHandle)
  })

  it("invokes onClosePane with the pane's session id", () => {
    useTerminalStore.getState().registerSession(info("a"))
    useTerminalStore.getState().registerSession(info("b"))
    useTerminalStore.getState().addPaneToGroup("a", "b")
    const onClosePane = jest.fn()
    render(<TerminalPaneGroup anchorId="a" onFocusedChange={jest.fn()} onClosePane={onClosePane} />)
    const closeButtons = screen.getAllByTestId("terminal-pane-close")
    fireEvent.click(closeButtons[1]!) // the "b" pane
    expect(onClosePane).toHaveBeenCalledWith("b")
  })
})
