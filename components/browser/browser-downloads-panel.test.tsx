/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"
import type { BrowserDownloadRow } from "@/lib/db/browser-downloads"

jest.mock("@/components/ui/popover")
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
// Cut the real chat runtime out of the actual module's import graph.
jest.mock("@/hooks/browser/use-selection-to-chat", () => ({ useSelectionToChat: jest.fn() }))
jest.mock("@/lib/browser/downloads-client", () => ({}))
jest.mock("@/hooks/browser/use-browser-downloads", () => ({
  ...jest.requireActual("@/hooks/browser/use-browser-downloads"),
  useBrowserDownloads: jest.fn(),
  useBrowserDownloadActions: jest.fn(),
}))

import { toast } from "sonner"
import {
  useBrowserDownloadActions,
  useBrowserDownloads,
  type BrowserDownloadActions,
} from "@/hooks/browser/use-browser-downloads"

import { BrowserDownloadsButton, BrowserDownloadsPanel } from "./browser-downloads-panel"

const row = (overrides: Partial<BrowserDownloadRow> = {}): BrowserDownloadRow => ({
  id: "local-chromium:d1",
  downloadId: "d1",
  sessionId: "s1",
  backend: "local-chromium",
  state: "completed",
  filename: "report.pdf",
  url: "https://example.com/report.pdf",
  size: 2048,
  startedAt: 1,
  savedPath: "/d/report.pdf",
  updatedAt: 1,
  ...overrides,
})

function makeActions(): jest.Mocked<BrowserDownloadActions> {
  return {
    cancel: jest.fn().mockResolvedValue("ok"),
    saveAs: jest.fn().mockResolvedValue("ok"),
    open: jest.fn().mockResolvedValue("ok"),
    reveal: jest.fn().mockResolvedValue("ok"),
    attach: jest.fn().mockResolvedValue("ok"),
    remove: jest.fn().mockResolvedValue("ok"),
    clear: jest.fn().mockResolvedValue("ok"),
  }
}

const renderPanel = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>)

beforeEach(() => jest.clearAllMocks())

describe("BrowserDownloadsPanel", () => {
  it("shows an empty state and disables clear", () => {
    renderPanel(<BrowserDownloadsPanel downloads={[]} actions={makeActions()} />)
    expect(screen.getByText("Nothing downloaded yet.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Clear list" })).toBeDisabled()
  })

  it("shows progress and cancel for a running download", async () => {
    const actions = makeActions()
    renderPanel(
      <BrowserDownloadsPanel
        downloads={[
          row({ state: "in_progress", receivedBytes: 512, totalBytes: 1024, savedPath: undefined }),
        ]}
        actions={actions}
      />
    )
    expect(screen.getByText("Downloading")).toBeInTheDocument()
    expect(screen.getByText("512 B of 1.0 KB")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Open file" })).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel download" }))
    })
    expect(actions.cancel).toHaveBeenCalled()
  })

  it("shows received bytes when the total is unknown", () => {
    renderPanel(
      <BrowserDownloadsPanel
        downloads={[row({ state: "in_progress", receivedBytes: 10, backend: "embedded" })]}
        actions={makeActions()}
      />
    )
    expect(screen.getByText("10 B")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Cancel download" })).toBeNull()
  })

  it("runs file actions on a finished download and reports the attach", async () => {
    const actions = makeActions()
    renderPanel(<BrowserDownloadsPanel downloads={[row()]} actions={actions} />)
    expect(screen.getByText("2.0 KB")).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open file" }))
      fireEvent.click(screen.getByRole("button", { name: "Show in folder" }))
      fireEvent.click(screen.getByRole("button", { name: "Attach to chat" }))
      fireEvent.click(screen.getByRole("button", { name: "Remove from list" }))
      fireEvent.click(screen.getByRole("button", { name: "Clear list" }))
    })
    expect(actions.open).toHaveBeenCalled()
    expect(actions.reveal).toHaveBeenCalled()
    expect(actions.attach).toHaveBeenCalled()
    expect(actions.remove).toHaveBeenCalled()
    expect(actions.clear).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith("Attached to the chat")
  })

  it("explains failures", async () => {
    const actions = makeActions()
    actions.open.mockResolvedValue("failed")
    actions.attach.mockResolvedValue("no-session")
    renderPanel(<BrowserDownloadsPanel downloads={[row()]} actions={actions} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open file" }))
      fireEvent.click(screen.getByRole("button", { name: "Attach to chat" }))
    })
    expect(toast.error).toHaveBeenCalledWith("Could not open the file")
    expect(toast.error).toHaveBeenCalledWith("Open a chat session first")
    // A type Rust will not open offers "show in folder" instead.
    actions.open.mockResolvedValue("blocked")
    ;(toast.error as jest.Mock).mockClear()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open file" }))
    })
    expect(toast.error).toHaveBeenCalledWith(
      "This kind of file isn't opened from here. Use Show in folder instead.",
      expect.objectContaining({ action: expect.objectContaining({ label: "Show in folder" }) })
    )
    const { action } = (toast.error as jest.Mock).mock.calls[0][1] as {
      action: { onClick: () => void }
    }
    await act(async () => {
      action.onClick()
    })
    expect(actions.reveal).toHaveBeenCalled()
    actions.attach.mockResolvedValue("too-large")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Attach to chat" }))
    })
    expect(toast.error).toHaveBeenCalledWith(
      "This file is larger than 64 MB and can't be attached to the chat."
    )
  })

  it("offers save as on a finished local download: cancel is silent, errors toast", async () => {
    const actions = makeActions()
    renderPanel(<BrowserDownloadsPanel downloads={[row()]} actions={actions} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save as…" }))
    })
    expect(actions.saveAs).toHaveBeenCalledWith(expect.objectContaining({ downloadId: "d1" }))
    expect(toast.error).not.toHaveBeenCalled()

    actions.saveAs.mockResolvedValue("cancelled")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save as…" }))
    })
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()

    actions.saveAs.mockResolvedValue("failed")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save as…" }))
    })
    expect(toast.error).toHaveBeenCalledWith("Could not save a copy of the file")
  })

  it("hides save as for embedded downloads and running ones", () => {
    renderPanel(
      <BrowserDownloadsPanel
        downloads={[
          row({ backend: "embedded", id: "embedded:d1" }),
          row({ state: "in_progress", id: "local-chromium:d2", downloadId: "d2" }),
        ]}
        actions={makeActions()}
      />
    )
    expect(screen.queryByRole("button", { name: "Save as…" })).toBeNull()
  })

  it("retries a failed download through the pane and shows its error", () => {
    const onRetry = jest.fn()
    renderPanel(
      <BrowserDownloadsPanel
        downloads={[row({ state: "failed", error: "net::ERR_FAILED", savedPath: undefined })]}
        actions={makeActions()}
        onRetry={onRetry}
      />
    )
    expect(screen.getByText("Download failed: net::ERR_FAILED")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Download again" }))
    expect(onRetry).toHaveBeenCalledWith("https://example.com/report.pdf")
  })
})

describe("BrowserDownloadsButton", () => {
  it("badges running downloads", () => {
    ;(useBrowserDownloads as jest.Mock).mockReturnValue({
      downloads: [row({ state: "in_progress" })],
      activeCount: 1,
    })
    ;(useBrowserDownloadActions as jest.Mock).mockReturnValue(makeActions())
    renderPanel(<BrowserDownloadsButton chatSessionId="c1" />)
    expect(screen.getByRole("button", { name: "Downloads, 1 in progress" })).toBeInTheDocument()
    expect(screen.getByTestId("browser-downloads-badge")).toHaveTextContent("1")
    expect(useBrowserDownloadActions).toHaveBeenCalledWith("c1")
  })

  it("has a plain label when nothing is running", () => {
    ;(useBrowserDownloads as jest.Mock).mockReturnValue({ downloads: [], activeCount: 0 })
    ;(useBrowserDownloadActions as jest.Mock).mockReturnValue(makeActions())
    renderPanel(<BrowserDownloadsButton />)
    expect(screen.getByRole("button", { name: "Downloads" })).toBeInTheDocument()
    expect(screen.queryByTestId("browser-downloads-badge")).toBeNull()
  })
})
