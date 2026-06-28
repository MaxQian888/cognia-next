import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"
import type { BrowserSelection } from "@/lib/browser/protocol"

const renderPane = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>)

const mockSetSelectMode = jest.fn().mockResolvedValue(undefined)
const mockClearSelection = jest.fn()
const mockSendComment = jest.fn().mockResolvedValue(true)
let mockSelection: BrowserSelection | null = null
let mockTauri = true
let mockSelectMode = false

jest.mock("@/lib/tauri", () => ({ isTauri: () => mockTauri }))
jest.mock("@/hooks/browser/use-browser-pane-webview", () => ({
  useBrowserPaneWebview: () => ({ rect: null, setVisible: jest.fn() }),
}))
jest.mock("@/hooks/browser/use-element-selection", () => ({
  useElementSelection: () => ({
    selection: mockSelection,
    navigated: null,
    selectMode: mockSelectMode,
    setSelectMode: mockSetSelectMode,
    clearSelection: mockClearSelection,
  }),
}))
jest.mock("@/hooks/browser/use-selection-to-chat", () => ({
  useSelectionToChat: () => ({ sendComment: mockSendComment }),
}))
jest.mock("@/lib/browser/client", () => ({
  browserClient: {
    embedReload: jest.fn().mockResolvedValue(undefined),
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

beforeEach(() => {
  mockSelection = null
  mockTauri = true
  mockSelectMode = false
  mockSetSelectMode.mockClear()
  mockClearSelection.mockClear()
  mockSendComment.mockClear().mockResolvedValue(true)
  ;(toast.success as jest.Mock).mockClear()
  ;(toast.error as jest.Mock).mockClear()
})

it("falls back to the sandboxed WebPreview URL bar + iframe outside Tauri", () => {
  mockTauri = false
  const { container } = renderPane(<BrowserPreviewPane />)
  // No native element-selection chrome; instead a WebPreview URL bar.
  expect(screen.getByTestId("browser-web-preview")).toBeInTheDocument()
  expect(screen.getByPlaceholderText("http://localhost:3000")).toBeInTheDocument()
  // Typing a URL + Enter points the sandboxed iframe at it.
  fireEvent.change(screen.getByPlaceholderText("http://localhost:3000"), {
    target: { value: "https://localhost:3000" },
  })
  fireEvent.keyDown(screen.getByPlaceholderText("http://localhost:3000"), { key: "Enter" })
  const iframe = container.querySelector("iframe")
  expect(iframe).toHaveAttribute("src", "https://localhost:3000")
  expect(iframe).toHaveAttribute("sandbox")
})

it("renders the empty state and URL bar in Tauri", () => {
  renderPane(<BrowserPreviewPane />)
  expect(screen.getByText("Preview a local dev server")).toBeInTheDocument()
  expect(screen.getByPlaceholderText("http://localhost:3000")).toBeInTheDocument()
})

it("commits a typed URL and clears the empty state", async () => {
  renderPane(<BrowserPreviewPane />)
  fireEvent.change(screen.getByPlaceholderText("http://localhost:3000"), {
    target: { value: "localhost:3000" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Go" }))
  await waitFor(() =>
    expect(screen.queryByText("Preview a local dev server")).not.toBeInTheDocument()
  )
})

it("toggles select mode after a URL is committed", () => {
  renderPane(<BrowserPreviewPane />)
  fireEvent.change(screen.getByPlaceholderText("http://localhost:3000"), {
    target: { value: "localhost:3000" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Go" }))
  fireEvent.click(screen.getByRole("button", { name: "Select element" }))
  expect(mockSetSelectMode).toHaveBeenCalledWith(true)
})

it("sends a selection comment to chat and clears on success", async () => {
  mockSelection = SELECTION
  renderPane(<BrowserPreviewPane />)
  expect(screen.getByText("#root > button")).toBeInTheDocument()
  fireEvent.change(screen.getByPlaceholderText(/Describe the change/i), {
    target: { value: "make it blue" },
  })
  fireEvent.click(screen.getByRole("button", { name: /Send to chat/i }))
  await waitFor(() =>
    expect(mockSendComment).toHaveBeenCalledWith(SELECTION, "make it blue", {
      sessionId: undefined,
    })
  )
  expect(toast.success).toHaveBeenCalled()
  expect(mockClearSelection).toHaveBeenCalled()
})

it("reloads the committed page", () => {
  renderPane(<BrowserPreviewPane />)
  fireEvent.change(screen.getByPlaceholderText("http://localhost:3000"), {
    target: { value: "localhost:3000" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Go" }))
  fireEvent.click(screen.getByRole("button", { name: "Reload" }))
  expect(browserClient.embedReload).toHaveBeenCalled()
})

it("labels the toggle as cancel while select mode is active", () => {
  mockSelectMode = true
  renderPane(<BrowserPreviewPane />)
  fireEvent.change(screen.getByPlaceholderText("http://localhost:3000"), {
    target: { value: "localhost:3000" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Go" }))
  expect(screen.getByRole("button", { name: "Cancel selection" })).toBeInTheDocument()
})

it("rejects an unparseable URL with an error toast", () => {
  renderPane(<BrowserPreviewPane />)
  fireEvent.change(screen.getByPlaceholderText("http://localhost:3000"), {
    target: { value: "   " },
  })
  fireEvent.click(screen.getByRole("button", { name: "Go" }))
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
