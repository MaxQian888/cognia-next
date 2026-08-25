import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"

import { TooltipProvider } from "@/components/ui/tooltip"
import type { BrowserNavigated, BrowserSelection, ElementRect } from "@/lib/browser/protocol"

const renderPane = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>)

const mockSetSelectMode = jest.fn().mockResolvedValue(undefined)
const mockClearSelection = jest.fn()
const mockSendComment = jest.fn().mockResolvedValue(true)
const mockSendScreenshot = jest.fn().mockResolvedValue(true)
const mockSendText = jest.fn().mockResolvedValue(true)
const mockQueueAnnotation = jest.fn()
const mockSendAnnotations = jest.fn().mockResolvedValue(true)
const mockTransitionAnnotation = jest.fn().mockResolvedValue(true)
let mockPendingAnnotations: Array<Record<string, unknown>> = []
let mockRemoteBrowserEnabled = false
let mockActiveChatSessionId: string | null = "active-chat"
let mockLoadedUrl: string | null = null
let mockOwned = true
let mockDevtoolsOptions: Record<string, unknown> | undefined
const mockTakeLease = jest.fn()

jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { remoteBrowserEnabled: mockRemoteBrowserEnabled } }),
}))
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: (selector: (state: unknown) => unknown) =>
    selector({ activeSessionId: mockActiveChatSessionId }),
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({ activeProjectId: "active-workspace" }),
}))
jest.mock("@/components/browser/remote-browser-preview", () => ({
  RemoteBrowserPreview: (props: Record<string, unknown>) => (
    <div data-testid="remote-browser-preview" data-props={JSON.stringify(props)} />
  ),
}))

// The recorder panel is a separately-tested unit (browser-recorder-panel.test.tsx)
// and pulls in the Dexie graph; stub it here and assert only that the pane
// mounts it inside the dock and hands it the live URL.
jest.mock("@/components/browser/browser-recorder-panel", () => ({
  BrowserRecorderPanel: ({
    pageUrl,
    onLayoutChange,
  }: {
    pageUrl: string | null
    onLayoutChange?: () => void
  }) => {
    const [expanded, setExpanded] = useState(true)
    const previousExpandedRef = useRef(expanded)
    useLayoutEffect(() => {
      if (previousExpandedRef.current === expanded) return
      previousExpandedRef.current = expanded
      onLayoutChange?.()
    }, [expanded, onLayoutChange])
    return (
      <div data-testid="recorder-panel" data-page-url={pageUrl ?? ""} data-expanded={expanded}>
        <button
          type="button"
          aria-label="toggle recorder layout"
          onClick={() => setExpanded(false)}
        />
      </div>
    )
  },
}))
jest.mock("@/components/browser/browser-cookie-import-action", () => ({
  BrowserCookieImportAction: ({ currentUrl }: { currentUrl: string | null }) => (
    <div data-testid="cookie-import-action" data-current-url={currentUrl ?? ""} />
  ),
}))
// The history dropdown uses the shared manual mock so its items render inline.
jest.mock("@/components/ui/dropdown-menu")
// Same for the toolbar overflow: the manual mock renders `PopoverContent`
// unconditionally, so a test can assert *which container* a control packed
// into without driving the trigger open.
jest.mock("@/components/ui/popover")
// jsdom has no layout, so the pane's measured toolbar width is whatever a test
// dictates; 0 (the default) is the "not measured yet" widest branch.
let mockToolbarWidth = 0
jest.mock("@/hooks/use-element-width", () => ({ useElementWidth: () => mockToolbarWidth }))
const mockOpenExternal = jest.fn().mockResolvedValue(undefined)
let mockSelection: BrowserSelection | null = null
let mockNavigated: BrowserNavigated | null = null
let mockTauri = true
let mockSelectMode = false
let mockRect: ElementRect | null = { x: 0, y: 0, width: 100, height: 100 }
let mockPhase: "idle" | "loading" | "ready" = "idle"
let mockHasPainted = false
const mockBeginLoad = jest.fn()
let mockRegionVisible = true
let mockWebviewReady = true
let mockReadyCallback: (() => void) | undefined
let mockWebviewErrorCallback: ((error: unknown) => void) | undefined
let mockWebviewVisible: boolean | undefined
let mockPaneUrl: string | null | undefined
const mockRefreshBounds = jest.fn()

jest.mock("@/lib/tauri", () => ({ isTauri: () => mockTauri }))
jest.mock("@/lib/tauri/opener", () => ({
  openExternal: (...args: unknown[]) => mockOpenExternal(...args),
}))
let mockOnRectChange: ((r: ElementRect) => void) | undefined
jest.mock("@/lib/browser/pane-rect", () => ({ setActivePaneRect: jest.fn() }))
jest.mock("@/hooks/browser/use-browser-pane-webview", () => ({
  useBrowserPaneWebview: (
    _ref: unknown,
    opts: {
      url?: string | null
      visible?: boolean
      onReady?: () => void
      onError?: (error: unknown) => void
      onRectChange?: (r: ElementRect) => void
    }
  ) => {
    const onReady = opts.onReady
    mockWebviewVisible = opts?.visible
    mockPaneUrl = opts?.url
    mockOnRectChange = opts?.onRectChange
    mockReadyCallback = onReady
    mockWebviewErrorCallback = opts.onError
    useEffect(() => {
      if (mockWebviewReady) onReady?.()
    }, [onReady])
    return {
      getRect: () => mockRect,
      refreshBounds: mockRefreshBounds,
      owned: mockOwned,
      takeLease: mockTakeLease,
    }
  },
}))
jest.mock("@/hooks/browser/use-browser-loading", () => ({
  useBrowserLoading: () => ({
    phase: mockPhase,
    hasPainted: mockHasPainted,
    loadedUrl: mockLoadedUrl,
    begin: mockBeginLoad,
  }),
}))
jest.mock("@/hooks/browser/use-region-visibility", () => ({
  useRegionVisibility: () => mockRegionVisible,
}))
// Record the options so the ownership gate is assertable; the drawer's own
// behaviour is covered by use-browser-devtools.test.ts.
jest.mock("@/hooks/browser/use-browser-devtools", () => ({
  useBrowserDevtools: (options?: Record<string, unknown>) => {
    mockDevtoolsOptions = options
    return {
      console: [],
      network: [],
      problemCount: 0,
      failedRequests: 0,
      clearConsole: jest.fn(),
      clearNetwork: jest.fn(),
    }
  },
}))
jest.mock("@/hooks/browser/use-element-selection", () => ({
  useElementSelection: () => ({
    selection: mockSelection,
    selections: mockSelection ? [mockSelection] : [],
    navigated: mockNavigated,
    selectMode: mockSelectMode,
    setSelectMode: mockSetSelectMode,
    clearSelection: mockClearSelection,
  }),
}))
jest.mock("@/hooks/browser/use-selection-to-chat", () => ({
  useSelectionToChat: () => ({
    sendComment: mockSendComment,
    sendScreenshot: mockSendScreenshot,
    sendText: mockSendText,
    queueAnnotation: mockQueueAnnotation,
    sendAnnotations: mockSendAnnotations,
  }),
}))
jest.mock("dexie-react-hooks", () => ({
  // Run the factory so a test can assert which session the queue was scoped
  // to; the rows themselves still come from the fixture.
  useLiveQuery: (factory: () => unknown) => {
    void factory()
    return mockPendingAnnotations
  },
}))
jest.mock("@/lib/db/browser-annotations", () => ({
  deleteExpiredBrowserAnnotations: jest.fn().mockResolvedValue(0),
  listActionableBrowserAnnotations: jest.fn().mockResolvedValue([]),
  transitionBrowserAnnotation: (...args: unknown[]) => mockTransitionAnnotation(...args),
}))
// Both are separately tested and pull in the Dexie graph; stub them so this
// suite can assert the session gate without a database.
jest.mock("@/components/browser/browser-cdp-controls", () => ({
  BrowserCdpControls: (props: { sessionId: string; browserSessionId: string }) => (
    <div
      data-testid="cdp-controls"
      data-session={props.sessionId}
      data-browser-session={props.browserSessionId}
    />
  ),
}))
jest.mock("@/components/browser/browser-adjust-controls", () => ({
  BrowserAdjustControls: (props: { sessionId: string; browserSessionId: string }) => (
    <div
      data-testid="adjust-controls"
      data-session={props.sessionId}
      data-browser-session={props.browserSessionId}
    />
  ),
}))
jest.mock("@/lib/browser/client", () => ({
  browserClient: {
    embedReload: jest.fn().mockResolvedValue(undefined),
    embedSetZoom: jest.fn().mockResolvedValue(undefined),
    embedFind: jest.fn().mockResolvedValue({ matches: 0, index: 0 }),
    embedFindClear: jest.fn().mockResolvedValue(undefined),
    embedBack: jest.fn().mockResolvedValue(undefined),
    embedForward: jest.fn().mockResolvedValue(undefined),
    embedStop: jest.fn().mockResolvedValue(undefined),
    embedNavigate: jest.fn().mockResolvedValue(undefined),
    embedSetSelectMode: jest.fn().mockResolvedValue(undefined),
    embedClearSelection: jest.fn().mockResolvedValue(undefined),
    embedSetPanelLabels: jest.fn().mockResolvedValue(undefined),
  },
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
import { listActionableBrowserAnnotations } from "@/lib/db/browser-annotations"
import { browserClient } from "@/lib/browser/client"
import { requestBrowserUrl } from "@/lib/browser/open-url-request"
import { addressDisplayParts, BrowserPreviewPane } from "./browser-preview-pane"

const SELECTION: BrowserSelection = {
  paneId: "browser-embed",
  selector: "#root > button",
  domPath: "button#go",
  tagName: "button",
  id: "go",
  classes: null,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  outerHTML: "<button></button>",
  text: "Go",
  pageUrl: "http://localhost:3000/",
  pageTitle: "Home",
}

const urlBar = () => screen.getByPlaceholderText("http://localhost:3000")
const toolbar = () => screen.getByTestId("browser-toolbar")
/** The "⋯" popover body — where a tier packs whatever didn't stay inline. */
const overflow = () => screen.getByTestId("popover-content")

/**
 * Report that the preview finished loading `url`. The back/forward stack is
 * built from settled documents, not from committed targets — a redirect chain
 * emits one `browser://navigated` per hop but settles once.
 */
const settleAt = (view: { rerender: (ui: React.ReactElement) => void }, url: string) => {
  mockLoadedUrl = url
  view.rerender(
    <TooltipProvider>
      <BrowserPreviewPane />
    </TooltipProvider>
  )
}

/** Type an address into the URL bar and press Enter (form submit). */
const commitUrl = (value: string) => {
  fireEvent.change(urlBar(), { target: { value } })
  fireEvent.submit(urlBar())
}

beforeEach(() => {
  window.localStorage.clear()
  mockToolbarWidth = 0
  mockSelection = null
  mockNavigated = null
  mockTauri = true
  mockSelectMode = false
  mockRect = { x: 0, y: 0, width: 100, height: 100 }
  mockPhase = "idle"
  mockHasPainted = false
  mockRegionVisible = true
  mockWebviewReady = true
  mockReadyCallback = undefined
  mockWebviewErrorCallback = undefined
  mockWebviewVisible = undefined
  mockPaneUrl = undefined
  mockRefreshBounds.mockClear()
  mockBeginLoad.mockClear()
  mockSetSelectMode.mockClear()
  mockClearSelection.mockClear()
  mockSendComment.mockClear().mockResolvedValue(true)
  mockSendScreenshot.mockClear().mockResolvedValue(true)
  mockQueueAnnotation.mockReset()
  mockSendAnnotations.mockReset().mockResolvedValue(true)
  mockTransitionAnnotation.mockReset().mockResolvedValue(true)
  mockPendingAnnotations = []
  mockRemoteBrowserEnabled = false
  mockActiveChatSessionId = "active-chat"
  mockLoadedUrl = null
  mockOwned = true
  mockDevtoolsOptions = undefined
  mockTakeLease.mockClear()
  ;(listActionableBrowserAnnotations as jest.Mock).mockClear()
  mockOpenExternal.mockClear().mockResolvedValue(undefined)
  ;(browserClient.embedReload as jest.Mock).mockClear()
  ;(browserClient.embedSetZoom as jest.Mock).mockClear()
  ;(browserClient.embedFind as jest.Mock).mockClear().mockResolvedValue({ matches: 0, index: 0 })
  ;(browserClient.embedFindClear as jest.Mock).mockClear()
  ;(browserClient.embedBack as jest.Mock).mockClear()
  ;(browserClient.embedForward as jest.Mock).mockClear()
  ;(browserClient.embedStop as jest.Mock).mockClear().mockResolvedValue(undefined)
  ;(browserClient.embedNavigate as jest.Mock).mockClear()
  ;(browserClient.embedClearSelection as jest.Mock).mockClear()
  ;(browserClient.embedSetPanelLabels as jest.Mock).mockClear()
  ;(toast.success as jest.Mock).mockClear()
  ;(toast.error as jest.Mock).mockClear()
})

it("shows a localized error when the embedded WebView rejects an HTTPS proxy", () => {
  renderPane(<BrowserPreviewPane initialUrl="https://example.com" />)

  act(() => {
    mockWebviewErrorCallback?.(
      new Error("PROXY_TRANSPORT_UNSUPPORTED: embedded browser does not support HTTPS proxy")
    )
  })

  expect(toast.error).toHaveBeenCalledWith(
    "HTTPS proxying is not supported in this browser preview."
  )
})

it("replaces the web iframe with remote Canvas after explicit opt-in", () => {
  mockTauri = false
  mockRemoteBrowserEnabled = true
  renderPane(<BrowserPreviewPane initialUrl="https://example.com" />)
  const preview = screen.getByTestId("remote-browser-preview")
  expect(preview).toHaveAttribute(
    "data-props",
    JSON.stringify({
      chatSessionId: "active-chat",
      workspaceId: "active-workspace",
      initialUrl: "https://example.com/",
    })
  )
  expect(screen.queryByTestId("browser-web-preview")).not.toBeInTheDocument()
})

it("opens a caller-provided initial URL without requiring address-bar input", async () => {
  renderPane(<BrowserPreviewPane initialUrl="http://localhost:4173" />)

  await waitFor(() => expect(mockPaneUrl).toBe("http://localhost:4173/"))
  expect(urlBar()).toHaveValue("http://localhost:4173/")
})

it("persists the selected annotation detail level", () => {
  renderPane(<BrowserPreviewPane />)
  const control = screen.getByRole("combobox", { name: "Annotation detail" })
  expect(control).toHaveValue("standard")
  fireEvent.change(control, { target: { value: "forensic" } })
  expect(control).toHaveValue("forensic")
  expect(window.localStorage.getItem("cognia.browser.output-detail")).toBe("forensic")
})

it("queues a selected annotation through durable storage", async () => {
  mockSelection = SELECTION
  mockQueueAnnotation.mockResolvedValue({ id: "a1", selection: SELECTION })
  renderPane(<BrowserPreviewPane sessionId="s1" />)
  fireEvent.change(screen.getByPlaceholderText(/Describe the change/i), {
    target: { value: "increase contrast" },
  })
  fireEvent.change(screen.getByRole("combobox", { name: "Annotation intent" }), {
    target: { value: "fix" },
  })
  fireEvent.change(screen.getByRole("combobox", { name: "Annotation severity" }), {
    target: { value: "important" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Add to queue" }))
  await waitFor(() =>
    expect(mockQueueAnnotation).toHaveBeenCalledWith(SELECTION, "increase contrast", {
      sessionId: "s1",
      baseUrl: "http://localhost:3000",
      intent: "fix",
      severity: "important",
    })
  )
})

it("sends and triages persisted pending annotations", async () => {
  const annotation = {
    id: "a1",
    comment: "increase contrast",
    selection: SELECTION,
    status: "pending",
    intent: "change",
    severity: "suggestion",
  }
  mockPendingAnnotations = [annotation]
  renderPane(<BrowserPreviewPane sessionId="s1" />)
  fireEvent.click(screen.getByRole("button", { name: "Send 1" }))
  await waitFor(() =>
    expect(mockSendAnnotations).toHaveBeenCalledWith([annotation], expect.any(Object))
  )
  fireEvent.click(screen.getByRole("button", { name: "Resolve annotation" }))
  await waitFor(() =>
    expect(mockTransitionAnnotation).toHaveBeenCalledWith(
      "a1",
      "resolved",
      expect.any(Number),
      "human"
    )
  )
  fireEvent.click(screen.getByRole("button", { name: "Remove annotation" }))
  await waitFor(() =>
    expect(mockTransitionAnnotation).toHaveBeenCalledWith(
      "a1",
      "dismissed",
      expect.any(Number),
      "human"
    )
  )
})

it("falls back to the sandboxed WebPreview URL bar + iframe outside Tauri", () => {
  mockTauri = false
  const { container } = renderPane(<BrowserPreviewPane />)
  // No native element-selection chrome; instead a WebPreview URL bar.
  expect(screen.getByTestId("browser-web-preview")).toBeInTheDocument()
  expect(urlBar()).toBeInTheDocument()
  // Typing a URL + Enter points the sandboxed iframe at it.
  fireEvent.change(urlBar(), { target: { value: "https://localhost:3000" } })
  fireEvent.keyDown(urlBar(), { key: "Enter" })
  const iframe = container.querySelector("iframe")
  expect(iframe).toHaveAttribute("src", "https://localhost:3000")
  expect(iframe).toHaveAttribute("sandbox")
})

it("opens the caller-provided URL in the sandboxed web fallback", () => {
  mockTauri = false
  const { container } = renderPane(<BrowserPreviewPane initialUrl="https://example.com/docs" />)

  expect(container.querySelector("iframe")).toHaveAttribute("src", "https://example.com/docs")
})

it("renders the empty state and URL bar in Tauri", () => {
  renderPane(<BrowserPreviewPane />)
  expect(screen.getByText("Preview a web page")).toBeInTheDocument()
  expect(urlBar()).toBeInTheDocument()
})

it("keeps the toolbar on one row with the address bar taking the slack", () => {
  mockToolbarWidth = 320
  renderPane(<BrowserPreviewPane />)

  expect(toolbar()).not.toHaveClass("flex-wrap")
  expect(toolbar().querySelector("form")).toHaveClass("min-w-0", "flex-1")
})

it("keeps every toolbar action inline on a wide pane", () => {
  renderPane(<BrowserPreviewPane />)

  expect(toolbar()).toHaveAttribute("data-tier", "wide")
  for (const name of [
    "History",
    "Send screenshot to chat",
    "Select element",
    "Find",
    "Open in external browser",
  ]) {
    expect(overflow()).not.toContainElement(screen.getByRole("button", { name }))
  }
  // Annotation detail is an output setting, not navigation chrome — it lives
  // in the overflow at every width.
  expect(overflow()).toContainElement(screen.getByRole("combobox", { name: "Annotation detail" }))
})

it("packs the set-once page actions away first on a medium pane", () => {
  mockToolbarWidth = 520
  renderPane(<BrowserPreviewPane />)

  expect(toolbar()).toHaveAttribute("data-tier", "medium")
  expect(overflow()).not.toContainElement(screen.getByRole("button", { name: "Select element" }))
  expect(overflow()).toContainElement(
    screen.getByRole("button", { name: "Open in external browser" })
  )
  expect(overflow()).toContainElement(screen.getByTestId("cookie-import-action"))
})

it("leaves only navigation and the address bar inline on a narrow rail", () => {
  mockToolbarWidth = 320
  renderPane(<BrowserPreviewPane />)

  expect(toolbar()).toHaveAttribute("data-tier", "compact")
  for (const name of ["Back", "Forward", "Reload"]) {
    expect(overflow()).not.toContainElement(screen.getByRole("button", { name }))
  }
  for (const name of [
    "History",
    "Send screenshot to chat",
    "Select element",
    "Find",
    "Open in external browser",
  ]) {
    expect(overflow()).toContainElement(screen.getByRole("button", { name }))
  }
})

it("flags the overflow trigger while a packed-away control is armed", () => {
  mockToolbarWidth = 320
  mockSelectMode = true
  renderPane(<BrowserPreviewPane />)
  expect(screen.getByTestId("browser-toolbar-more-active")).toBeInTheDocument()
})

it("opens the overflow modally so the always-on-top webview parks off-screen", () => {
  // Non-modal, the popover would render behind the native webview: only a
  // modal layer marks the rest of the app aria-hidden, which is what
  // `useRegionVisibility` watches.
  renderPane(<BrowserPreviewPane />)
  expect(screen.getByTestId("popover")).toHaveAttribute("data-modal", "true")
})

it("leaves the overflow trigger unflagged when nothing packed away is active", () => {
  mockToolbarWidth = 320
  renderPane(<BrowserPreviewPane />)
  expect(screen.queryByTestId("browser-toolbar-more-active")).not.toBeInTheDocument()
})

it("flags the overflow trigger while find-in-page is open behind it", () => {
  mockToolbarWidth = 320
  renderPane(<BrowserPreviewPane />)
  commitUrl("http://localhost:3000/")
  fireEvent.click(screen.getByRole("button", { name: "Find" }))
  expect(screen.getByTestId("browser-toolbar-more-active")).toBeInTheDocument()
  // Toggling it back off clears both the find bar and the flag.
  fireEvent.click(screen.getByRole("button", { name: "Find" }))
  expect(browserClient.embedFindClear).toHaveBeenCalled()
  expect(screen.queryByTestId("browser-toolbar-more-active")).not.toBeInTheDocument()
})

it("flags the overflow trigger while the packed-away zoom is off 100%", () => {
  window.localStorage.setItem("cognia.browser.zoom", "1.5")
  mockToolbarWidth = 520
  renderPane(<BrowserPreviewPane />)
  expect(screen.getByTestId("browser-toolbar-more-active")).toBeInTheDocument()
})

describe("addressDisplayParts", () => {
  it("splits an http(s) address into host + dimmable remainder", () => {
    expect(addressDisplayParts("https://www.example.com/a/b?q=1#f")).toEqual({
      host: "example.com",
      rest: "/a/b?q=1#f",
      secure: true,
    })
    expect(addressDisplayParts("http://localhost:3000/")).toEqual({
      host: "localhost:3000",
      rest: "",
      secure: false,
    })
  })

  it("declines anything that isn't a parseable http(s) address", () => {
    expect(addressDisplayParts("localhost:30")).toBeNull()
    expect(addressDisplayParts("file:///tmp/index.html")).toBeNull()
    expect(addressDisplayParts("")).toBeNull()
  })
})

it("stacks the inspection rail under the page instead of beside it when narrow", () => {
  mockToolbarWidth = 320
  mockSelection = SELECTION
  renderPane(<BrowserPreviewPane sessionId="s1" />)

  const rail = screen.getByTestId("browser-inspection-rail")
  expect(rail).toHaveClass("h-1/2", "border-t")
  expect(rail).not.toHaveClass("w-80")
})

it("shows the address host-first once the field mirrors the live page", () => {
  renderPane(<BrowserPreviewPane initialUrl="https://www.example.com/docs/start?q=1" />)

  // The scheme and `www.` are painted away so the host survives truncation…
  expect(screen.getByTestId("browser-url-display")).toHaveTextContent("example.com/docs/start?q=1")
  // …while the field itself still carries the real URL for copy + submit.
  expect(urlBar()).toHaveValue("https://www.example.com/docs/start?q=1")
})

it("reveals the raw URL while the address bar is focused", () => {
  renderPane(<BrowserPreviewPane initialUrl="https://example.com/a" />)
  fireEvent.focus(urlBar())
  expect(screen.queryByTestId("browser-url-display")).not.toBeInTheDocument()
})

it("never rewrites an uncommitted draft into the display form", () => {
  renderPane(<BrowserPreviewPane />)
  commitUrl("http://localhost:3000/")
  fireEvent.focus(urlBar())
  fireEvent.change(urlBar(), { target: { value: "https://example.com" } })
  fireEvent.blur(urlBar())

  expect(screen.queryByTestId("browser-url-display")).not.toBeInTheDocument()
  expect(urlBar()).toHaveValue("https://example.com")
})

it("commits a typed URL via Enter and clears the empty state", async () => {
  renderPane(<BrowserPreviewPane />)
  commitUrl("localhost:3000")
  await waitFor(() => expect(screen.queryByText("Preview a web page")).not.toBeInTheDocument())
  // The address bar reflects the normalized URL.
  expect(urlBar()).toHaveValue("http://localhost:3000/")
})

it("re-navigates when the same address is committed again", () => {
  renderPane(<BrowserPreviewPane />)
  commitUrl("http://localhost:3000/")
  commitUrl("http://localhost:3000/")
  expect(browserClient.embedNavigate).toHaveBeenCalledWith("http://localhost:3000/")
})

it("opens a quick-open chip directly", async () => {
  renderPane(<BrowserPreviewPane />)
  fireEvent.click(screen.getByRole("button", { name: "localhost:5173" }))
  await waitFor(() => expect(screen.queryByText("Preview a web page")).not.toBeInTheDocument())
  expect(urlBar()).toHaveValue("http://localhost:5173")
})

it("syncs the address bar to preview navigations while not editing", () => {
  mockNavigated = { paneId: "browser-embed", url: "http://localhost:3000/about" }
  renderPane(<BrowserPreviewPane />)
  expect(urlBar()).toHaveValue("http://localhost:3000/about")
})

it("keeps the user's draft while the URL bar is focused", () => {
  renderPane(<BrowserPreviewPane />)
  fireEvent.focus(urlBar())
  fireEvent.change(urlBar(), { target: { value: "localhost:517" } })
  // A navigation event arriving mid-edit must not clobber the draft.
  expect(urlBar()).toHaveValue("localhost:517")
})

it("restores the current URL on Escape", () => {
  renderPane(<BrowserPreviewPane />)
  commitUrl("http://localhost:3000/")
  fireEvent.focus(urlBar())
  fireEvent.change(urlBar(), { target: { value: "garbage-draft" } })
  fireEvent.keyDown(urlBar(), { key: "Escape" })
  expect(urlBar()).toHaveValue("http://localhost:3000/")
})

it("toggles select mode after a URL is committed", () => {
  renderPane(<BrowserPreviewPane />)
  commitUrl("localhost:3000")
  fireEvent.click(screen.getByRole("button", { name: "Select element" }))
  expect(mockSetSelectMode).toHaveBeenCalledWith(true)
})

it("drives history and reload through the browser client", () => {
  const view = renderPane(<BrowserPreviewPane />)
  commitUrl("localhost:3000")
  // Back and forward now need somewhere to go: two settled pages.
  settleAt(view, "http://localhost:3000/")
  settleAt(view, "http://localhost:3000/about")
  fireEvent.click(screen.getByRole("button", { name: "Back" }))
  fireEvent.click(screen.getByRole("button", { name: "Forward" }))
  fireEvent.click(screen.getByRole("button", { name: "Reload" }))
  expect(browserClient.embedBack).toHaveBeenCalled()
  expect(browserClient.embedForward).toHaveBeenCalled()
  expect(browserClient.embedReload).toHaveBeenCalled()
})

it("disables navigation chrome until a URL is committed", () => {
  renderPane(<BrowserPreviewPane />)
  expect(screen.getByRole("button", { name: "Back" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Reload" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Send screenshot to chat" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Open in external browser" })).toBeDisabled()
})

it("opens the current page in the external browser", () => {
  renderPane(<BrowserPreviewPane />)
  commitUrl("http://localhost:3000/")
  fireEvent.click(screen.getByRole("button", { name: "Open in external browser" }))
  expect(mockOpenExternal).toHaveBeenCalledWith("http://localhost:3000/")
})

it("wires the current page into the Chromium cookie import action", () => {
  renderPane(<BrowserPreviewPane />)
  expect(screen.getByTestId("cookie-import-action")).toHaveAttribute("data-current-url", "")
  commitUrl("https://www.github.com/settings")
  expect(screen.getByTestId("cookie-import-action")).toHaveAttribute(
    "data-current-url",
    "https://www.github.com/settings"
  )
})

it("sends a screenshot of the preview to chat", async () => {
  renderPane(<BrowserPreviewPane />)
  commitUrl("http://localhost:3000/")
  fireEvent.click(screen.getByRole("button", { name: "Send screenshot to chat" }))
  await waitFor(() =>
    expect(mockSendScreenshot).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 100, height: 100 },
      // No `sessionId` prop -> the focused chat session, the same one
      // `useSelectionToChat` would have fallen back to internally.
      { sessionId: "active-chat", pageUrl: "http://localhost:3000/" }
    )
  )
  expect(toast.success).toHaveBeenCalled()
})

it("surfaces a no-session toast when the screenshot is undeliverable", async () => {
  mockSendScreenshot.mockResolvedValueOnce(false)
  renderPane(<BrowserPreviewPane />)
  commitUrl("http://localhost:3000/")
  fireEvent.click(screen.getByRole("button", { name: "Send screenshot to chat" }))
  await waitFor(() => expect(toast.error).toHaveBeenCalled())
})

it("surfaces an error toast when the screenshot capture fails", async () => {
  mockSendScreenshot.mockRejectedValueOnce(new Error("boom"))
  renderPane(<BrowserPreviewPane />)
  commitUrl("http://localhost:3000/")
  fireEvent.click(screen.getByRole("button", { name: "Send screenshot to chat" }))
  await waitFor(() => expect(toast.error).toHaveBeenCalled())
})

it("sends a selection comment to chat and clears on success", async () => {
  mockSelection = SELECTION
  renderPane(<BrowserPreviewPane />)
  expect(screen.getByText("#root > button")).toBeInTheDocument()
  expect(screen.getByText("button")).toBeInTheDocument() // tag badge
  fireEvent.change(screen.getByPlaceholderText(/Describe the change/i), {
    target: { value: "make it blue" },
  })
  fireEvent.click(screen.getByRole("button", { name: /Send to chat/i }))
  await waitFor(() =>
    expect(mockSendComment).toHaveBeenCalledWith([SELECTION], "make it blue", {
      sessionId: "active-chat",
      captureRect: { x: 0, y: 0, width: 100, height: 100 },
      detailLevel: "standard",
    })
  )
  expect(toast.success).toHaveBeenCalled()
  expect(mockClearSelection).toHaveBeenCalled()
  // The in-page overlay panel is torn down on the page side too.
  expect(browserClient.embedClearSelection).toHaveBeenCalled()
})

it("shows the owning component name in the identity line when present", () => {
  mockSelection = { ...SELECTION, componentName: "SubmitButton" }
  renderPane(<BrowserPreviewPane />)
  expect(screen.getByText("<SubmitButton>")).toBeInTheDocument()
  expect(screen.queryByText("#root > button")).not.toBeInTheDocument()
})

it("pushes localized info-panel labels once a URL is committed", async () => {
  renderPane(<BrowserPreviewPane />)
  commitUrl("localhost:3000")
  await waitFor(() =>
    expect(browserClient.embedSetPanelLabels).toHaveBeenCalledWith({
      details: "Details",
      collapse: "Collapse",
    })
  )
})

it("sends the comment via Ctrl+Enter", async () => {
  mockSelection = SELECTION
  renderPane(<BrowserPreviewPane />)
  const textarea = screen.getByPlaceholderText(/Describe the change/i)
  fireEvent.change(textarea, { target: { value: "tweak" } })
  fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true })
  await waitFor(() => expect(mockSendComment).toHaveBeenCalled())
})

it("dismisses the comment box via Escape", () => {
  mockSelection = SELECTION
  renderPane(<BrowserPreviewPane />)
  fireEvent.keyDown(screen.getByPlaceholderText(/Describe the change/i), { key: "Escape" })
  expect(mockClearSelection).toHaveBeenCalled()
  expect(browserClient.embedClearSelection).toHaveBeenCalled()
})

it("labels the toggle as cancel while select mode is active", () => {
  mockSelectMode = true
  renderPane(<BrowserPreviewPane />)
  commitUrl("localhost:3000")
  expect(screen.getByRole("button", { name: "Cancel selection" })).toBeInTheDocument()
})

it("rejects an unparseable URL with an error toast", () => {
  renderPane(<BrowserPreviewPane />)
  commitUrl("   ")
  expect(toast.error).toHaveBeenCalled()
  expect(screen.getByText("Preview a web page")).toBeInTheDocument()
})

it("shows the no-session toast when the bridge reports no delivery", async () => {
  mockSelection = SELECTION
  mockSendComment.mockResolvedValueOnce(false)
  renderPane(<BrowserPreviewPane />)
  fireEvent.change(screen.getByPlaceholderText(/Describe the change/i), {
    target: { value: "x" },
  })
  fireEvent.click(screen.getByRole("button", { name: /Send to chat/i }))
  await waitFor(() => expect(toast.error).toHaveBeenCalled())
  expect(mockClearSelection).not.toHaveBeenCalled()
})

it("dismisses the comment box via the cancel button", () => {
  mockSelection = SELECTION
  renderPane(<BrowserPreviewPane />)
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  expect(mockClearSelection).toHaveBeenCalled()
  expect(browserClient.embedClearSelection).toHaveBeenCalled()
})

it("surfaces an error toast when the send throws", async () => {
  mockSelection = SELECTION
  mockSendComment.mockRejectedValueOnce(new Error("boom"))
  renderPane(<BrowserPreviewPane />)
  fireEvent.change(screen.getByPlaceholderText(/Describe the change/i), {
    target: { value: "x" },
  })
  fireEvent.click(screen.getByRole("button", { name: /Send to chat/i }))
  await waitFor(() => expect(toast.error).toHaveBeenCalled())
})

// --- loading UX + layer/visibility wiring ---------------------------------

it("shows the top progress bar only while loading", () => {
  const { rerender } = renderPane(<BrowserPreviewPane />)
  expect(screen.queryByTestId("browser-progress")).not.toBeInTheDocument()
  mockPhase = "loading"
  rerender(<TooltipProvider>{<BrowserPreviewPane />}</TooltipProvider>)
  expect(screen.getByTestId("browser-progress")).toBeInTheDocument()
})

it("shows the first-load placeholder until the page paints, then reveals the page", () => {
  const { rerender } = renderPane(<BrowserPreviewPane />)
  commitUrl("localhost:3000")
  // Not painted yet: placeholder is up and the native webview stays hidden.
  expect(screen.getByTestId("browser-loading")).toBeInTheDocument()
  expect(screen.getByText("Loading localhost:3000…")).toBeInTheDocument()
  expect(mockWebviewVisible).toBe(false)

  // Painted: placeholder gone, webview revealed.
  mockHasPainted = true
  rerender(<TooltipProvider>{<BrowserPreviewPane />}</TooltipProvider>)
  expect(screen.queryByTestId("browser-loading")).not.toBeInTheDocument()
  expect(mockWebviewVisible).toBe(true)
})

it("keeps the native webview hidden while a modal / off-screen state covers the region", () => {
  mockHasPainted = true
  mockRegionVisible = false
  renderPane(<BrowserPreviewPane />)
  commitUrl("localhost:3000")
  // Region not visible → webview parked so the overlay isn't blocked (no freeze).
  expect(mockWebviewVisible).toBe(false)
})

it("parks the native webview while its workspace is collapsed and restores it when reopened", () => {
  mockHasPainted = true
  const { rerender } = renderPane(<BrowserPreviewPane />)
  commitUrl("localhost:3000")
  expect(mockWebviewVisible).toBe(true)

  mockRegionVisible = false
  rerender(<TooltipProvider>{<BrowserPreviewPane />}</TooltipProvider>)
  expect(mockWebviewVisible).toBe(false)

  mockRegionVisible = true
  rerender(<TooltipProvider>{<BrowserPreviewPane />}</TooltipProvider>)
  expect(mockWebviewVisible).toBe(true)
})

it("publishes the pane rect through the callback only after a URL is committed", () => {
  const { setActivePaneRect } = jest.requireMock("@/lib/browser/pane-rect") as {
    setActivePaneRect: jest.Mock
  }
  renderPane(<BrowserPreviewPane />)
  setActivePaneRect.mockClear()
  // No committed URL yet → the per-frame rect callback is a no-op.
  act(() => mockOnRectChange?.({ x: 1, y: 1, width: 2, height: 2 }))
  expect(setActivePaneRect).not.toHaveBeenCalled()
  // After a commit it publishes the reserved-region rect for the capture path.
  commitUrl("localhost:3000")
  setActivePaneRect.mockClear()
  act(() => mockOnRectChange?.({ x: 5, y: 6, width: 7, height: 8 }))
  expect(setActivePaneRect).toHaveBeenCalledWith({ x: 5, y: 6, width: 7, height: 8 })
})

it("shows the raw address in the loading host when the URL can't be parsed", () => {
  mockNavigated = { paneId: "browser-embed", url: "http://[bad" }
  renderPane(<BrowserPreviewPane />)
  commitUrl("localhost:3000")
  // hostOf() falls back to the raw string rather than throwing.
  expect(screen.getByText("Loading http://[bad…")).toBeInTheDocument()
})

it("begins a load on commit, reload, back and forward", () => {
  const view = renderPane(<BrowserPreviewPane />)
  commitUrl("localhost:3000")
  expect(mockBeginLoad).toHaveBeenCalledTimes(1)
  settleAt(view, "http://localhost:3000/")
  settleAt(view, "http://localhost:3000/about")
  fireEvent.click(screen.getByRole("button", { name: "Reload" }))
  fireEvent.click(screen.getByRole("button", { name: "Back" }))
  fireEvent.click(screen.getByRole("button", { name: "Forward" }))
  expect(mockBeginLoad).toHaveBeenCalledTimes(4)
})

// The recorder is only useful if the pane actually mounts it and tells it which
// page is live — a panel that renders but never learns the URL can never arm.
// D10: the recorder and the DevTools readouts used to be two permanently
// mounted strips stacked under the pane, and the recorder started expanded — so
// an empty pane spent roughly 100px on chrome before a page was even loaded.
describe("bottom tools dock", () => {
  it("mounts nothing under the pane until a page is committed", () => {
    renderPane(<BrowserPreviewPane />)
    expect(screen.queryByTestId("browser-tools-dock")).toBeNull()
    expect(screen.queryByTestId("recorder-panel")).toBeNull()
  })

  it("mounts one collapsed strip once a page is committed", () => {
    renderPane(<BrowserPreviewPane />)
    commitUrl("localhost:3000")
    const dock = screen.getByTestId("browser-tools-dock")
    expect(dock).toHaveAttribute("data-expanded", "false")
    expect(screen.queryByTestId("recorder-panel")).toBeNull()
  })

  it("hands the recorder the live url once expanded", () => {
    renderPane(<BrowserPreviewPane />)
    commitUrl("localhost:3000")
    fireEvent.click(screen.getByTestId("browser-tools-toggle"))
    expect(screen.getByTestId("recorder-panel")).toHaveAttribute(
      "data-page-url",
      "http://localhost:3000/"
    )
  })

  it("refreshes native bounds when the dock changes height", () => {
    jest.useFakeTimers()
    try {
      renderPane(<BrowserPreviewPane />)
      commitUrl("localhost:3000")
      mockRefreshBounds.mockClear()
      fireEvent.click(screen.getByTestId("browser-tools-toggle"))
      jest.runOnlyPendingTimers()
      expect(mockRefreshBounds).toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it("opens the dock at developer mode from the toolbar", () => {
    renderPane(<BrowserPreviewPane />)
    commitUrl("localhost:3000")
    fireEvent.click(screen.getByRole("button", { name: "Developer mode" }))
    const dock = screen.getByTestId("browser-tools-dock")
    expect(dock).toHaveAttribute("data-expanded", "true")
    expect(dock).toHaveAttribute("data-tab", "developer")
    expect(screen.getByTestId("cdp-controls")).toBeInTheDocument()
  })

  it("keeps the inspection rail for selection only", () => {
    renderPane(<BrowserPreviewPane />)
    commitUrl("localhost:3000")
    fireEvent.click(screen.getByRole("button", { name: "Developer mode" }))
    // Developer mode no longer opens a second surface beside the page.
    expect(screen.queryByTestId("browser-inspection-rail")).toBeNull()
  })
})

// The selection panel + annotation queue live in a slide-in rail beside the
// reserved region (not stacked below it) so the native webview rect changes at
// most once per enter/leave — see use-browser-pane-webview's single embedSetBounds.
describe("inspection rail", () => {
  it("opens the rail beside the reserved region when an element is selected", () => {
    mockSelection = SELECTION
    renderPane(<BrowserPreviewPane />)
    const rail = screen.getByTestId("browser-inspection-rail")
    expect(rail).toHaveClass("w-80", "shrink-0")
    expect(rail).toHaveAttribute("data-state", "open")
    // Horizontal sibling of the reserved region, not a descendant of it.
    const reserved = screen.getByTestId("browser-reserved-region")
    expect(rail).not.toContainElement(reserved)
    expect(reserved.parentElement).toBe(rail.parentElement)
    expect(rail.parentElement).toHaveClass("flex")
  })

  it("keeps the rail unmounted with no selection or queued annotations", () => {
    renderPane(<BrowserPreviewPane />)
    expect(screen.queryByTestId("browser-inspection-rail")).not.toBeInTheDocument()
  })

  it("renders queued annotations inside the rail", () => {
    mockPendingAnnotations = [
      {
        id: "a1",
        comment: "increase contrast",
        selection: SELECTION,
        status: "pending",
        intent: "change",
        severity: "suggestion",
      },
    ]
    renderPane(<BrowserPreviewPane sessionId="s1" />)
    const rail = screen.getByTestId("browser-inspection-rail")
    expect(within(rail).getByRole("button", { name: "Send 1" })).toBeInTheDocument()
  })

  it("unmounts the rail after its slide-out animation completes", () => {
    mockSelection = SELECTION
    const { rerender } = renderPane(<BrowserPreviewPane />)
    expect(screen.getByTestId("browser-inspection-rail")).toHaveAttribute("data-state", "open")
    // Selection cleared → stay mounted in the closed state to play the exit…
    mockSelection = null
    rerender(<TooltipProvider>{<BrowserPreviewPane />}</TooltipProvider>)
    const rail = screen.getByTestId("browser-inspection-rail")
    expect(rail).toHaveAttribute("data-state", "closed")
    // …then unmount once that animation finishes.
    fireEvent.animationEnd(rail)
    expect(screen.queryByTestId("browser-inspection-rail")).not.toBeInTheDocument()
  })

  it("does not tear the rail down when a child animation ends mid-close", () => {
    mockSelection = SELECTION
    const { rerender } = renderPane(<BrowserPreviewPane />)
    mockSelection = null
    rerender(<TooltipProvider>{<BrowserPreviewPane />}</TooltipProvider>)
    const rail = screen.getByTestId("browser-inspection-rail")
    const child = rail.querySelector("div")
    if (child) fireEvent.animationEnd(child)
    expect(screen.getByTestId("browser-inspection-rail")).toBeInTheDocument()
  })

  it("fades the empty state and first-load placeholder in", () => {
    renderPane(<BrowserPreviewPane />)
    expect(screen.getByText("Preview a web page").closest(".animate-in")).toHaveClass("fade-in")
    commitUrl("localhost:3000")
    expect(screen.getByTestId("browser-loading")).toHaveClass("animate-in", "fade-in")
  })
})

describe("zoom", () => {
  it("waits for the embedded owner lease before applying native setup", async () => {
    mockHasPainted = true
    mockWebviewReady = false
    renderPane(<BrowserPreviewPane />)

    commitUrl("localhost:3000")

    expect(browserClient.embedSetZoom).not.toHaveBeenCalled()
    expect(browserClient.embedSetPanelLabels).not.toHaveBeenCalled()

    mockWebviewReady = true
    act(() => mockReadyCallback?.())

    await waitFor(() => expect(browserClient.embedSetZoom).toHaveBeenCalledWith(1))
    expect(browserClient.embedSetPanelLabels).toHaveBeenCalled()
  })

  it("applies persisted zoom once the page is live and re-applies on change", async () => {
    mockHasPainted = true
    window.localStorage.setItem("cognia.browser.zoom", "1.5")
    renderPane(<BrowserPreviewPane />)
    commitUrl("localhost:3000")
    await waitFor(() => expect(browserClient.embedSetZoom).toHaveBeenCalledWith(1.5))
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    await waitFor(() => expect(browserClient.embedSetZoom).toHaveBeenCalledWith(1.75))
  })

  it("disables the zoom control until a URL is committed", () => {
    renderPane(<BrowserPreviewPane />)
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled()
  })
})

describe("find-in-page", () => {
  it("opens the find bar from the toolbar and searches the page", async () => {
    ;(browserClient.embedFind as jest.Mock).mockResolvedValue({ matches: 2, index: 0 })
    renderPane(<BrowserPreviewPane />)
    commitUrl("localhost:3000")
    fireEvent.click(screen.getByRole("button", { name: "Find" }))
    fireEvent.change(screen.getByPlaceholderText("Find in page"), { target: { value: "hello" } })
    await waitFor(() =>
      expect(browserClient.embedFind).toHaveBeenCalledWith("hello", { forward: true })
    )
  })

  it("closes the find bar and clears highlights", async () => {
    renderPane(<BrowserPreviewPane />)
    commitUrl("localhost:3000")
    fireEvent.click(screen.getByRole("button", { name: "Find" }))
    expect(screen.getByTestId("browser-find-bar")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Close find" }))
    await waitFor(() => expect(browserClient.embedFindClear).toHaveBeenCalled())
    expect(screen.queryByTestId("browser-find-bar")).not.toBeInTheDocument()
  })
})

describe("history", () => {
  it("records settled pages and re-navigates from the history menu", () => {
    const view = renderPane(<BrowserPreviewPane />)
    // Commit a different address first: it clears the empty state (which offers
    // its own localhost chips) and keeps the address bar's own rendering of the
    // URL from colliding with the history row we want to click.
    commitUrl("localhost:5173")
    // The menu lists where the preview actually arrived, not what was typed —
    // a redirect would otherwise leave the pre-redirect address in the list.
    settleAt(view, "http://localhost:3000/")
    settleAt(view, "http://localhost:5173/")
    // The manual dropdown mock renders items inline; click the earlier page.
    fireEvent.click(screen.getByText("localhost:3000"))
    expect(urlBar()).toHaveValue("http://localhost:3000/")
  })
})

// A ⌘-clicked composer link is broadcast to every mounted pane and CLAIMED by
// whichever one can show the result (`lib/browser/open-url-request.ts`). A pane
// that is mounted but not visible must decline so the caller falls back to the
// OS browser instead of navigating out of sight.
describe("⌘-click link claim", () => {
  /** The claim runs synchronously inside dispatchEvent; act() flushes its state. */
  const claim = (url: string) => {
    let claimed = false
    act(() => {
      claimed = requestBrowserUrl(url)
    })
    return claimed
  }

  it("claims and navigates when the pane is on screen", () => {
    renderPane(<BrowserPreviewPane />)
    expect(claim("example.com/docs")).toBe(true)
    expect(urlBar()).toHaveValue("https://example.com/docs")
  })

  it("declines a malformed URL so the caller can fall back", () => {
    renderPane(<BrowserPreviewPane />)
    expect(claim("   ")).toBe(false)
    expect(urlBar()).toHaveValue("")
  })

  it("declines while hidden when the host cannot reveal it", () => {
    mockRegionVisible = false
    renderPane(<BrowserPreviewPane />)
    expect(claim("https://example.com/docs")).toBe(false)
    expect(urlBar()).toHaveValue("")
  })

  it("declines while hidden when the host's reveal fails", () => {
    mockRegionVisible = false
    const reveal = jest.fn(() => false)
    renderPane(<BrowserPreviewPane onRequestReveal={reveal} />)
    expect(claim("https://example.com/docs")).toBe(false)
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(urlBar()).toHaveValue("")
  })

  it("reveals itself, then claims, when the host can bring it forward", () => {
    mockRegionVisible = false
    const reveal = jest.fn(() => true)
    renderPane(<BrowserPreviewPane onRequestReveal={reveal} />)
    expect(claim("https://example.com/docs")).toBe(true)
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(urlBar()).toHaveValue("https://example.com/docs")
  })

  it("does not ask to reveal a pane that is already visible", () => {
    const reveal = jest.fn(() => true)
    renderPane(<BrowserPreviewPane onRequestReveal={reveal} />)
    expect(claim("https://example.com/docs")).toBe(true)
    expect(reveal).not.toHaveBeenCalled()
  })
})

// D1: the pane used to read only its `sessionId` prop while the hook it calls
// fell back to the focused chat session. `/browser` and the sites publish tab
// pass no prop, so the two disagreed: "Add to queue" wrote a row the queue
// could never show, and the developer panel and Browser Adjust never rendered.
describe("session binding without a sessionId prop", () => {
  it("scopes the annotation queue to the focused chat session", () => {
    renderPane(<BrowserPreviewPane />)
    expect(listActionableBrowserAnnotations).toHaveBeenCalledWith("active-chat")
  })

  it("still prefers an explicit sessionId prop over the focused session", () => {
    renderPane(<BrowserPreviewPane sessionId="s1" />)
    expect(listActionableBrowserAnnotations).toHaveBeenCalledWith("s1")
    expect(listActionableBrowserAnnotations).not.toHaveBeenCalledWith("active-chat")
  })

  it("queues an annotation under the same session the queue reads", async () => {
    mockSelection = SELECTION
    mockQueueAnnotation.mockResolvedValue({ id: "a1", selection: SELECTION })
    renderPane(<BrowserPreviewPane />)
    fireEvent.change(screen.getByPlaceholderText(/Describe the change/i), {
      target: { value: "increase contrast" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }))
    await waitFor(() =>
      expect(mockQueueAnnotation).toHaveBeenCalledWith(
        SELECTION,
        "increase contrast",
        expect.objectContaining({ sessionId: "active-chat" })
      )
    )
    expect(listActionableBrowserAnnotations).toHaveBeenCalledWith("active-chat")
  })

  it("enables the developer panel once a page is committed", () => {
    renderPane(<BrowserPreviewPane />)
    const developer = screen.getByRole("button", { name: "Developer mode" })
    expect(developer).toBeDisabled()
    commitUrl("http://localhost:3000/")
    expect(screen.getByRole("button", { name: "Developer mode" })).toBeEnabled()
  })

  it("renders the developer panel against the focused session", () => {
    renderPane(<BrowserPreviewPane />)
    commitUrl("http://localhost:3000/")
    fireEvent.click(screen.getByRole("button", { name: "Developer mode" }))
    const controls = screen.getByTestId("cdp-controls")
    expect(controls).toHaveAttribute("data-session", "active-chat")
    expect(controls).toHaveAttribute("data-browser-session", "browser:active-chat")
  })

  it("renders Browser Adjust for a selection", () => {
    mockSelection = SELECTION
    renderPane(<BrowserPreviewPane />)
    commitUrl("http://localhost:3000/")
    expect(screen.getByTestId("adjust-controls")).toHaveAttribute("data-session", "active-chat")
  })

  it("keeps an explicit ownerId as the browser-session identity", () => {
    mockSelection = SELECTION
    renderPane(<BrowserPreviewPane ownerId="sites:abc" />)
    commitUrl("http://localhost:3000/")
    expect(screen.getByTestId("adjust-controls")).toHaveAttribute(
      "data-browser-session",
      "sites:abc"
    )
  })

  it("writes nothing and explains itself when no session exists at all", async () => {
    mockActiveChatSessionId = null
    mockSelection = SELECTION
    mockQueueAnnotation.mockResolvedValue(undefined)
    renderPane(<BrowserPreviewPane />)
    expect(listActionableBrowserAnnotations).not.toHaveBeenCalled()
    fireEvent.change(screen.getByPlaceholderText(/Describe the change/i), {
      target: { value: "increase contrast" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Open a chat session first"))
    expect(mockQueueAnnotation).toHaveBeenCalledWith(
      SELECTION,
      "increase contrast",
      expect.objectContaining({ sessionId: undefined })
    )
  })

  it("keeps the developer panel unreachable when no session exists at all", () => {
    mockActiveChatSessionId = null
    renderPane(<BrowserPreviewPane />)
    commitUrl("http://localhost:3000/")
    expect(screen.getByRole("button", { name: "Developer mode" })).toBeDisabled()
  })

  it("surfaces the comment shortcuts that were already implemented", () => {
    mockSelection = SELECTION
    renderPane(<BrowserPreviewPane />)
    expect(screen.getByText("Esc to dismiss · Ctrl+Enter to send")).toBeInTheDocument()
  })
})

// D6: only one pane can drive the single native webview. Before ownership was
// observable, the losing pane sat on its loading placeholder for the full 20s
// settle timeout and then showed an unexplained blank region, while its toolbar
// kept firing commands the native side rejected with "owner token does not
// match" — as un-awaited, invisible promise rejections.
describe("lease ownership", () => {
  it("explains itself and offers a takeover instead of a blank region", () => {
    mockOwned = false
    renderPane(<BrowserPreviewPane />)
    const busy = screen.getByTestId("browser-lease-busy")
    expect(busy).toBeInTheDocument()
    expect(within(busy).getByText("The preview is open in another panel")).toBeInTheDocument()
    fireEvent.click(within(busy).getByRole("button", { name: "Take over here" }))
    expect(mockTakeLease).toHaveBeenCalledTimes(1)
  })

  it("shows neither the empty state nor the loading placeholder while dispossessed", () => {
    mockOwned = false
    mockHasPainted = false
    renderPane(<BrowserPreviewPane />)
    expect(screen.queryByTestId("browser-loading")).toBeNull()
    expect(screen.queryByText("Preview a web page")).toBeNull()
  })

  it("disables every control that would drive the native webview", () => {
    mockOwned = false
    renderPane(<BrowserPreviewPane initialUrl="http://localhost:3000/" />)
    for (const name of [
      "Send screenshot to chat",
      "Select element",
      "Find",
      "Back",
      "Forward",
      "Reload",
      "Zoom in",
      "Zoom out",
    ]) {
      expect(screen.getByRole("button", { name })).toBeDisabled()
    }
  })

  it("keeps those controls usable for the owning pane", () => {
    renderPane(<BrowserPreviewPane initialUrl="http://localhost:3000/" />)
    for (const name of ["Send screenshot to chat", "Select element", "Find", "Reload"]) {
      expect(screen.getByRole("button", { name })).toBeEnabled()
    }
    expect(screen.queryByTestId("browser-lease-busy")).toBeNull()
  })

  it("does not mirror the owner's console and network feeds", () => {
    mockOwned = false
    renderPane(<BrowserPreviewPane />)
    expect(mockDevtoolsOptions).toEqual({ paneId: "browser-embed", enabled: false })
  })
})

// D8: back/forward had no disabled state at all — neither webview exposes
// `canGoBack` through Tauri — so Back on the first page silently did nothing.
// The stack is modelled in the renderer off the events the page already sends.
describe("navigation model", () => {
  const nav = (url: string, extra: Partial<BrowserNavigated> = {}) => {
    mockNavigated = { paneId: "browser-embed", url, ...extra }
  }

  it("disables back and forward with nothing to go back to", () => {
    renderPane(<BrowserPreviewPane initialUrl="http://localhost:3000/" />)
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled()
  })

  it("enables back only after a second page has settled", () => {
    mockLoadedUrl = "http://localhost:3000/"
    const { rerender } = renderPane(<BrowserPreviewPane initialUrl="http://localhost:3000/" />)
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled()

    mockLoadedUrl = "http://localhost:3000/about"
    rerender(
      <TooltipProvider>
        <BrowserPreviewPane initialUrl="http://localhost:3000/" />
      </TooltipProvider>
    )
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled()
  })

  it("steps back and forward through the stack via the native commands", () => {
    mockLoadedUrl = "http://localhost:3000/"
    const { rerender } = renderPane(<BrowserPreviewPane initialUrl="http://localhost:3000/" />)
    const withLoaded = (url: string) => {
      mockLoadedUrl = url
      rerender(
        <TooltipProvider>
          <BrowserPreviewPane initialUrl="http://localhost:3000/" />
        </TooltipProvider>
      )
    }
    withLoaded("http://localhost:3000/about")

    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(browserClient.embedBack).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Forward" })).toBeEnabled()

    fireEvent.click(screen.getByRole("button", { name: "Forward" }))
    expect(browserClient.embedForward).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled()
  })

  it("does not grow the stack when the page reports a traversal it drove", () => {
    mockLoadedUrl = "http://localhost:3000/"
    const { rerender } = renderPane(<BrowserPreviewPane initialUrl="http://localhost:3000/" />)
    const reload = () =>
      rerender(
        <TooltipProvider>
          <BrowserPreviewPane initialUrl="http://localhost:3000/" />
        </TooltipProvider>
      )
    nav("http://localhost:3000/about", { kind: "spa", intent: "push" })
    reload()
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled()

    nav("http://localhost:3000/", { kind: "spa", intent: "traverse" })
    reload()
    // Position moved back, the stack did not grow — forward is reachable again.
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Forward" })).toBeEnabled()
  })

  it("overwrites the current entry for a replaceState route change", () => {
    mockLoadedUrl = "http://localhost:3000/"
    const { rerender } = renderPane(<BrowserPreviewPane initialUrl="http://localhost:3000/" />)
    nav("http://localhost:3000/?tab=2", { kind: "spa", intent: "replace" })
    rerender(
      <TooltipProvider>
        <BrowserPreviewPane initialUrl="http://localhost:3000/" />
      </TooltipProvider>
    )
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled()
  })

  it("ignores document-kind navigations, which fire once per redirect hop", () => {
    mockLoadedUrl = "http://localhost:3000/"
    const { rerender } = renderPane(<BrowserPreviewPane initialUrl="http://localhost:3000/" />)
    nav("http://localhost:3000/hop", { kind: "document", intent: "push" })
    rerender(
      <TooltipProvider>
        <BrowserPreviewPane initialUrl="http://localhost:3000/" />
      </TooltipProvider>
    )
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled()
  })

  it("offers stop while a navigation is in flight", () => {
    mockPhase = "loading"
    renderPane(<BrowserPreviewPane initialUrl="http://localhost:3000/" />)
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Stop loading" }))
    expect(browserClient.embedStop).toHaveBeenCalledTimes(1)
  })

  it("goes back to reload once the page settles", () => {
    mockPhase = "ready"
    renderPane(<BrowserPreviewPane initialUrl="http://localhost:3000/" />)
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Stop loading" })).toBeNull()
  })
})
