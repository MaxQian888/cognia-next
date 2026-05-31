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
  registerLinkProvider?: jest.Mock
  scrollToLine?: jest.Mock
  buffer?: { active: { viewportY: number; getLine?: (n: number) => unknown } }
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
const mockLigaturesAddon = jest.fn(() => ({ dispose: jest.fn() }))
jest.mock("@xterm/addon-ligatures", () => ({
  LigaturesAddon: mockLigaturesAddon,
}))

// Mock the settings + terminal stores so xterm settings reactivity has
// a stable surface during tests. `mockTerminalSettings` is mutable so a
// single test can opt into e.g. font ligatures.
let mockTerminalSettings: Record<string, unknown> = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector: (s: unknown) => unknown) =>
    selector({ settings: { terminal: mockTerminalSettings } })
  ),
}))
jest.mock("@/stores/terminal/terminal-store", () => {
  const state = { sessions: { "s-1": { promptBoundaries: [], cwd: "/proj" } } }
  const useTerminalStore = Object.assign(
    jest.fn((selector: (s: unknown) => unknown) => selector(state)),
    { getState: () => state }
  )
  return { useTerminalStore }
})

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

import { Terminal as MockTerminal } from "@xterm/xterm"
import { TerminalInstance } from "./terminal-instance"
import { useFileViewerStore } from "@/stores/terminal/file-viewer-store"

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
  mockTermInstance.registerMarker = jest.fn(() => ({ line: 0, dispose: jest.fn() }))
  mockTermInstance.registerDecoration = jest.fn(() => ({ onRender: jest.fn(), dispose: jest.fn() }))
  mockTermInstance.registerLinkProvider = jest.fn(() => ({ dispose: jest.fn() }))
  mockTermInstance.scrollToLine = jest.fn()
  mockTermInstance.buffer = { active: { viewportY: 0 } }
  mockTermInstance.dispose = jest.fn()
  useFileViewerStore.setState({ open: false, path: null, line: null, column: null })
  mockTermInstance.options = { fontFamily: "Menlo", fontSize: 13, scrollback: 10000 }
  mockTermInstance.rows = 24
  mockTermInstance.cols = 80
  mockFit.mockReset()
  mockSearchInstance.findNext.mockReset().mockReturnValue(true)
  mockSearchInstance.findPrevious.mockReset().mockReturnValue(true)
  mockSearchInstance.clearDecorations.mockReset()
  mockSearchInstance.dispose.mockReset()
  mockTerminalSettings = {}
  mockLigaturesAddon.mockClear()
  ;(MockTerminal as unknown as jest.Mock).mockClear()
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
    const captured: { cb: ((text: string) => void) | null } = { cb: null }
    mockTermInstance.onData = jest.fn((cb: (text: string) => void) => {
      captured.cb = cb
      return { dispose: jest.fn() }
    })
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    captured.cb?.("ls\n")
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

  it("constructs the Terminal with a full ANSI palette and cursor options", async () => {
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    const opts = (MockTerminal as unknown as jest.Mock).mock.calls.at(-1)?.[0] as {
      theme: Record<string, string>
      cursorStyle: string
      cursorBlink: boolean
    }
    // 16-color ANSI palette is present so colored output renders correctly.
    expect(opts.theme.red).toMatch(/^#/)
    expect(opts.theme.brightWhite).toMatch(/^#/)
    expect(Object.keys(opts.theme)).toEqual(
      expect.arrayContaining([
        "black",
        "red",
        "green",
        "yellow",
        "blue",
        "magenta",
        "cyan",
        "white",
        "brightBlack",
        "brightRed",
        "brightCyan",
        "brightWhite",
      ])
    )
    // Cursor defaults.
    expect(opts.cursorStyle).toBe("block")
    expect(opts.cursorBlink).toBe(true)
  })

  it("does not load the ligatures addon by default", async () => {
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    expect(mockLigaturesAddon).not.toHaveBeenCalled()
    // 4 mandatory addons + renderer only.
    expect(mockTermInstance.loadAddon).toHaveBeenCalledTimes(5)
  })

  it("loads the ligatures addon when fontLigatures is enabled", async () => {
    mockTerminalSettings = { fontLigatures: true }
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    expect(mockLigaturesAddon).toHaveBeenCalled()
    // 4 mandatory + renderer + ligatures = 6.
    expect(mockTermInstance.loadAddon).toHaveBeenCalledTimes(6)
  })

  it("skips accelerated renderers when renderer is 'dom'", async () => {
    mockTerminalSettings = { renderer: "dom" }
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    // Only the 4 mandatory addons — no WebGL/Canvas renderer addon.
    expect(mockTermInstance.loadAddon).toHaveBeenCalledTimes(4)
  })

  it("applies a named color scheme to the constructed theme", async () => {
    mockTerminalSettings = { colorScheme: "dracula" }
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    const opts = (MockTerminal as unknown as jest.Mock).mock.calls.at(-1)?.[0] as {
      theme: { background: string }
    }
    expect(opts.theme.background).toBe("#282a36")
  })

  it("applies cursorStyle from settings", async () => {
    mockTerminalSettings = { cursorStyle: "bar", cursorBlink: false }
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    const opts = (MockTerminal as unknown as jest.Mock).mock.calls.at(-1)?.[0] as {
      cursorStyle: string
      cursorBlink: boolean
    }
    expect(opts.cursorStyle).toBe("bar")
    expect(opts.cursorBlink).toBe(false)
  })

  it("live-updates term.options.fontSize when prop changes", async () => {
    const { rerender } = render(<TerminalInstance sessionId="s-1" fontSize={13} />)
    await flushAsync()
    rerender(<TerminalInstance sessionId="s-1" fontSize={18} />)
    await flushAsync()
    expect(mockTermInstance.options.fontSize).toBe(18)
  })

  type IntegrationCb = (ev: { kind: string; exit_code?: number | null; cwd?: string }) => void

  it("registers a marker + gutter decoration on command_start (1B)", async () => {
    let cb: IntegrationCb | null = null
    sessionRegistry.current!.onIntegration = jest.fn((fn: IntegrationCb) => {
      cb = fn
      return () => undefined
    })
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    act(() => cb!({ kind: "command_start" }))
    expect(mockTermInstance.registerMarker).toHaveBeenCalled()
    expect(mockTermInstance.registerDecoration).toHaveBeenCalled()
  })

  it("recreates the decoration on command_end so the colour updates (1B)", async () => {
    let cb: IntegrationCb | null = null
    sessionRegistry.current!.onIntegration = jest.fn((fn: IntegrationCb) => {
      cb = fn
      return () => undefined
    })
    const created: Array<{ dispose: jest.Mock; onRender: jest.Mock }> = []
    mockTermInstance.registerDecoration = jest.fn(() => {
      const d = { dispose: jest.fn(), onRender: jest.fn() }
      created.push(d)
      return d
    })
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    act(() => {
      cb!({ kind: "command_start" })
      cb!({ kind: "command_end", exit_code: 0 })
    })
    expect(created).toHaveLength(2) // muted decoration, then recoloured one
    expect(created[0]!.dispose).toHaveBeenCalled()
  })

  it("jumpToNextCommand scrolls to the next marker below the viewport (1B)", async () => {
    let cb: IntegrationCb | null = null
    sessionRegistry.current!.onIntegration = jest.fn((fn: IntegrationCb) => {
      cb = fn
      return () => undefined
    })
    let line = 10
    mockTermInstance.registerMarker = jest.fn(() => ({ line: (line += 10), dispose: jest.fn() }))
    const ref = createRef<import("./terminal-instance").TerminalInstanceHandle | null>()
    render(<TerminalInstance ref={ref} sessionId="s-1" />)
    await flushAsync()
    act(() => {
      cb!({ kind: "command_start" }) // marker line 20
      cb!({ kind: "command_start" }) // marker line 30
    })
    mockTermInstance.buffer = { active: { viewportY: 15 } }
    ref.current!.jumpToNextCommand()
    expect(mockTermInstance.scrollToLine).toHaveBeenCalledWith(20)
  })

  it("jumpToPrevCommand scrolls to the previous marker above the viewport (1B)", async () => {
    let cb: IntegrationCb | null = null
    sessionRegistry.current!.onIntegration = jest.fn((fn: IntegrationCb) => {
      cb = fn
      return () => undefined
    })
    let line = 10
    mockTermInstance.registerMarker = jest.fn(() => ({ line: (line += 10), dispose: jest.fn() }))
    const ref = createRef<import("./terminal-instance").TerminalInstanceHandle | null>()
    render(<TerminalInstance ref={ref} sessionId="s-1" />)
    await flushAsync()
    act(() => {
      cb!({ kind: "command_start" }) // marker line 20
      cb!({ kind: "command_start" }) // marker line 30
    })
    mockTermInstance.buffer = { active: { viewportY: 35 } }
    ref.current!.jumpToPrevCommand()
    expect(mockTermInstance.scrollToLine).toHaveBeenCalledWith(30)
  })

  it("registers a file link provider whose activate opens the file viewer (1D)", async () => {
    type LinkProvider = {
      provideLinks: (
        y: number,
        cb: (links: Array<{ text: string; activate: () => void }> | undefined) => void
      ) => void
    }
    let provider: LinkProvider | null = null
    mockTermInstance.registerLinkProvider = jest.fn((p: LinkProvider) => {
      provider = p
      return { dispose: jest.fn() }
    })
    mockTermInstance.buffer = {
      active: {
        viewportY: 0,
        getLine: (n: number) =>
          n === 0 ? { translateToString: () => "see src/foo.ts:12:3 now" } : undefined,
      },
    }
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    expect(mockTermInstance.registerLinkProvider).toHaveBeenCalled()

    const links: Array<{ text: string; activate: () => void }> = []
    provider!.provideLinks(1, (l) => {
      if (l) links.push(...l)
    })
    expect(links).toHaveLength(1)
    expect(links[0]!.text).toBe("src/foo.ts:12:3")

    links[0]!.activate()
    const viewer = useFileViewerStore.getState()
    expect(viewer.open).toBe(true)
    expect(viewer.path).toBe("/proj/src/foo.ts") // resolved against cwd "/proj"
    expect(viewer.line).toBe(12)
    expect(viewer.column).toBe(3)
  })
})
