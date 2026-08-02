/**
 * @jest-environment jsdom
 */

import { createRef } from "react"
import { render, act, fireEvent, screen, waitFor } from "@testing-library/react"

// Mock the heavy xterm.js modules so the test doesn't need a real GPU /
// canvas. Each constructor returns a stub with the methods the
// component calls.
const mockTermInstance: {
  loadAddon: jest.Mock
  open: jest.Mock
  write: jest.Mock
  writeln: jest.Mock
  onData: jest.Mock
  onSelectionChange: jest.Mock
  onBell?: jest.Mock
  attachCustomKeyEventHandler: jest.Mock
  getSelection: jest.Mock
  paste: jest.Mock
  clear: jest.Mock
  focus: jest.Mock
  blur: jest.Mock
  registerMarker?: jest.Mock
  registerDecoration?: jest.Mock
  registerLinkProvider?: jest.Mock
  scrollToLine?: jest.Mock
  clearTextureAtlas?: jest.Mock
  buffer?: { active: { viewportY: number; getLine?: (n: number) => unknown } }
  options: {
    fontFamily: string
    fontSize: number
    scrollback: number
    theme?: unknown
    fontWeight?: string
    fontWeightBold?: string
    lineHeight?: number
    letterSpacing?: number
    scrollSensitivity?: number
    fastScrollSensitivity?: number
    minimumContrastRatio?: number
    cursorStyle?: string
    cursorBlink?: boolean
    cursorWidth?: number
    cursorInactiveStyle?: string
    customGlyphs?: boolean
    rescaleOverlappingGlyphs?: boolean
    drawBoldTextInBrightColors?: boolean
    smoothScrollDuration?: number
  }
  unicode: { activeVersion: string }
  rows: number
  cols: number
  dispose: jest.Mock
} = {
  loadAddon: jest.fn(),
  open: jest.fn(),
  write: jest.fn(),
  writeln: jest.fn(),
  onData: jest.fn(() => ({ dispose: jest.fn() })),
  onSelectionChange: jest.fn(() => ({ dispose: jest.fn() })),
  attachCustomKeyEventHandler: jest.fn(),
  getSelection: jest.fn(() => ""),
  paste: jest.fn(),
  clear: jest.fn(),
  focus: jest.fn(),
  blur: jest.fn(),
  registerMarker: jest.fn(() => ({})),
  registerDecoration: jest.fn(),
  clearTextureAtlas: jest.fn(),
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
let mockWebglContextLossHandler: (() => void) | null = null
const mockWebglDispose = jest.fn()
const mockWebglContextLossDispose = jest.fn()
const mockCanvasDispose = jest.fn()
const mockWebglAddon = {
  dispose: mockWebglDispose,
  onContextLoss: jest.fn((handler: () => void) => {
    mockWebglContextLossHandler = handler
    return { dispose: mockWebglContextLossDispose }
  }),
}
const mockCanvasAddon = { dispose: mockCanvasDispose }

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
  WebglAddon: jest.fn(() => mockWebglAddon),
}))
jest.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: jest.fn(() => mockCanvasAddon),
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
  const state = {
    sessions: { "s-1": { promptBoundaries: [], cwd: "/proj" } },
    // Backpressure flag map + its setter — the instance reads the flag for the
    // session chip and clears it on teardown.
    outputThrottled: {} as Record<string, boolean>,
    setOutputThrottled: jest.fn((id: string, throttled: boolean) => {
      if (throttled) state.outputThrottled[id] = true
      else delete state.outputThrottled[id]
    }),
  }
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
    onData: jest.Mock<() => void, [(data: Uint8Array) => void]>
    onIntegration: jest.Mock
    onExit: jest.Mock
    onControlState: jest.Mock
    onReplayGap: jest.Mock
    write: jest.Mock
    resize: jest.Mock
    kill: jest.Mock
    takeControl: jest.Mock
    setFlowControl: jest.Mock<Promise<boolean>, [paused: boolean]>
    info: { id: string; sandboxed?: boolean }
  } | null
} = { current: null }

jest.mock("@/lib/terminal/session-registry", () => ({
  getLiveSession: () => sessionRegistry.current,
  // The session chip subscribes so live facts (controller, sandbox, degraded
  // integration) stop being read stale during render.
  subscribeLiveSessions: () => () => undefined,
}))

// Controllable autocomplete hook — the hook internals are unit-tested
// separately (use-terminal-autocomplete.test.ts). Here we only verify the
// terminal-instance glue (overlay render, feed wiring, Tab/Esc handling,
// prompt-reset).
const mockAutocomplete: {
  enabled: boolean
  popupEnabled: boolean
  ghost: string
  ghostSuggestion: { source: "history" | "ai" | "plugin" | "path" | "exe" | "spec" } | null
  listOpen: boolean
  candidates: unknown[]
  selectedIndex: number
  feed: jest.Mock
  accept: jest.Mock
  acceptSelected: jest.Mock
  openList: jest.Mock
  closeList: jest.Mock
  moveSelection: jest.Mock
  dismiss: jest.Mock
  reset: jest.Mock
} = {
  enabled: false,
  popupEnabled: false,
  ghost: "",
  ghostSuggestion: null,
  listOpen: false,
  candidates: [],
  selectedIndex: 0,
  feed: jest.fn(),
  accept: jest.fn(() => null),
  acceptSelected: jest.fn(() => null),
  openList: jest.fn(),
  closeList: jest.fn(),
  moveSelection: jest.fn(),
  dismiss: jest.fn(),
  reset: jest.fn(),
}
jest.mock("@/hooks/terminal/use-terminal-autocomplete", () => ({
  useTerminalAutocomplete: () => mockAutocomplete,
}))

import { Terminal as MockTerminal } from "@xterm/xterm"
import { TerminalInstance } from "./terminal-instance"
import { useFileViewerStore } from "@/stores/terminal/file-viewer-store"

function makeFakeSession(): NonNullable<(typeof sessionRegistry)["current"]> {
  return {
    info: { id: "s-1" },
    onData: jest.fn<() => void, [(data: Uint8Array) => void]>(() => () => undefined),
    onIntegration: jest.fn(() => () => undefined),
    onExit: jest.fn(() => () => undefined),
    onControlState: jest.fn(() => () => undefined),
    onReplayGap: jest.fn(() => () => undefined),
    write: jest.fn(async () => undefined),
    resize: jest.fn(async () => undefined),
    kill: jest.fn(async () => undefined),
    takeControl: jest.fn(async () => undefined),
    setFlowControl: jest.fn<Promise<boolean>, [paused: boolean]>(async () => true),
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
  mockTermInstance.writeln = jest.fn()
  mockTermInstance.onData = jest.fn(() => ({ dispose: jest.fn() }))
  mockTermInstance.onSelectionChange = jest.fn(() => ({ dispose: jest.fn() }))
  mockTermInstance.onBell = jest.fn(() => ({ dispose: jest.fn() }))
  mockTermInstance.attachCustomKeyEventHandler = jest.fn()
  mockTermInstance.getSelection = jest.fn(() => "")
  mockTermInstance.paste = jest.fn()
  mockTermInstance.clear = jest.fn()
  mockTermInstance.registerMarker = jest.fn(() => ({ line: 0, dispose: jest.fn() }))
  mockTermInstance.registerDecoration = jest.fn(() => ({ onRender: jest.fn(), dispose: jest.fn() }))
  mockTermInstance.registerLinkProvider = jest.fn(() => ({ dispose: jest.fn() }))
  mockTermInstance.scrollToLine = jest.fn()
  mockTermInstance.clearTextureAtlas = jest.fn()
  mockTermInstance.buffer = { active: { viewportY: 0 } }
  mockTermInstance.dispose = jest.fn()
  useFileViewerStore.setState({ open: false, path: null, line: null, column: null })
  mockTermInstance.options = { fontFamily: "Menlo", fontSize: 13, scrollback: 10000 }
  mockTermInstance.rows = 24
  mockTermInstance.cols = 80
  mockFit.mockReset()
  // Deterministic CSS Font Loading API stub. A never-resolving load()/ready
  // keeps the terminal's post-open "rebuild atlas once the font loads" path
  // (fire-and-forget) from spontaneously firing a refit/clearTextureAtlas
  // mid-test and polluting the `mockFit`/atlas assertions. The synchronous
  // live-settings path still exercises clearTextureAtlas on a font change.
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: jest.fn(() => new Promise(() => {})), ready: new Promise(() => {}) },
  })
  mockSearchInstance.findNext.mockReset().mockReturnValue(true)
  mockSearchInstance.findPrevious.mockReset().mockReturnValue(true)
  mockSearchInstance.clearDecorations.mockReset()
  mockSearchInstance.dispose.mockReset()
  mockWebglContextLossHandler = null
  mockWebglDispose.mockReset()
  mockWebglContextLossDispose.mockReset()
  mockCanvasDispose.mockReset()
  mockWebglAddon.onContextLoss.mockClear()
  mockTerminalSettings = {}
  mockLigaturesAddon.mockClear()
  ;(MockTerminal as unknown as jest.Mock).mockClear()
  sessionRegistry.current = makeFakeSession()
  mockAutocomplete.enabled = false
  mockAutocomplete.popupEnabled = false
  mockAutocomplete.ghost = ""
  mockAutocomplete.ghostSuggestion = null
  mockAutocomplete.listOpen = false
  mockAutocomplete.candidates = []
  mockAutocomplete.selectedIndex = 0
  mockAutocomplete.feed.mockReset()
  mockAutocomplete.accept.mockReset().mockReturnValue(null)
  mockAutocomplete.acceptSelected.mockReset().mockReturnValue(null)
  mockAutocomplete.openList.mockReset()
  mockAutocomplete.closeList.mockReset()
  mockAutocomplete.moveSelection.mockReset()
  mockAutocomplete.dismiss.mockReset()
  mockAutocomplete.reset.mockReset()
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

  it("falls back to Canvas when the WebGL context is lost", async () => {
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    expect(mockWebglContextLossHandler).not.toBeNull()
    act(() => {
      mockWebglContextLossHandler?.()
    })
    expect(mockWebglDispose).toHaveBeenCalled()
    expect(mockTermInstance.loadAddon).toHaveBeenLastCalledWith(mockCanvasAddon)
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

  describe("terminal bell", () => {
    function captureBell() {
      const captured: { cb: (() => void) | null } = { cb: null }
      mockTermInstance.onBell = jest.fn((cb: () => void) => {
        captured.cb = cb
        return { dispose: jest.fn() }
      })
      return captured
    }

    it("flashes the container on BEL when the style is visual", async () => {
      mockTerminalSettings = { bell: "visual" }
      const captured = captureBell()
      const { container } = render(<TerminalInstance sessionId="s-1" />)
      await flushAsync()
      const div = container.querySelector('[data-testid="terminal-instance"]') as HTMLElement
      expect(div.style.boxShadow).toBe("")
      act(() => captured.cb?.())
      expect(div.style.boxShadow).toContain("inset")
    })

    it("ignores BEL when the style is none (default)", async () => {
      const captured = captureBell()
      const { container } = render(<TerminalInstance sessionId="s-1" />)
      await flushAsync()
      const div = container.querySelector('[data-testid="terminal-instance"]') as HTMLElement
      act(() => captured.cb?.())
      expect(div.style.boxShadow).toBe("")
    })

    it("does not throw for sound styles when AudioContext is unavailable", async () => {
      mockTerminalSettings = { bell: "both" }
      const captured = captureBell()
      const { container } = render(<TerminalInstance sessionId="s-1" />)
      await flushAsync()
      const div = container.querySelector('[data-testid="terminal-instance"]') as HTMLElement
      // jsdom has no AudioContext — the sound half must degrade silently
      // while the visual half still fires ("both").
      expect(() => act(() => captured.cb?.())).not.toThrow()
      expect(div.style.boxShadow).toContain("inset")
    })
  })

  it("disposes the Terminal on unmount", async () => {
    const { unmount } = render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    unmount()
    expect(mockTermInstance.dispose).toHaveBeenCalled()
  })

  it("releases host flow control after an in-flight pause when unmounted", async () => {
    let emitData: ((data: Uint8Array) => void) | null = null
    let resolvePause: ((supported: boolean) => void) | null = null
    const session = makeFakeSession()
    session.onData.mockImplementation((listener: (data: Uint8Array) => void) => {
      emitData = listener
      return () => undefined
    })
    session.setFlowControl.mockImplementation((paused: boolean) => {
      if (!paused) return Promise.resolve(true)
      return new Promise<boolean>((resolve) => {
        resolvePause = resolve
      })
    })
    sessionRegistry.current = session

    const { unmount } = render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()

    act(() => {
      emitData?.(new Uint8Array(5 * 1024 * 1024))
    })
    await flushAsync()
    expect(session.setFlowControl).toHaveBeenCalledWith(true)

    unmount()
    await act(async () => {
      resolvePause?.(true)
      await Promise.resolve()
    })

    expect(session.setFlowControl).toHaveBeenLastCalledWith(false)
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

  it("imperative handle supports touch input and software-keyboard control", async () => {
    const ref = createRef<import("./terminal-instance").TerminalInstanceHandle | null>()
    render(<TerminalInstance ref={ref} sessionId="s-1" />)
    await waitFor(() => expect(ref.current).not.toBeNull())

    await act(async () => ref.current!.sendInput("\u001b[A"))
    expect(sessionRegistry.current?.write).toHaveBeenCalledWith("\u001b[A")
    ref.current!.focusKeyboard()
    ref.current!.hideKeyboard()
    expect(mockTermInstance.focus).toHaveBeenCalled()
    expect(mockTermInstance.blur).toHaveBeenCalled()
  })

  it("surfaces read-only takeover and replay truncation states", async () => {
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    const session = sessionRegistry.current!
    const controlListener = session.onControlState.mock.calls[0]?.[0] as (state: unknown) => void
    const gapListener = session.onReplayGap.mock.calls[0]?.[0] as (gap: unknown) => void
    act(() => {
      controlListener({ role: "viewer", controllerId: "phone-2", reason: "takeover" })
      gapListener({ requestedAfter: 2, firstAvailable: 8, lastAvailable: 20 })
    })
    // Both states now live in the one auto-collapsing session chip rather than
    // a permanent badge stack across the top of the terminal.
    expect(screen.getByTestId("terminal-session-chip")).toBeInTheDocument()
    expect(mockTermInstance.writeln).toHaveBeenCalledWith(
      expect.stringContaining("Earlier terminal output is unavailable")
    )

    fireEvent.click(screen.getByTestId("terminal-session-chip"))
    const details = screen.getByTestId("terminal-session-chip-details")
    expect(details.querySelector('[data-state-key="readOnly"]')).not.toBeNull()
    expect(details.querySelector('[data-state-key="replayGap"]')).not.toBeNull()

    const confirm = jest.spyOn(window, "confirm").mockReturnValueOnce(true)
    fireEvent.click(screen.getByTestId("terminal-chip-take-control"))
    expect(session.takeControl).toHaveBeenCalled()
    confirm.mockRestore()
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

  it("auto scheme follows the app --background/--foreground CSS tokens", async () => {
    const realGCS = window.getComputedStyle.bind(window)
    const spy = jest.spyOn(window, "getComputedStyle").mockImplementation(((
      el: Element,
      pseudo?: string | null
    ) => {
      // The theme probe carries an inline `color: var(--…)`; the browser would
      // resolve it to rgb — emulate that here.
      const inline = (el as HTMLElement).style?.color
      if (inline === "var(--background)") return { color: "rgb(18, 18, 18)" } as CSSStyleDeclaration
      if (inline === "var(--foreground)")
        return { color: "rgb(230, 230, 230)" } as CSSStyleDeclaration
      return realGCS(el, pseudo ?? undefined)
    }) as typeof window.getComputedStyle)
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    const opts = (MockTerminal as unknown as jest.Mock).mock.calls.at(-1)?.[0] as {
      theme: { background: string; foreground: string; cursor: string }
    }
    expect(opts.theme.background).toBe("rgb(18, 18, 18)")
    expect(opts.theme.foreground).toBe("rgb(230, 230, 230)")
    expect(opts.theme.cursor).toBe("rgb(230, 230, 230)")
    spy.mockRestore()
  })

  it("auto scheme follows the app --accent for the selection highlight", async () => {
    const realGCS = window.getComputedStyle.bind(window)
    const spy = jest.spyOn(window, "getComputedStyle").mockImplementation(((
      el: Element,
      pseudo?: string | null
    ) => {
      const inline = (el as HTMLElement).style?.color
      if (inline === "var(--background)") return { color: "rgb(18, 18, 18)" } as CSSStyleDeclaration
      if (inline === "var(--foreground)")
        return { color: "rgb(230, 230, 230)" } as CSSStyleDeclaration
      if (inline === "var(--accent)") return { color: "rgb(124, 58, 237)" } as CSSStyleDeclaration
      return realGCS(el, pseudo ?? undefined)
    }) as typeof window.getComputedStyle)
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    const opts = (MockTerminal as unknown as jest.Mock).mock.calls.at(-1)?.[0] as {
      theme: { selectionBackground: string }
    }
    expect(opts.theme.selectionBackground).toBe("rgba(124, 58, 237, 0.35)")
    spy.mockRestore()
  })

  it("does not override a named scheme even when app tokens resolve", async () => {
    mockTerminalSettings = { colorScheme: "dracula" }
    const realGCS = window.getComputedStyle.bind(window)
    const spy = jest.spyOn(window, "getComputedStyle").mockImplementation(((
      el: Element,
      pseudo?: string | null
    ) => {
      const inline = (el as HTMLElement).style?.color
      if (inline?.startsWith("var(")) return { color: "rgb(18, 18, 18)" } as CSSStyleDeclaration
      return realGCS(el, pseudo ?? undefined)
    }) as typeof window.getComputedStyle)
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    const opts = (MockTerminal as unknown as jest.Mock).mock.calls.at(-1)?.[0] as {
      theme: { background: string }
    }
    expect(opts.theme.background).toBe("#282a36")
    spy.mockRestore()
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

  it("passes cursor width and inactive style to xterm", async () => {
    mockTerminalSettings = { cursorWidth: 3, cursorInactiveStyle: "none" }
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    const opts = (MockTerminal as unknown as jest.Mock).mock.calls.at(-1)?.[0] as {
      cursorWidth?: number
      cursorInactiveStyle?: string
    }
    expect(opts.cursorWidth).toBe(3)
    expect(opts.cursorInactiveStyle).toBe("none")
  })

  it("constructs the Terminal with font-weight, line-height, spacing and contrast", async () => {
    mockTerminalSettings = {
      fontWeight: "300",
      fontWeightBold: "700",
      lineHeight: 1.4,
      letterSpacing: 1,
      scrollSensitivity: 3,
      minimumContrastRatio: 7,
    }
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    const opts = (MockTerminal as unknown as jest.Mock).mock.calls.at(-1)?.[0] as {
      fontWeight: string
      fontWeightBold: string
      lineHeight: number
      letterSpacing: number
      scrollSensitivity: number
      fastScrollSensitivity: number
      minimumContrastRatio: number
    }
    expect(opts.fontWeight).toBe("300")
    expect(opts.fontWeightBold).toBe("700")
    expect(opts.lineHeight).toBe(1.4)
    expect(opts.letterSpacing).toBe(1)
    expect(opts.scrollSensitivity).toBe(3)
    expect(opts.fastScrollSensitivity).toBe(15) // 5× the base sensitivity
    expect(opts.minimumContrastRatio).toBe(7)
  })

  it("passes the custom glyph preference to xterm", async () => {
    mockTerminalSettings = { customGlyphs: false }
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    const opts = (MockTerminal as unknown as jest.Mock).mock.calls.at(-1)?.[0] as {
      customGlyphs?: boolean
    }
    expect(opts.customGlyphs).toBe(false)
  })

  it("passes the overlapping glyph rescale preference to xterm", async () => {
    mockTerminalSettings = { rescaleOverlappingGlyphs: false }
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    const opts = (MockTerminal as unknown as jest.Mock).mock.calls.at(-1)?.[0] as {
      rescaleOverlappingGlyphs?: boolean
    }
    expect(opts.rescaleOverlappingGlyphs).toBe(false)
  })

  it("passes the bold bright-color preference to xterm", async () => {
    mockTerminalSettings = { drawBoldTextInBrightColors: false }
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    const opts = (MockTerminal as unknown as jest.Mock).mock.calls.at(-1)?.[0] as {
      drawBoldTextInBrightColors?: boolean
    }
    expect(opts.drawBoldTextInBrightColors).toBe(false)
  })

  it("maps smooth scrolling to VS Code's 125 ms xterm duration", async () => {
    mockTerminalSettings = { smoothScrolling: true }
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    const opts = (MockTerminal as unknown as jest.Mock).mock.calls.at(-1)?.[0] as {
      smoothScrollDuration?: number
    }
    expect(opts.smoothScrollDuration).toBe(125)
  })

  it("re-fits when the line height changes (cell metrics shift)", async () => {
    // Explicit font props match the stub so only the line-height change registers.
    const { rerender } = render(
      <TerminalInstance sessionId="s-1" fontFamily="Menlo" fontSize={13} />
    )
    await flushAsync()
    // Mirror the constructor-committed metric defaults onto the stub.
    Object.assign(mockTermInstance.options, {
      fontFamily: "Menlo",
      fontSize: 13,
      fontWeight: "normal",
      fontWeightBold: "bold",
      lineHeight: 1,
      letterSpacing: 0,
      scrollSensitivity: 1,
      minimumContrastRatio: 1,
    })
    mockFit.mockClear()
    mockTerminalSettings = { lineHeight: 1.5 }
    rerender(<TerminalInstance sessionId="s-1" fontFamily="Menlo" fontSize={13} />)
    await flushAsync()
    expect(mockTermInstance.options.lineHeight).toBe(1.5)
    expect(mockFit).toHaveBeenCalled()
  })

  it("live-updates minimum contrast without a re-fit", async () => {
    const { rerender } = render(
      <TerminalInstance sessionId="s-1" fontFamily="Menlo" fontSize={13} />
    )
    await flushAsync()
    Object.assign(mockTermInstance.options, {
      fontFamily: "Menlo",
      fontSize: 13,
      fontWeight: "normal",
      fontWeightBold: "bold",
      lineHeight: 1,
      letterSpacing: 0,
      scrollSensitivity: 1,
      minimumContrastRatio: 1,
    })
    mockFit.mockClear()
    mockTerminalSettings = { minimumContrastRatio: 7 }
    rerender(<TerminalInstance sessionId="s-1" fontFamily="Menlo" fontSize={13} />)
    await flushAsync()
    expect(mockTermInstance.options.minimumContrastRatio).toBe(7)
    expect(mockFit).not.toHaveBeenCalled()
  })

  it("live-updates non-metric rendering options without a re-fit", async () => {
    const { rerender } = render(
      <TerminalInstance sessionId="s-1" fontFamily="Menlo" fontSize={13} />
    )
    await flushAsync()
    Object.assign(mockTermInstance.options, {
      fontFamily: "Menlo",
      fontSize: 13,
      fontWeight: "normal",
      fontWeightBold: "bold",
      lineHeight: 1,
      letterSpacing: 0,
      scrollSensitivity: 1,
      fastScrollSensitivity: 5,
      minimumContrastRatio: 1,
      cursorStyle: "block",
      cursorBlink: true,
      cursorWidth: 1,
      cursorInactiveStyle: "outline",
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      drawBoldTextInBrightColors: true,
      smoothScrollDuration: 0,
    })
    mockFit.mockClear()
    mockTerminalSettings = {
      cursorWidth: 4,
      cursorInactiveStyle: "none",
      customGlyphs: false,
      rescaleOverlappingGlyphs: false,
      drawBoldTextInBrightColors: false,
      smoothScrolling: true,
    }
    rerender(<TerminalInstance sessionId="s-1" fontFamily="Menlo" fontSize={13} />)
    await flushAsync()
    expect(mockTermInstance.options).toEqual(
      expect.objectContaining({
        cursorWidth: 4,
        cursorInactiveStyle: "none",
        customGlyphs: false,
        rescaleOverlappingGlyphs: false,
        drawBoldTextInBrightColors: false,
        smoothScrollDuration: 125,
      })
    )
    expect(mockFit).not.toHaveBeenCalled()
  })

  it("live-updates term.options.fontSize when prop changes", async () => {
    const { rerender } = render(<TerminalInstance sessionId="s-1" fontSize={13} />)
    await flushAsync()
    rerender(<TerminalInstance sessionId="s-1" fontSize={18} />)
    await flushAsync()
    expect(mockTermInstance.options.fontSize).toBe(18)
  })

  it("re-fits and resizes the PTY when the font size changes", async () => {
    mockTermInstance.rows = 30
    mockTermInstance.cols = 100
    const { rerender } = render(<TerminalInstance sessionId="s-1" fontSize={13} />)
    await flushAsync()
    mockFit.mockClear()
    sessionRegistry.current!.resize.mockClear()
    // The larger font yields a coarser cell grid on the next fit.
    mockFit.mockImplementation(() => {
      mockTermInstance.rows = 24
      mockTermInstance.cols = 80
    })
    rerender(<TerminalInstance sessionId="s-1" fontSize={18} />)
    await flushAsync()
    expect(mockFit).toHaveBeenCalled()
    expect(sessionRegistry.current!.resize).toHaveBeenCalledWith(24, 80)
  })

  it("re-fits and rebuilds the glyph atlas when the font family changes", async () => {
    const { rerender } = render(<TerminalInstance sessionId="s-1" fontFamily="Menlo" />)
    await flushAsync()
    mockFit.mockClear()
    mockTermInstance.clearTextureAtlas!.mockClear()
    rerender(<TerminalInstance sessionId="s-1" fontFamily="Fira Code" />)
    await flushAsync()
    expect(mockTermInstance.options.fontFamily).toBe("Fira Code")
    expect(mockFit).toHaveBeenCalled()
    // The accelerated renderer's atlas must be cleared so the new font's cell
    // metrics take effect — otherwise glyphs render one cell too wide.
    expect(mockTermInstance.clearTextureAtlas).toHaveBeenCalled()
  })

  it("does not re-fit when only a non-font setting changes", async () => {
    const { rerender } = render(
      <TerminalInstance sessionId="s-1" fontFamily="Menlo" fontSize={13} scrollback={1000} />
    )
    await flushAsync()
    // The mock Terminal ignores its constructor options, so mirror the committed
    // font + metric options onto the stub the way the real constructor would —
    // otherwise the next effect run would see a spurious font change.
    mockTermInstance.options.fontFamily = "Menlo"
    mockTermInstance.options.fontSize = 13
    Object.assign(mockTermInstance.options, {
      fontWeight: "normal",
      fontWeightBold: "bold",
      lineHeight: 1,
      letterSpacing: 0,
      scrollSensitivity: 1,
      minimumContrastRatio: 1,
    })
    mockFit.mockClear()
    rerender(
      <TerminalInstance sessionId="s-1" fontFamily="Menlo" fontSize={13} scrollback={5000} />
    )
    await flushAsync()
    expect(mockTermInstance.options.scrollback).toBe(5000)
    expect(mockFit).not.toHaveBeenCalled()
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

  it("paints a per-row gutter tick, never a full-height bar (1B)", async () => {
    let cb: IntegrationCb | null = null
    sessionRegistry.current!.onIntegration = jest.fn((fn: IntegrationCb) => {
      cb = fn
      return () => undefined
    })
    // Simulate xterm invoking onRender with the decoration element so the
    // styling runs. Each element starts with the geometry xterm sets inline
    // (a single cell-row tall); the fix must not stomp `height` to "100%".
    const painted: Array<Record<string, string>> = []
    mockTermInstance.registerDecoration = jest.fn(() => ({
      dispose: jest.fn(),
      onRender: (fn: (el: { style: Record<string, string> }) => void) => {
        const el = {
          style: { top: "34px", height: "17px", width: "8px" } as Record<string, string>,
        }
        fn(el)
        painted.push(el.style)
      },
    }))
    render(<TerminalInstance sessionId="s-1" />)
    await flushAsync()
    act(() => {
      cb!({ kind: "command_start" }) // running → neutral
      cb!({ kind: "command_end", exit_code: 1 }) // failed → red
    })
    expect(painted).toHaveLength(2)
    // Running marker: neutral colour, and crucially row-height (not 100%).
    // The "command actions" feature defaults on, so the tick is interactive
    // (5px, pointer-events auto) — clicking opens the command menu.
    expect(painted[0]!.backgroundColor).toBe("#a1a1aa")
    expect(painted[0]!.width).toBe("5px")
    expect(painted[0]!.pointerEvents).toBe("auto")
    expect(painted[0]!.height).not.toBe("100%")
    expect(painted[0]!.height).toBe("17px") // xterm's per-row height is preserved
    // Recoloured marker after a non-zero exit.
    expect(painted[1]!.backgroundColor).toBe("#ef4444")
    expect(painted[1]!.height).not.toBe("100%")
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

  describe("autocomplete integration", () => {
    function captureKeyHandler() {
      const captured: { cb: ((e: KeyboardEvent) => boolean) | null } = { cb: null }
      mockTermInstance.attachCustomKeyEventHandler = jest.fn(
        (cb: (e: KeyboardEvent) => boolean) => {
          captured.cb = cb
        }
      )
      return captured
    }
    function key(over: Partial<KeyboardEvent>): KeyboardEvent {
      return {
        type: "keydown",
        key: "a",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        ...over,
      } as KeyboardEvent
    }

    it("renders the ghost overlay when there is a suggestion", async () => {
      mockAutocomplete.enabled = true
      mockAutocomplete.ghost = "status"
      mockAutocomplete.ghostSuggestion = { source: "ai" }
      const { container } = render(<TerminalInstance sessionId="s-1" />)
      await flushAsync()
      const ghost = container.querySelector('[data-testid="terminal-ghost-text"]')
      expect(ghost).toBeTruthy()
      expect(ghost?.textContent).toContain("status")
    })

    it("does not render the overlay when disabled", async () => {
      mockAutocomplete.enabled = false
      mockAutocomplete.ghost = "status"
      const { container } = render(<TerminalInstance sessionId="s-1" />)
      await flushAsync()
      expect(container.querySelector('[data-testid="terminal-ghost-text"]')).toBeNull()
    })

    it("feeds user keystrokes into the autocomplete model", async () => {
      const captured: { cb: ((text: string) => void) | null } = { cb: null }
      mockTermInstance.onData = jest.fn((cb: (text: string) => void) => {
        captured.cb = cb
        return { dispose: jest.fn() }
      })
      render(<TerminalInstance sessionId="s-1" />)
      await flushAsync()
      captured.cb?.("l")
      expect(mockAutocomplete.feed).toHaveBeenCalledWith("l")
    })

    it("accepts on Tab: writes the suffix to the PTY and swallows the key", async () => {
      mockAutocomplete.enabled = true
      mockAutocomplete.ghostSuggestion = { source: "ai" }
      mockAutocomplete.accept.mockReturnValue({ backspaces: 0, write: "status" })
      const captured = captureKeyHandler()
      render(<TerminalInstance sessionId="s-1" />)
      await flushAsync()
      const result = captured.cb!(key({ key: "Tab" }))
      expect(mockAutocomplete.accept).toHaveBeenCalled()
      expect(sessionRegistry.current!.write).toHaveBeenCalledWith("status")
      expect(result).toBe(false)
    })

    it("atomically erases a replaced span and writes the insert", async () => {
      mockAutocomplete.enabled = true
      mockAutocomplete.ghostSuggestion = { source: "path" }
      mockAutocomplete.accept.mockReturnValue({ backspaces: 3, write: "Documents/" })
      const captured = captureKeyHandler()
      render(<TerminalInstance sessionId="s-1" />)
      await flushAsync()
      const result = captured.cb!(key({ key: "Tab" }))
      const del = String.fromCharCode(0x7f)
      expect(sessionRegistry.current!.write).toHaveBeenCalledTimes(1)
      expect(sessionRegistry.current!.write).toHaveBeenCalledWith(`${del.repeat(3)}Documents/`)
      expect(result).toBe(false)
    })

    it("lets Tab through to the shell when there is no suggestion", async () => {
      mockAutocomplete.enabled = true
      mockAutocomplete.ghostSuggestion = { source: "ai" }
      mockAutocomplete.accept.mockReturnValue(null) // not at end / nothing to accept
      const captured = captureKeyHandler()
      render(<TerminalInstance sessionId="s-1" />)
      await flushAsync()
      const result = captured.cb!(key({ key: "Tab" }))
      expect(result).toBe(true) // falls through to xterm default
    })

    it("opens the popup on Ctrl+Space when enabled", async () => {
      mockAutocomplete.enabled = true
      mockAutocomplete.popupEnabled = true
      const captured = captureKeyHandler()
      render(<TerminalInstance sessionId="s-1" />)
      await flushAsync()
      const result = captured.cb!(key({ key: " ", code: "Space", ctrlKey: true }))
      expect(mockAutocomplete.openList).toHaveBeenCalled()
      expect(result).toBe(false)
    })

    it("does not open the popup when the popup setting is off", async () => {
      mockAutocomplete.enabled = true
      mockAutocomplete.popupEnabled = false
      const captured = captureKeyHandler()
      render(<TerminalInstance sessionId="s-1" />)
      await flushAsync()
      captured.cb!(key({ key: " ", code: "Space", ctrlKey: true }))
      expect(mockAutocomplete.openList).not.toHaveBeenCalled()
    })

    it("routes ArrowUp/ArrowDown/Esc to the popup while open", async () => {
      mockAutocomplete.enabled = true
      mockAutocomplete.popupEnabled = true
      mockAutocomplete.listOpen = true
      const captured = captureKeyHandler()
      render(<TerminalInstance sessionId="s-1" />)
      await flushAsync()
      expect(captured.cb!(key({ key: "ArrowDown" }))).toBe(false)
      expect(mockAutocomplete.moveSelection).toHaveBeenCalledWith(1)
      expect(captured.cb!(key({ key: "ArrowUp" }))).toBe(false)
      expect(mockAutocomplete.moveSelection).toHaveBeenCalledWith(-1)
      expect(captured.cb!(key({ key: "Escape" }))).toBe(false)
      expect(mockAutocomplete.closeList).toHaveBeenCalled()
    })

    it("accepts the highlighted candidate on Enter while the popup is open", async () => {
      mockAutocomplete.enabled = true
      mockAutocomplete.popupEnabled = true
      mockAutocomplete.listOpen = true
      mockAutocomplete.acceptSelected.mockReturnValue({ backspaces: 2, write: "src/" })
      const captured = captureKeyHandler()
      render(<TerminalInstance sessionId="s-1" />)
      await flushAsync()
      const result = captured.cb!(key({ key: "Enter" }))
      const del = String.fromCharCode(0x7f)
      expect(sessionRegistry.current!.write).toHaveBeenCalledTimes(1)
      expect(sessionRegistry.current!.write).toHaveBeenCalledWith(`${del.repeat(2)}src/`)
      expect(result).toBe(false)
    })

    it("atomically applies a replacement selected with the pointer", async () => {
      mockAutocomplete.enabled = true
      mockAutocomplete.popupEnabled = true
      mockAutocomplete.listOpen = true
      mockAutocomplete.candidates = [
        { text: "cd src/", source: "path", providerId: "builtin:path" },
      ]
      mockAutocomplete.acceptSelected.mockReturnValue({ backspaces: 2, write: "src/" })
      const { getByTestId } = render(<TerminalInstance sessionId="s-1" />)
      await flushAsync()
      fireEvent.mouseDown(getByTestId("terminal-completion-candidate-0"))
      const del = String.fromCharCode(0x7f)
      expect(sessionRegistry.current!.write).toHaveBeenCalledTimes(1)
      expect(sessionRegistry.current!.write).toHaveBeenCalledWith(`${del.repeat(2)}src/`)
    })

    it("opens the popup on a second Tab when candidates exist but no ghost", async () => {
      mockAutocomplete.enabled = true
      mockAutocomplete.popupEnabled = true
      mockAutocomplete.accept.mockReturnValue(null)
      mockAutocomplete.candidates = [{ text: "cd src/" }]
      const captured = captureKeyHandler()
      render(<TerminalInstance sessionId="s-1" />)
      await flushAsync()
      const result = captured.cb!(key({ key: "Tab" }))
      expect(mockAutocomplete.openList).toHaveBeenCalled()
      expect(result).toBe(false)
    })

    it("renders the completion popup while the list is open", async () => {
      mockAutocomplete.enabled = true
      mockAutocomplete.popupEnabled = true
      mockAutocomplete.listOpen = true
      mockAutocomplete.candidates = [
        { text: "git status", source: "history", providerId: "builtin:history" },
      ]
      const { container } = render(<TerminalInstance sessionId="s-1" />)
      await flushAsync()
      expect(container.querySelector('[data-testid="terminal-completion-popup"]')).toBeTruthy()
    })

    it("dismisses on Escape when a suggestion is active", async () => {
      mockAutocomplete.enabled = true
      mockAutocomplete.ghostSuggestion = { source: "history" }
      const captured = captureKeyHandler()
      render(<TerminalInstance sessionId="s-1" />)
      await flushAsync()
      const result = captured.cb!(key({ key: "Escape" }))
      expect(mockAutocomplete.dismiss).toHaveBeenCalled()
      expect(result).toBe(false)
    })

    it("resets the autocomplete line on a new prompt", async () => {
      const captured: { cb: ((ev: { kind: string }) => void) | null } = { cb: null }
      sessionRegistry.current!.onIntegration = jest.fn((cb: (ev: { kind: string }) => void) => {
        captured.cb = cb
        return () => undefined
      })
      render(<TerminalInstance sessionId="s-1" />)
      await flushAsync()
      captured.cb?.({ kind: "prompt_start" })
      expect(mockAutocomplete.reset).toHaveBeenCalled()
    })
  })
})

describe("TerminalInstance stylesheet", () => {
  // Regression guard: xterm.js relies on its own stylesheet to absolutely
  // position the viewport, screen, and renderer canvases. If this side-effect
  // import is dropped, every row collapses into the top-left corner — a layout
  // bug jsdom can't surface, so we assert the import at the source level.
  it("imports the xterm stylesheet", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs") as typeof import("node:fs")
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require("node:path") as typeof import("node:path")
    const source = readFileSync(join(__dirname, "terminal-instance.tsx"), "utf8")
    expect(source).toMatch(/import\s+["']@xterm\/xterm\/css\/xterm\.css["']/)
  })
})
