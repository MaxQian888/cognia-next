import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"
import type { BrowserNavigated, BrowserSelection, ElementRect } from "@/lib/browser/protocol"

const renderPane = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>)

const mockSetSelectMode = jest.fn().mockResolvedValue(undefined)
const mockClearSelection = jest.fn()
const mockSendComment = jest.fn().mockResolvedValue(true)
const mockSendScreenshot = jest.fn().mockResolvedValue(true)
const mockOpenExternal = jest.fn().mockResolvedValue(undefined)
let mockSelection: BrowserSelection | null = null
let mockNavigated: BrowserNavigated | null = null
let mockTauri = true
let mockSelectMode = false
let mockRect: ElementRect | null = { x: 0, y: 0, width: 100, height: 100 }

jest.mock("@/lib/tauri", () => ({ isTauri: () => mockTauri }))
jest.mock("@/lib/tauri/opener", () => ({
  openExternal: (...args: unknown[]) => mockOpenExternal(...args),
}))
jest.mock("@/hooks/browser/use-browser-pane-webview", () => ({
  useBrowserPaneWebview: () => ({ getRect: () => mockRect, setVisible: jest.fn() }),
}))
jest.mock("@/hooks/browser/use-element-selection", () => ({
  useElementSelection: () => ({
    selection: mockSelection,
    navigated: mockNavigated,
    selectMode: mockSelectMode,
    setSelectMode: mockSetSelectMode,
    clearSelection: mockClearSelection,
  }),
}))
jest.mock("@/hooks/browser/use-selection-to-chat", () => ({
  useSelectionToChat: () => ({ sendComment: mockSendComment, sendScreenshot: mockSendScreenshot }),
}))
jest.mock("@/lib/browser/client", () => ({
  browserClient: {
    embedReload: jest.fn().mockResolvedValue(undefined),
    embedBack: jest.fn().mockResolvedValue(undefined),
    embedForward: jest.fn().mockResolvedValue(undefined),
    embedNavigate: jest.fn().mockResolvedValue(undefined),
    embedSetSelectMode: jest.fn().mockResolvedValue(undefined),
  },
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
import { browserClient } from "@/lib/browser/client"
import { BrowserPreviewPane } from "./browser-preview-pane"

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

/** Type an address into the URL bar and press Enter (form submit). */
const commitUrl = (value: string) => {
  fireEvent.change(urlBar(), { target: { value } })
  fireEvent.submit(urlBar())
}

beforeEach(() => {
  mockSelection = null
  mockNavigated = null
  mockTauri = true
  mockSelectMode = false
  mockRect = { x: 0, y: 0, width: 100, height: 100 }
  mockSetSelectMode.mockClear()
  mockClearSelection.mockClear()
  mockSendComment.mockClear().mockResolvedValue(true)
  mockSendScreenshot.mockClear().mockResolvedValue(true)
  mockOpenExternal.mockClear().mockResolvedValue(undefined)
  ;(browserClient.embedReload as jest.Mock).mockClear()
  ;(browserClient.embedBack as jest.Mock).mockClear()
  ;(browserClient.embedForward as jest.Mock).mockClear()
  ;(browserClient.embedNavigate as jest.Mock).mockClear()
  ;(toast.success as jest.Mock).mockClear()
  ;(toast.error as jest.Mock).mockClear()
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

it("renders the empty state and URL bar in Tauri", () => {
  renderPane(<BrowserPreviewPane />)
  expect(screen.getByText("Preview a local dev server")).toBeInTheDocument()
  expect(urlBar()).toBeInTheDocument()
})

it("commits a typed URL via Enter and clears the empty state", async () => {
  renderPane(<BrowserPreviewPane />)
  commitUrl("localhost:3000")
  await waitFor(() =>
    expect(screen.queryByText("Preview a local dev server")).not.toBeInTheDocument()
  )
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
  await waitFor(() =>
    expect(screen.queryByText("Preview a local dev server")).not.toBeInTheDocument()
  )
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
  renderPane(<BrowserPreviewPane />)
  commitUrl("localhost:3000")
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

it("sends a screenshot of the preview to chat", async () => {
  renderPane(<BrowserPreviewPane />)
  commitUrl("http://localhost:3000/")
  fireEvent.click(screen.getByRole("button", { name: "Send screenshot to chat" }))
  await waitFor(() =>
    expect(mockSendScreenshot).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 100, height: 100 },
      { sessionId: undefined, pageUrl: "http://localhost:3000/" }
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
    expect(mockSendComment).toHaveBeenCalledWith(SELECTION, "make it blue", {
      sessionId: undefined,
      captureRect: { x: 0, y: 0, width: 100, height: 100 },
    })
  )
  expect(toast.success).toHaveBeenCalled()
  expect(mockClearSelection).toHaveBeenCalled()
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
  expect(screen.getByText("Preview a local dev server")).toBeInTheDocument()
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
