/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/components/ui/popover")
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/hooks/browser/use-local-browser-session", () => ({
  useLocalBrowserSession: jest.fn(),
}))
jest.mock("@/hooks/browser/use-shared-local-browser", () => ({
  useSharedLocalBrowser: jest.fn(),
}))
jest.mock("@/hooks/browser/use-local-file-chooser", () => ({
  useLocalFileChooser: jest.fn(),
}))
jest.mock("@/lib/browser/local-client", () => ({
  localBrowser: { rpc: jest.fn(), onEvent: jest.fn(async () => () => undefined) },
}))
// The rail is tested on its own and reaches Dexie; record what the pane hands it.
let mockRailProps: Record<string, unknown> | null = null
jest.mock("@/components/browser/browser-inspection-rail", () => ({
  BrowserInspectionRail: (props: Record<string, unknown>) => {
    mockRailProps = props
    return <div data-testid="inspection-rail" />
  },
}))
jest.mock("@/components/browser/browser-address", () => ({
  resolveBrowserAddress: jest.fn(),
}))
jest.mock("@/hooks/browser/use-selection-to-chat", () => ({
  useSelectionToChat: jest.fn(),
}))
jest.mock("@/hooks/browser/use-recent-pages", () => ({
  useRecentPages: () => ({ recent: [], clear: jest.fn() }),
}))
jest.mock("@/hooks/browser/use-browser-history", () => ({
  useBrowserHistory: () => ({
    push: mockPushHistory,
    goBack: () => "https://prev.example/",
    goForward: () => null,
    canGoBack: true,
    canGoForward: false,
  }),
}))
jest.mock("@/components/browser/remote-browser-preview", () => ({
  EngineRecorder: () => <div data-testid="engine-recorder" />,
}))
jest.mock("@/components/browser/browser-downloads-panel", () => ({
  BrowserDownloadsButton: ({ chatSessionId }: { chatSessionId?: string }) => (
    <div data-testid="downloads-button">{chatSessionId}</div>
  ),
}))
jest.mock("@/components/browser/browser-empty-state", () => ({
  BrowserEmptyState: ({ onOpen }: { onOpen: (url: string) => void }) => (
    <button type="button" onClick={() => onOpen("http://localhost:5173")}>
      empty-state
    </button>
  ),
}))
jest.mock("@/components/browser/extensions/browser-extensions-panel", () => ({
  BrowserExtensionsPanel: ({ backend, sessionId }: { backend: string; sessionId?: string }) => (
    <div data-testid="extensions-panel">{`${backend}:${sessionId}`}</div>
  ),
}))
jest.mock("@/components/browser/browser-cookie-import-action", () => ({
  BrowserCookieImportAction: (props: {
    backend: string
    sessionId?: string
    currentUrl: string | null
    onReload: () => Promise<void>
  }) => (
    <button type="button" data-testid="cookie-action" onClick={() => void props.onReload()}>
      {`${props.backend}:${props.sessionId}:${props.currentUrl}`}
    </button>
  ),
}))
jest.mock("@/components/browser/vault/browser-autofill-prompt", () => ({
  BrowserAutofillPrompt: (props: {
    backend: string
    sessionId?: string
    pageId?: string
    url: string
  }) => (
    <div data-testid="autofill">{`${props.backend}:${props.sessionId}:${props.pageId}:${props.url}`}</div>
  ),
}))
jest.mock("@/components/browser/vault/browser-save-password-prompt", () => ({
  BrowserSavePasswordPrompt: ({ sessionId }: { sessionId?: string }) => (
    <div data-testid="save-password">{sessionId}</div>
  ),
}))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn() }))

const mockPushHistory = jest.fn()

import { toast } from "sonner"

import { resolveBrowserAddress } from "@/components/browser/browser-address"
import {
  useLocalBrowserSession,
  type LocalBrowserSession,
} from "@/hooks/browser/use-local-browser-session"
import {
  useSharedLocalBrowser,
  type SharedLocalBrowserPane,
} from "@/hooks/browser/use-shared-local-browser"
import { useLocalFileChooser } from "@/hooks/browser/use-local-file-chooser"
import { useSelectionToChat } from "@/hooks/browser/use-selection-to-chat"
import { localBrowser } from "@/lib/browser/local-client"
import { openExternal } from "@/lib/tauri/opener"

import { LocalChromiumPreview } from "./local-chromium-preview"

const userChromeMock = useLocalBrowserSession as jest.Mock
const sharedMock = useSharedLocalBrowser as jest.Mock
const resolveMock = resolveBrowserAddress as jest.Mock
const rpcMock = localBrowser.rpc as jest.Mock
const sendScreenshotBytes = jest.fn()

function makeEngine() {
  return {
    navigate: jest.fn().mockResolvedValue(undefined),
    back: jest.fn().mockResolvedValue(undefined),
    forward: jest.fn().mockResolvedValue(undefined),
    reload: jest.fn().mockResolvedValue(undefined),
    activatePage: jest.fn().mockResolvedValue(undefined),
    closePage: jest.fn().mockResolvedValue(undefined),
    createPage: jest.fn().mockResolvedValue(undefined),
    screenshot: jest.fn().mockResolvedValue({ bytes: "AAAA" }),
    handleDialog: jest.fn().mockResolvedValue({}),
    setZoom: jest.fn().mockResolvedValue({}),
    find: jest.fn().mockResolvedValue({ matches: 0, index: 0 }),
    findClear: jest.fn().mockResolvedValue(undefined),
    readConsole: jest.fn().mockResolvedValue([]),
    readNetwork: jest.fn().mockResolvedValue([]),
    sessionId: "pane-1",
    setSelectMode: jest.fn().mockResolvedValue(undefined),
    drainSelection: jest.fn().mockResolvedValue([]),
    clearSelection: jest.fn().mockResolvedValue(undefined),
    adjust: jest.fn().mockResolvedValue('{"ok":true}'),
  }
}

type TestSession = LocalBrowserSession & SharedLocalBrowserPane

function makeSession(overrides: Partial<TestSession> = {}): TestSession {
  return {
    state: "ready",
    error: null,
    sessionId: "pane-1",
    engine: makeEngine() as unknown as LocalBrowserSession["engine"],
    pages: [
      { id: "p1", url: "https://example.com/", title: "Example", active: true },
      { id: "p2", url: "https://other.example/", title: "", active: false },
    ],
    activePageId: "p1",
    dialog: null,
    dismissDialog: jest.fn(),
    refreshPages: jest.fn().mockResolvedValue(undefined),
    restart: jest.fn(),
    answerDialog: jest.fn().mockResolvedValue(undefined),
    restoring: false,
    selectPage: jest.fn(),
    createPage: jest.fn().mockResolvedValue(undefined),
    closePage: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  rpcMock.mockResolvedValue(undefined)
  ;(useSelectionToChat as jest.Mock).mockReturnValue({ sendScreenshotBytes, sendText: jest.fn() })
})

function renderPreview(
  session: TestSession,
  props: Partial<React.ComponentProps<typeof LocalChromiumPreview>> = {}
) {
  userChromeMock.mockReturnValue(session)
  sharedMock.mockReturnValue(session)
  return render(<LocalChromiumPreview backend="local-chromium" chatSessionId="chat-1" {...props} />)
}

describe("adaptive viewport", () => {
  let size: { width: number; height: number }
  let observers: { callback: ResizeObserverCallback; elements: Set<Element> }[]

  beforeEach(() => {
    jest.useFakeTimers()
    size = { width: 830, height: 1450 }
    observers = []
    jest.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      return this.querySelector("canvas") ? size.width : 0
    })
    jest.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      return this.querySelector("canvas") ? size.height : 0
    })
    jest.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      ...size,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: size.width,
      bottom: size.height,
      toJSON: () => ({}),
    }))
    jest.spyOn(globalThis, "ResizeObserver").mockImplementation((callback) => {
      const elements = new Set<Element>()
      observers.push({ callback, elements })
      return {
        observe: (element) => {
          elements.add(element)
        },
        unobserve: (element) => {
          elements.delete(element)
        },
        disconnect: () => {
          elements.clear()
        },
      }
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  async function settleResize() {
    await act(async () => {
      jest.advanceTimersByTime(150)
    })
  }

  function notifyResize() {
    const canvas = screen.getByRole("application", { name: "Local browser page" })
    const observer = observers.find(({ elements }) => elements.has(canvas.parentElement!))
    expect(observer).toBeDefined()
    act(() => observer!.callback([], {} as ResizeObserver))
  }

  it.each(["local-chromium", "user-chrome"] as const)(
    "fits %s to the content area on opening",
    async (backend) => {
      renderPreview(makeSession(), { backend })
      await settleResize()
      expect(rpcMock).toHaveBeenCalledWith("browser.emulate", {
        sessionId: "pane-1",
        pageId: "p1",
        viewport: { ...size, deviceScaleFactor: 1, fitToWidth: true },
      })
    }
  )

  it("coalesces splitter changes and skips unchanged dimensions", async () => {
    renderPreview(makeSession())
    await settleResize()
    rpcMock.mockClear()
    size = { width: 650, height: 1450 }
    notifyResize()
    size = { width: 600, height: 1450 }
    notifyResize()
    await settleResize()
    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(rpcMock).toHaveBeenLastCalledWith(
      "browser.emulate",
      expect.objectContaining({ viewport: { ...size, deviceScaleFactor: 1, fitToWidth: true } })
    )
    notifyResize()
    await settleResize()
    expect(rpcMock).toHaveBeenCalledTimes(1)
  })

  it("follows window resizing and the height left after expanding Console", async () => {
    renderPreview(makeSession())
    await settleResize()
    size = { width: 720, height: 1000 }
    fireEvent(window, new Event("resize"))
    await settleResize()
    expect(rpcMock).toHaveBeenLastCalledWith(
      "browser.emulate",
      expect.objectContaining({ viewport: { ...size, deviceScaleFactor: 1, fitToWidth: true } })
    )
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    await user.click(screen.getByRole("tab", { name: /Console/ }))
    expect(screen.getByRole("button", { name: "Collapse browser tools" })).toBeInTheDocument()
    size = { width: 720, height: 740 }
    notifyResize()
    await settleResize()
    expect(rpcMock).toHaveBeenLastCalledWith(
      "browser.emulate",
      expect.objectContaining({ viewport: { ...size, deviceScaleFactor: 1, fitToWidth: true } })
    )
  })

  it("serializes in-flight resizes and delivers only the latest pending size", async () => {
    let finish!: () => void
    rpcMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    renderPreview(makeSession())
    await settleResize()
    size = { width: 650, height: 1100 }
    notifyResize()
    await settleResize()
    size = { width: 600, height: 900 }
    notifyResize()
    await settleResize()
    expect(rpcMock).toHaveBeenCalledTimes(1)
    await act(async () => finish())
    await settleResize()
    expect(rpcMock).toHaveBeenCalledTimes(2)
    expect(rpcMock).toHaveBeenLastCalledWith(
      "browser.emulate",
      expect.objectContaining({ viewport: { ...size, deviceScaleFactor: 1, fitToWidth: true } })
    )
  })

  it("ignores hidden content and cancels pending work on unmount", async () => {
    size = { width: 0, height: 0 }
    const { unmount } = renderPreview(makeSession())
    await settleResize()
    expect(rpcMock).not.toHaveBeenCalled()
    size = { width: 830, height: 1450 }
    notifyResize()
    unmount()
    await settleResize()
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it("fits the new page when switching tabs without a layout change", async () => {
    const session = makeSession()
    const { rerender } = renderPreview(session)
    await settleResize()
    session.activePageId = "p2"
    rerender(<LocalChromiumPreview backend="local-chromium" />)
    await settleResize()
    expect(rpcMock).toHaveBeenLastCalledWith("browser.emulate", {
      sessionId: "pane-1",
      pageId: "p2",
      viewport: { ...size, deviceScaleFactor: 1, fitToWidth: true },
    })
  })

  it("reports a failed resize and retries on the next measurement", async () => {
    rpcMock.mockRejectedValueOnce(new Error("resize failed"))
    renderPreview(makeSession())
    await settleResize()
    expect(toast.error).toHaveBeenCalled()
    notifyResize()
    await settleResize()
    expect(rpcMock).toHaveBeenCalledTimes(2)
  })

  it("keeps resizes ordered when switching away and back with a request in flight", async () => {
    let finish!: () => void
    rpcMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const session = makeSession()
    const { rerender } = renderPreview(session)
    await settleResize()
    session.activePageId = "p2"
    size = { width: 700, height: 1100 }
    rerender(<LocalChromiumPreview backend="local-chromium" />)
    await settleResize()
    session.activePageId = "p1"
    size = { width: 600, height: 900 }
    rerender(<LocalChromiumPreview backend="local-chromium" />)
    await settleResize()
    expect(rpcMock).toHaveBeenCalledTimes(1)
    await act(async () => finish())
    expect(rpcMock).toHaveBeenCalledTimes(2)
    expect(rpcMock).toHaveBeenLastCalledWith("browser.emulate", {
      sessionId: "pane-1",
      pageId: "p1",
      viewport: { ...size, deviceScaleFactor: 1, fitToWidth: true },
    })
  })

  it("defers resizing during a page dialog and measures again after dismissal", async () => {
    const session = makeSession({ dialog: { type: "alert", message: "Wait" } })
    const { rerender } = renderPreview(session)
    await settleResize()
    expect(rpcMock).not.toHaveBeenCalled()
    session.dialog = null
    rerender(<LocalChromiumPreview backend="local-chromium" />)
    await settleResize()
    expect(rpcMock).toHaveBeenLastCalledWith("browser.emulate", {
      sessionId: "pane-1",
      pageId: "p1",
      viewport: { ...size, deviceScaleFactor: 1, fitToWidth: true },
    })
  })

  it("uses the available content box independently of the canvas intrinsic dimensions", async () => {
    jest.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1280,
      height: 720,
      left: 0,
      top: 0,
      right: 1280,
      bottom: 720,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    renderPreview(makeSession())
    await settleResize()
    expect(rpcMock).toHaveBeenLastCalledWith("browser.emulate", {
      sessionId: "pane-1",
      pageId: "p1",
      viewport: { ...size, deviceScaleFactor: 1, fitToWidth: true },
    })
  })

  it("keeps CSS layout size while matching the screen's pixel density", async () => {
    jest.replaceProperty(window, "devicePixelRatio", 2)
    renderPreview(makeSession())
    await settleResize()
    expect(rpcMock).toHaveBeenLastCalledWith("browser.emulate", {
      sessionId: "pane-1",
      pageId: "p1",
      viewport: { ...size, deviceScaleFactor: 2, fitToWidth: true },
    })
  })

  it("updates density without changing CSS size and cleans up the resolution listener", async () => {
    let densityChanged: EventListener | undefined
    const remove = jest.fn()
    const media = jest.spyOn(window, "matchMedia").mockImplementation((query) => ({
      media: query,
      matches: false,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
      removeEventListener: remove,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        densityChanged = listener as EventListener
      },
    }))
    const { unmount } = renderPreview(makeSession())
    await settleResize()
    jest.replaceProperty(window, "devicePixelRatio", 2)
    act(() => densityChanged!(new Event("change")))
    await settleResize()
    expect(rpcMock).toHaveBeenLastCalledWith("browser.emulate", {
      sessionId: "pane-1",
      pageId: "p1",
      viewport: { ...size, deviceScaleFactor: 2, fitToWidth: true },
    })
    expect(media).toHaveBeenLastCalledWith("(resolution: 2dppx)")
    expect(remove.mock.calls.filter(([, listener]) => listener === densityChanged)).toHaveLength(1)
    unmount()
    expect(remove.mock.calls.filter(([, listener]) => listener === densityChanged)).toHaveLength(2)
  })
})

it("preserves high-density bitmap pixels while mapping input in CSS page coordinates", async () => {
  const original = globalThis.createImageBitmap
  const bitmap = { width: 1660, height: 2900, close: jest.fn() }
  globalThis.createImageBitmap = jest.fn().mockResolvedValue(bitmap)
  try {
    renderPreview(makeSession())
    const canvas = screen.getByRole("application", {
      name: "Local browser page",
    }) as HTMLCanvasElement
    const drawImage = jest.fn()
    Object.defineProperty(canvas, "getContext", {
      configurable: true,
      value: () => ({ drawImage }),
    })
    const frame = new Uint8Array(25)
    const header = new DataView(frame.buffer)
    header.setUint8(0, 1)
    header.setUint8(1, 1)
    header.setUint16(2, 24)
    header.setUint16(8, 830)
    header.setUint16(10, 1450)
    header.setUint32(20, 1)
    await act(async () => sharedMock.mock.calls[0][0].onFrame(frame))
    expect(canvas.width).toBe(1660)
    expect(canvas.height).toBe(2900)
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0)
    jest.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      width: 830,
      height: 1450,
      left: 0,
      top: 0,
      right: 830,
      bottom: 1450,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    fireEvent.pointerDown(canvas, { clientX: 415, clientY: 725 })
    expect(rpcMock).toHaveBeenLastCalledWith(
      "browser.input",
      expect.objectContaining({
        input: { kind: "mouse", payload: expect.objectContaining({ x: 415, y: 725 }) },
      })
    )
  } finally {
    globalThis.createImageBitmap = original
    jest.restoreAllMocks()
  }
})

it("renders tabs, the address of the active tab and the vault prompts", () => {
  renderPreview(makeSession())
  expect(screen.getByRole("tab", { name: "Example" })).toHaveAttribute("aria-selected", "true")
  expect(screen.getByRole("tab", { name: "https://other.example/" })).toBeInTheDocument()
  expect(screen.getByTestId("autofill")).toHaveTextContent(
    "local-chromium:pane-1:p1:https://example.com/"
  )
  expect(screen.getByTestId("save-password")).toHaveTextContent("pane-1")
  expect(screen.getByTestId("downloads-button")).toHaveTextContent("chat-1")
  expect(screen.getByTestId("extensions-panel")).toHaveTextContent("local-chromium:pane-1")
  expect(mockPushHistory).toHaveBeenCalledWith("https://example.com/")
})

it("shows the effective fitted zoom and preserves manual zoom mode on resize", async () => {
  const page = {
    id: "p1",
    url: "https://wide.test/",
    title: "Wide",
    active: true,
    zoom: 0.65625,
    fitToWidth: true,
  }
  const session = makeSession({ pages: [page] })
  renderPreview(session)
  expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveTextContent("66%")
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
  await waitFor(() => expect(session.refreshPages).toHaveBeenCalled())
  const engine = session.engine as unknown as ReturnType<typeof makeEngine>
  expect(engine.setZoom).toHaveBeenCalledWith(0.67)
})

it("answers the session's file choosers with staged uploads", () => {
  renderPreview(makeSession())
  expect(useLocalFileChooser).toHaveBeenLastCalledWith("pane-1")
})

it("manages the pane's own pages in the shared session", async () => {
  const session = makeSession()
  renderPreview(session)
  await act(async () => {
    fireEvent.click(screen.getByRole("tab", { name: "https://other.example/" }))
    fireEvent.click(screen.getAllByRole("button", { name: "Close tab" })[0])
    fireEvent.click(screen.getByRole("button", { name: "New tab" }))
  })
  expect(session.selectPage).toHaveBeenCalledWith("p2")
  expect(session.closePage).toHaveBeenCalledWith("p1")
  expect(session.createPage).toHaveBeenCalled()
  expect(session.refreshPages).toHaveBeenCalled()
  expect(userChromeMock).not.toHaveBeenCalled()
  expect(sharedMock).toHaveBeenCalledWith(
    expect.objectContaining({ owner: expect.stringMatching(/^pane:/), tag: undefined })
  )
})

it("manages the user's Chrome tabs through its own session's engine", async () => {
  const session = makeSession()
  renderPreview(session, { backend: "user-chrome" })
  const engine = session.engine as unknown as ReturnType<typeof makeEngine>
  await act(async () => {
    fireEvent.click(screen.getByRole("tab", { name: "https://other.example/" }))
    fireEvent.click(screen.getAllByRole("button", { name: "Close tab" })[0])
    fireEvent.click(screen.getByRole("button", { name: "New tab" }))
  })
  expect(engine.activatePage).toHaveBeenCalledWith("p2")
  expect(engine.closePage).toHaveBeenCalledWith("p1")
  expect(engine.createPage).toHaveBeenCalled()
  expect(sharedMock).not.toHaveBeenCalled()
})

it("shows one dock page tab without a tab row of its own", () => {
  renderPreview(makeSession(), {
    owner: "chat:s1",
    pageTag: "t1",
    hideTabRow: true,
    initialUrl: "https://remembered.test/",
    toolbarExtras: <span data-testid="engine-chip" />,
  })
  expect(sharedMock).toHaveBeenCalledWith(
    expect.objectContaining({
      owner: "chat:s1",
      tag: "t1",
      initialUrl: "https://remembered.test/",
    })
  )
  expect(screen.queryByRole("tablist", { name: "Tabs" })).toBeNull()
  expect(screen.queryByRole("button", { name: "New tab" })).toBeNull()
  expect(screen.getByTestId("engine-chip")).toBeInTheDocument()
})

it("says a remembered page is being opened again", () => {
  renderPreview(makeSession({ state: "starting", restoring: true }))
  expect(screen.getByText("Reopening this page…")).toBeInTheDocument()
})

it("navigates a typed address, including local files", async () => {
  const session = makeSession()
  resolveMock.mockResolvedValue({ kind: "url", url: "file:///tmp/a.html", local: true })
  renderPreview(session)
  const input = screen.getByRole("textbox")
  fireEvent.change(input, { target: { value: "/tmp/a.html" } })
  await act(async () => {
    fireEvent.submit(input.closest("form") as HTMLFormElement)
  })
  expect(resolveMock).toHaveBeenCalledWith("/tmp/a.html", "chromium")
  const engine = session.engine as unknown as ReturnType<typeof makeEngine>
  expect(engine.navigate).toHaveBeenCalledWith("file:///tmp/a.html")
})

it("explains an address it cannot open", async () => {
  renderPreview(makeSession())
  const input = screen.getByRole("textbox")
  resolveMock.mockResolvedValueOnce({ kind: "invalid" })
  fireEvent.change(input, { target: { value: "::" } })
  await act(async () => {
    fireEvent.submit(input.closest("form") as HTMLFormElement)
  })
  expect(toast.error).toHaveBeenCalledWith("Could not navigate to that URL")
  resolveMock.mockResolvedValueOnce({ kind: "error", message: "not_found" })
  await act(async () => {
    fireEvent.submit(input.closest("form") as HTMLFormElement)
  })
  expect(toast.error).toHaveBeenCalledWith("Could not open that local file: not_found")
})

it("keeps navigation failures visible and retries the failed address", async () => {
  const session = makeSession()
  const engine = session.engine as unknown as ReturnType<typeof makeEngine>
  engine.navigate.mockRejectedValueOnce(new Error("net::ERR_CONNECTION_REFUSED"))
  resolveMock.mockResolvedValue({ kind: "url", url: "http://localhost:9999/", local: false })
  renderPreview(session)
  const input = screen.getByRole("textbox")
  fireEvent.change(input, { target: { value: "http://localhost:9999/" } })
  await act(async () => fireEvent.submit(input.closest("form") as HTMLFormElement))
  expect(screen.getByRole("alert")).toHaveTextContent("localhost:9999")
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })))
  expect(engine.navigate).toHaveBeenLastCalledWith("http://localhost:9999/")
  expect(screen.queryByRole("alert")).toBeNull()
})

it("shows the latest failed address when editing an unsuccessful first load", async () => {
  const session = makeSession({ state: "failed", error: "net::ERR_CONNECTION_REFUSED" })
  const engine = session.engine as unknown as ReturnType<typeof makeEngine>
  engine.navigate.mockRejectedValueOnce(new Error("net::ERR_CONNECTION_REFUSED"))
  resolveMock.mockResolvedValue({ kind: "url", url: "https://edited.test/", local: false })
  renderPreview(session, { initialUrl: "https://initial.test/" })
  const input = screen.getByRole("textbox")
  fireEvent.change(input, { target: { value: "https://edited.test/" } })
  await act(async () => fireEvent.submit(input.closest("form") as HTMLFormElement))
  expect(screen.getAllByRole("alert")).toHaveLength(1)
  expect(screen.getByRole("alert")).toHaveTextContent("https://edited.test/")
  expect(screen.getByRole("alert")).not.toHaveTextContent("https://initial.test/")
})

it("keeps the failed destination in the address bar when Chromium reports its internal error page", () => {
  renderPreview(
    makeSession({
      state: "failed",
      error: "net::ERR_CONNECTION_REFUSED",
      pages: [{ id: "p1", url: "chrome-error://chromewebdata/", title: "", active: true }],
    }),
    { initialUrl: "http://localhost:8765/spa" }
  )
  expect(screen.getByRole("alert")).toHaveTextContent("http://localhost:8765/spa")
  expect(screen.getByRole("textbox")).toHaveValue("http://localhost:8765/spa")
  fireEvent.click(screen.getAllByRole("button", { name: "Open in external browser" })[0])
  expect(openExternal).toHaveBeenCalledWith("http://localhost:8765/spa")
})

it("ignores late error-page updates without replacing edits or another tab's address", async () => {
  const session = makeSession()
  const engine = session.engine as unknown as ReturnType<typeof makeEngine>
  engine.navigate.mockRejectedValueOnce(new Error("net::ERR_CONNECTION_REFUSED"))
  resolveMock.mockResolvedValue({ kind: "url", url: "http://localhost:8765/spa", local: false })
  const { rerender } = renderPreview(session)
  const input = screen.getByRole("textbox")
  fireEvent.change(input, { target: { value: "http://localhost:8765/spa" } })
  await act(async () => fireEvent.submit(input.closest("form") as HTMLFormElement))
  session.pages[0].url = "chrome-error://chromewebdata/"
  rerender(<LocalChromiumPreview backend="local-chromium" />)
  expect(input).toHaveValue("http://localhost:8765/spa")
  fireEvent.click(screen.getByRole("button", { name: "Edit address" }))
  fireEvent.change(input, { target: { value: "http://localhost:8765/fixed" } })
  rerender(<LocalChromiumPreview backend="local-chromium" />)
  expect(input).toHaveValue("http://localhost:8765/fixed")
  fireEvent.blur(input)
  session.activePageId = "p2"
  rerender(<LocalChromiumPreview backend="local-chromium" />)
  expect(input).toHaveValue("https://other.example/")
  expect(screen.queryByRole("alert")).toBeNull()
})

it("follows a host-requested address once the session is ready", async () => {
  const session = makeSession()
  resolveMock.mockResolvedValue({ kind: "url", url: "https://req.example/", local: false })
  renderPreview(session, { requestedUrl: "https://req.example/", requestNonce: 1 })
  const engine = session.engine as unknown as ReturnType<typeof makeEngine>
  await waitFor(() => expect(engine.navigate).toHaveBeenCalledWith("https://req.example/"))
})

it("does not re-navigate the initial address the session already loaded", async () => {
  const session = makeSession()
  renderPreview(session, {
    initialUrl: "https://example.com/",
    requestedUrl: "https://example.com/",
    requestNonce: 0,
  })
  await act(async () => undefined)
  expect(resolveMock).not.toHaveBeenCalled()
})

it("forwards native input to the runtime, one event at a time in order", async () => {
  renderPreview(makeSession())
  const canvas = screen.getByRole("application", { name: "Local browser page" })
  await act(async () => {
    fireEvent.pointerDown(canvas, { clientX: 1, clientY: 1 })
    fireEvent.pointerUp(canvas, { clientX: 1, clientY: 1 })
    fireEvent.keyDown(canvas, { key: "a", code: "KeyA" })
    fireEvent.wheel(canvas, { deltaY: 40 })
  })
  const kinds = rpcMock.mock.calls.map(([, payload]) => payload.input.payload.type)
  expect(kinds).toEqual(["mousePressed", "mouseReleased", "keyDown", "mouseWheel"])
  expect(rpcMock.mock.calls[2]).toEqual([
    "browser.input",
    {
      sessionId: "pane-1",
      input: {
        kind: "key",
        payload: { type: "keyDown", key: "a", code: "KeyA", modifiers: 0, text: "a" },
      },
    },
  ])
})

it("holds input behind the event in flight and coalesces the moves and wheels waiting", async () => {
  let finish: () => void = () => undefined
  rpcMock.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  renderPreview(makeSession())
  const canvas = screen.getByRole("application", { name: "Local browser page" })
  fireEvent.pointerDown(canvas, { clientX: 1, clientY: 1 })
  fireEvent.pointerMove(canvas, { clientX: 1, clientY: 1 })
  fireEvent.pointerMove(canvas, { clientX: 2, clientY: 2 })
  fireEvent.wheel(canvas, { deltaY: 40 })
  fireEvent.wheel(canvas, { deltaY: 60 })
  // Only the press is out; the rest waits for it.
  expect(rpcMock).toHaveBeenCalledTimes(1)
  for (let index = 0; index < 3; index += 1) {
    await act(async () => finish())
  }
  const sent = rpcMock.mock.calls.map(([, payload]) => payload.input.payload)
  expect(sent.map((payload) => payload.type)).toEqual(["mousePressed", "mouseMoved", "mouseWheel"])
  expect(sent[2]).toMatchObject({ deltaY: 100 })
})

it("answers a page dialog through the session", async () => {
  const session = makeSession({ dialog: { type: "confirm", message: "Sure?" } })
  renderPreview(session)
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "OK" }))
  })
  expect(session.answerDialog).toHaveBeenCalledWith({ accept: true })
})

it("answers the user's Chrome dialog through its engine", async () => {
  const session = makeSession({ dialog: { type: "confirm", message: "Sure?" } })
  renderPreview(session, { backend: "user-chrome" })
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "OK" }))
  })
  expect(session.dismissDialog).toHaveBeenCalled()
  const engine = session.engine as unknown as ReturnType<typeof makeEngine>
  expect(engine.handleDialog).toHaveBeenCalledWith({ accept: true })
})

it("sends a screenshot to the chat", async () => {
  sendScreenshotBytes.mockResolvedValue(true)
  renderPreview(makeSession())
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send screenshot to chat" }))
  })
  expect(sendScreenshotBytes).toHaveBeenCalledWith("AAAA", {
    sessionId: "chat-1",
    pageUrl: "https://example.com/",
  })
  expect(toast.success).toHaveBeenCalled()
})

it("hands cookie import this session and reloads after an import", async () => {
  const session = makeSession()
  renderPreview(session)
  const action = screen.getByTestId("cookie-action")
  expect(action).toHaveTextContent("local-chromium:pane-1:https://example.com/")
  await act(async () => {
    fireEvent.click(action)
  })
  const engine = session.engine as unknown as ReturnType<typeof makeEngine>
  expect(engine.reload).toHaveBeenCalled()
})

it("goes back through the engine when history allows", async () => {
  const session = makeSession()
  renderPreview(session)
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
  })
  const engine = session.engine as unknown as ReturnType<typeof makeEngine>
  expect(engine.back).toHaveBeenCalled()
})

it("hides extensions when attached to the user's Chrome", () => {
  renderPreview(makeSession(), { backend: "user-chrome" })
  expect(screen.queryByTestId("extensions-panel")).toBeNull()
})

it("shows a starting state", () => {
  renderPreview(makeSession({ state: "starting", engine: null, pages: [], sessionId: null }))
  expect(screen.getByText("Starting the local browser…")).toBeInTheDocument()
  expect(screen.queryByTestId("save-password")).toBeNull()
})

it("offers a restart and the engine switch when the session failed or ended", () => {
  const session = makeSession({ state: "failed", error: "browser_local_not_installed" })
  const { rerender } = renderPreview(session, { backendSwitcher: <div>switcher</div> })
  expect(screen.getByRole("alert")).toHaveTextContent(
    "The local browser could not start: browser_local_not_installed"
  )
  expect(screen.getAllByText("switcher").length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole("button", { name: "Start again" }))
  expect(session.restart).toHaveBeenCalled()

  sharedMock.mockReturnValue(makeSession({ state: "closed" }))
  rerender(<LocalChromiumPreview backend="local-chromium" />)
  expect(screen.getByRole("alert")).toHaveTextContent("The browser session ended.")
})

it("offers the empty state on a blank tab", async () => {
  const session = makeSession({
    pages: [{ id: "p1", url: "about:blank", title: "", active: true }],
  })
  resolveMock.mockResolvedValue({ kind: "url", url: "http://localhost:5173/", local: false })
  renderPreview(session)
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "empty-state" }))
  })
  const engine = session.engine as unknown as ReturnType<typeof makeEngine>
  expect(engine.navigate).toHaveBeenCalledWith("http://localhost:5173/")
  expect(screen.queryByTestId("autofill")).toBeNull()
})

describe("element pick, annotations and Adjust (ADR-0214)", () => {
  it("arms the picker on the page in front, with the panel's labels", async () => {
    const session = makeSession()
    renderPreview(session)
    const engine = session.engine as unknown as ReturnType<typeof makeEngine>
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Select element" }))
    })
    expect(engine.setSelectMode).toHaveBeenCalledWith(true, {
      details: expect.any(String),
      collapse: expect.any(String),
    })
    const cancel = screen.getByRole("button", { name: "Cancel selection" })
    await act(async () => {
      fireEvent.click(cancel)
    })
    expect(engine.setSelectMode).toHaveBeenLastCalledWith(false, undefined)
  })

  it("gives the rail this page, this chat and this engine for screenshots and Adjust", async () => {
    const session = makeSession()
    renderPreview(session)
    const engine = session.engine as unknown as ReturnType<typeof makeEngine>
    expect(screen.getByTestId("inspection-rail")).toBeInTheDocument()
    const props = mockRailProps as {
      pageUrl: string
      sessionId: string
      capture: () => { capture: () => Promise<unknown> }
      adjustDriver: { run: (action: string, input: unknown) => Promise<string> }
      onClearSelection: () => void
    }
    expect(props.pageUrl).toBe("https://example.com/")
    expect(props.sessionId).toBe("chat-1")
    await expect(props.capture().capture()).resolves.toEqual({ bytes: "AAAA" })
    await props.adjustDriver.run("revert", { previewId: "x" })
    expect(engine.adjust).toHaveBeenCalledWith("revert", { previewId: "x" })
    act(() => props.onClearSelection())
    expect(engine.clearSelection).toHaveBeenCalled()
  })

  it("keeps the picker off until the session is ready", () => {
    renderPreview(makeSession({ state: "starting" }))
    expect(screen.getByRole("button", { name: "Select element" })).toBeDisabled()
  })
})
