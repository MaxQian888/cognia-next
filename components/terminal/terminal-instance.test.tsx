/**
 * @jest-environment jsdom
 */

import { createRef } from "react"
import { render, act } from "@testing-library/react"

// Mock the heavy xterm.js modules so the test doesn't need a real GPU /
// canvas. Each constructor returns a stub with the methods the
// component calls.
const mockTermInstance: {
  loadAddon: jest.Mock
  open: jest.Mock
  write: jest.Mock
  onData: jest.Mock
  onSelectionChange: jest.Mock
  attachCustomKeyEventHandler: jest.Mock
  getSelection: jest.Mock
  paste: jest.Mock
  clear: jest.Mock
  registerMarker?: jest.Mock
  registerDecoration?: jest.Mock
  options: { fontFamily: string; fontSize: number; scrollback: number; theme?: unknown }
  unicode: { activeVersion: string }
  rows: number
  cols: number
  dispose: jest.Mock
} = {
  loadAddon: jest.fn(),
  open: jest.fn(),
  write: jest.fn(),
  onData: jest.fn(() => ({ dispose: jest.fn() })),
  onSelectionChange: jest.fn(() => ({ dispose: jest.fn() })),
  attachCustomKeyEventHandler: jest.fn(),
  getSelection: jest.fn(() => ""),
  paste: jest.fn(),
  clear: jest.fn(),
  registerMarker: jest.fn(() => ({})),
  registerDecoration: jest.fn(),
  options: { fontFamily: "Menlo", fontSize: 13, scrollback: 10000 },
  unicode: { activeVersion: "6" },
  rows: 24,
  cols: 80,
  dispose: jest.fn(),
}
const mockFit = jest.fn()
const mockSearchInstance = {
  findNext: jest.fn(() => true),
  findPrevious: jest.fn(() => true),
  clearDecorations: jest.fn(),
  dispose: jest.fn(),
}

jest.mock("@xterm/xterm", () => ({
  Terminal: jest.fn(() => mockTermInstance),
}))
jest.mock("@xterm/addon-fit", () => ({
  FitAddon: jest.fn(() => ({ fit: mockFit })),
}))
jest.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: jest.fn(() => ({})),
}))
jest.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: jest.fn(() => ({})),
}))
jest.mock("@xterm/addon-search", () => ({
  SearchAddon: jest.fn(() => mockSearchInstance),
}))
jest.mock("@xterm/addon-webgl", () => ({
  WebglAddon: jest.fn(() => ({ dispose: jest.fn() })),
}))
jest.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: jest.fn(() => ({ dispose: jest.fn() })),
}))

// Mock the settings + terminal stores so xterm settings reactivity has
// a stable surface during tests.
jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector: (s: unknown) => unknown) =>
    selector({ settings: { terminal: {} } })
  ),
}))
jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: jest.fn((selector: (s: unknown) => unknown) =>
    selector({
      sessions: {
        "s-1": {
          promptBoundaries: [],
        },
      },
    })
  ),
}))

// jsdom doesn't ship ResizeObserver.
class MockResizeObserver {
  observe = jest.fn()
  disconnect = jest.fn()
  unobserve = jest.fn()
}
;(global as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
  MockResizeObserver

const sessionRegistry: {
  current: {
    onData: jest.Mock
    onIntegration: jest.Mock
    onExit: jest.Mock
    write: jest.Mock
    resize: jest.Mock
    kill: jest.Mock
    info: { id: string }
  } | null
} = { current: null }

jest.mock("@/lib/terminal/session-registry", () => ({
  getLiveSession: () => sessionRegistry.current,
}))

import { TerminalInstance } from "./terminal-instance"

function makeFakeSession() {
  return {
    info: { id: "s-1" },
    onData: jest.fn(() => () => undefined),
    onIntegration: jest.fn(() => () => undefined),
    onExit: jest.fn(() => () => undefined),
    write: jest.fn(async () => undefined),
    resize: jest.fn(async () => undefined),
    kill: jest.fn(async () => undefined),
  }
}

async function flushAsync(): Promise<void> {
  // Drain three microtask passes: dynamic imports + outer await + post-setup.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  mockTermInstance.loadAddon = jest.fn()
  mockTermInstance.open = jest.fn()
  mockTermInstance.write = jest.fn()
  mockTermInstance.onData = jest.fn(() => ({ dispose: jest.fn() }))
  mockTermInstance.onSelectionChange = jest.fn(() => ({ dispose: jest.fn() }))
  mockTermInstance.attachCustomKeyEventHandler = jest.fn()
  mockTermInstance.getSelection = jest.fn(() => "")
  mockTermInstance.paste = jest.fn()
  mockTermInstance.clear = jest.fn()
  mockTermInstance.registerMarker = jest.fn(() => ({}))
  mockTermInstance.registerDecoration = jest.fn()
  mockTermInstance.dispose = jest.fn()
  mockTermInstance.options = { fontFamily: "Menlo", fontSize: 13, scrollback: 10000 }
  mockTermInstance.rows = 24
  mockTermInstance.cols = 80
  mockFit.mockReset()
  mockSearchInstance.findNext.mockReset().mockReturnValue(true)
  mockSearchInstance.findPrevious.mockReset().mockReturnValue(true)
  mockSearchInstance.clearDecorations.mockReset()
  mockSearchInstance.dispose.mockReset()
  sessionRegistry.current = makeFakeSession()
})

describe("TerminalInstance", () => {
  it("renders a container div with the session id", () => {
    const { container } = render(<TerminalInstance sessionId="s-1" />)
    const div = container.querySelector('[data-testid="terminal-instance"]')
    expect(div).toBeTruthy()
    expect(div?.getAttribute("data-session-id")).toBe("s-1")
  })

  it("opens the xterm.js Terminal into the container after lazy load", async () => {
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    expect(mockTermInstance.open).toHaveBeenCalled()
  })

  it("loads addon-fit, web-links, unicode11, search, and a renderer", async () => {
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    // 4 mandatory addons + 1 renderer (webgl OR canvas, both mocked so
    // webgl wins). 5 total addons loaded.
    expect(mockTermInstance.loadAddon).toHaveBeenCalledTimes(5)
  })

  it("wires session.onData to the backpressure→term.write pipeline", async () => {
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    expect(sessionRegistry.current!.onData).toHaveBeenCalled()
  })

  it("propagates initial fit dimensions to session.resize", async () => {
    mockTermInstance.rows = 32
    mockTermInstance.cols = 120
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    expect(sessionRegistry.current!.resize).toHaveBeenCalledWith(32, 120)
  })

  it("wires term.onData to session.write for user input", async () => {
    let captured: ((text: string) => void) | null = null
    mockTermInstance.onData = jest.fn((cb: (text: string) => void) => {
      captured = cb
      return { dispose: jest.fn() }
    })
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    captured?.("ls\n")
    expect(sessionRegistry.current!.write).toHaveBeenCalledWith("ls\n")
  })

  it("disposes the Terminal on unmount", async () => {
    const { unmount } = render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    unmount()
    expect(mockTermInstance.dispose).toHaveBeenCalled()
  })

  it("does nothing when the session is not in the registry", async () => {
    sessionRegistry.current = null
    render(<TerminalInstance sessionId="missing" />)
    await flushAsync()
    expect(mockTermInstance.open).not.toHaveBeenCalled()
  })

  it("imperative handle exposes findNext/findPrevious through SearchAddon", async () => {
    const ref = createRef<import("./terminal-instance").TerminalInstanceHandle | null>()
    render(<TerminalInstance ref={ref} sessionId="s-1" />)
    await flushAsync()
    expect(ref.current).not.toBeNull()
    const ok = ref.current!.findNext("hello", true)
    expect(ok).toBe(true)
    expect(mockSearchInstance.findNext).toHaveBeenCalledWith("hello", { caseSensitive: true })
    ref.current!.findPrevious("world")
    expect(mockSearchInstance.findPrevious).toHaveBeenCalledWith("world", { caseSensitive: false })
  })

  it("imperative handle.clearSearch calls SearchAddon.clearDecorations", async () => {
    const ref = createRef<import("./terminal-instance").TerminalInstanceHandle | null>()
    render(<TerminalInstance ref={ref} sessionId="s-1" />)
    await flushAsync()
    ref.current!.clearSearch()
    expect(mockSearchInstance.clearDecorations).toHaveBeenCalled()
  })

  it("imperative handle.clearScreen calls term.clear", async () => {
    const ref = createRef<import("./terminal-instance").TerminalInstanceHandle | null>()
    render(<TerminalInstance ref={ref} sessionId="s-1" />)
    await flushAsync()
    ref.current!.clearScreen()
    expect(mockTermInstance.clear).toHaveBeenCalled()
  })

  it("attaches a custom key event handler for clipboard shortcuts", async () => {
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    expect(mockTermInstance.attachCustomKeyEventHandler).toHaveBeenCalled()
  })

  it("live-updates term.options.fontSize when prop changes", async () => {
    const { rerender } = render(<TerminalInstance sessionId="s-1" fontSize={13} />)
    await flushAsync()
    rerender(<TerminalInstance sessionId="s-1" fontSize={18} />)
    await flushAsync()
    expect(mockTermInstance.options.fontSize).toBe(18)
  })
})
