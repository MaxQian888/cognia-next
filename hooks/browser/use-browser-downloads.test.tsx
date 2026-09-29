/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/browser/downloads-client", () => ({
  onBrowserDownload: jest.fn(),
  cancelLocalDownload: jest.fn(),
  isDownloadOpenBlocked: (error: unknown) =>
    String(error instanceof Error ? error.message : error).includes(
      "download_open_blocked_executable"
    ),
  openDownload: jest.fn(),
  readDownload: jest.fn(),
  revealDownload: jest.fn(),
  saveDownloadAs: jest.fn(),
}))
jest.mock("@/hooks/browser/use-selection-to-chat", () => ({
  useSelectionToChat: jest.fn(),
}))

import {
  cancelLocalDownload,
  onBrowserDownload,
  openDownload,
  readDownload,
  revealDownload,
  saveDownloadAs,
} from "@/lib/browser/downloads-client"
import type { BrowserDownloadSummary } from "@/lib/browser/session-types"
import { upsertBrowserDownload, type BrowserDownloadRow } from "@/lib/db/browser-downloads"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { useSelectionToChat } from "@/hooks/browser/use-selection-to-chat"

import {
  acquireBrowserDownloadFeed,
  downloadCapabilities,
  downloadReadFailure,
  resetBrowserDownloadFeedForTests,
  useBrowserDownloadActions,
  useBrowserDownloadFeed,
  useBrowserDownloads,
} from "./use-browser-downloads"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
afterAll(dbFixture.dispose)

const onDownloadMock = onBrowserDownload as jest.Mock
const cancelMock = cancelLocalDownload as jest.Mock
const openMock = openDownload as jest.Mock
const revealMock = revealDownload as jest.Mock
const readMock = readDownload as jest.Mock
const saveAsMock = saveDownloadAs as jest.Mock
const sendFileBytes = jest.fn()

let emit: ((summary: BrowserDownloadSummary) => void) | null = null
const unlisten = jest.fn()

beforeEach(async () => {
  await dbFixture.restore()
  jest.clearAllMocks()
  resetBrowserDownloadFeedForTests()
  emit = null
  onDownloadMock.mockImplementation(async (cb) => {
    emit = cb
    return unlisten
  })
  ;(useSelectionToChat as jest.Mock).mockReturnValue({ sendFileBytes })
})

const row = (overrides: Partial<BrowserDownloadRow> = {}): BrowserDownloadRow => ({
  id: "local-chromium:d1",
  downloadId: "d1",
  sessionId: "s1",
  backend: "local-chromium",
  state: "completed",
  filename: "report.pdf",
  url: "https://example.com/report.pdf",
  size: 10,
  startedAt: 1,
  savedPath: "/Users/me/Downloads/report.pdf",
  updatedAt: 1,
  ...overrides,
})

describe("download feed", () => {
  it("persists every download event while mounted, once however many panes mount it", async () => {
    const first = renderHook(() => useBrowserDownloadFeed(true))
    const second = renderHook(() => useBrowserDownloadFeed(true))
    await waitFor(() => expect(emit).not.toBeNull())
    expect(onDownloadMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      emit?.({
        id: "e1",
        sessionId: "embedded",
        filename: "a.zip",
        size: 0,
        state: "in_progress",
        backend: "embedded",
      })
    })
    await waitFor(async () =>
      expect(await getDb().browserDownloads.get("embedded:e1")).toBeDefined()
    )

    first.unmount()
    expect(unlisten).not.toHaveBeenCalled()
    second.unmount()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it("does nothing when disabled", () => {
    renderHook(() => useBrowserDownloadFeed(false))
    expect(onDownloadMock).not.toHaveBeenCalled()
  })

  it("drops a subscription that resolves after the last user left", async () => {
    let resolve: (fn: () => void) => void = () => undefined
    onDownloadMock.mockImplementation(() => new Promise<() => void>((done) => (resolve = done)))
    const release = acquireBrowserDownloadFeed()
    release()
    release()
    await act(async () => resolve(unlisten))
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})

describe("useBrowserDownloads", () => {
  it("lists history and counts running downloads", async () => {
    await upsertBrowserDownload({ backend: "embedded", downloadId: "a" }, 1)
    await upsertBrowserDownload({ backend: "embedded", downloadId: "b", state: "completed" }, 2)
    const { result } = renderHook(() => useBrowserDownloads())
    await waitFor(() => expect(result.current.downloads).toHaveLength(2))
    expect(result.current.activeCount).toBe(1)
  })
})

describe("downloadCapabilities", () => {
  it("offers cancel only for a running Chromium download", () => {
    expect(downloadCapabilities(row({ state: "in_progress" }))).toMatchObject({
      cancel: true,
      remove: false,
      open: false,
    })
    expect(downloadCapabilities(row({ state: "in_progress", backend: "embedded" })).cancel).toBe(
      false
    )
  })

  it("offers file actions for a finished file on disk and retry for a failed one", () => {
    expect(downloadCapabilities(row())).toMatchObject({
      open: true,
      reveal: true,
      attach: true,
      retry: false,
    })
    expect(downloadCapabilities(row({ state: "failed", savedPath: undefined }))).toMatchObject({
      open: false,
      retry: true,
      remove: true,
    })
    expect(downloadCapabilities(row({ state: "failed", url: undefined })).retry).toBe(false)
  })

  it("offers save as only for a finished local-runtime download", () => {
    expect(downloadCapabilities(row()).saveAs).toBe(true)
    expect(downloadCapabilities(row({ backend: "user-chrome" })).saveAs).toBe(true)
    expect(downloadCapabilities(row({ state: "saved" })).saveAs).toBe(true)
    expect(downloadCapabilities(row({ state: "in_progress" })).saveAs).toBe(false)
    expect(downloadCapabilities(row({ state: "failed" })).saveAs).toBe(false)
    expect(downloadCapabilities(row({ backend: "embedded" })).saveAs).toBe(false)
    expect(downloadCapabilities(row({ backend: "remote" })).saveAs).toBe(false)
    expect(downloadCapabilities(row({ sessionId: "" })).saveAs).toBe(false)
  })

  it("keeps open/reveal on a locally saved copy but not on a cloud one", () => {
    expect(downloadCapabilities(row({ state: "saved" }))).toMatchObject({
      open: true,
      reveal: true,
    })
    expect(downloadCapabilities(row({ state: "saved", backend: "remote" }))).toMatchObject({
      open: false,
      reveal: false,
    })
  })
})

describe("useBrowserDownloadActions", () => {
  it("cancels through the runtime and records it", async () => {
    await upsertBrowserDownload({ backend: "local-chromium", downloadId: "d1", sessionId: "s1" })
    cancelMock.mockResolvedValue(undefined)
    const { result } = renderHook(() => useBrowserDownloadActions())
    let outcome = ""
    await act(async () => {
      outcome = await result.current.cancel(row({ state: "in_progress" }))
    })
    expect(outcome).toBe("ok")
    expect(cancelMock).toHaveBeenCalledWith("s1", "d1")
    expect((await getDb().browserDownloads.get("local-chromium:d1"))?.state).toBe("cancelled")
  })

  it("reports a failed cancel", async () => {
    cancelMock.mockRejectedValue(new Error("gone"))
    const { result } = renderHook(() => useBrowserDownloadActions())
    await act(async () => {
      expect(await result.current.cancel(row({ state: "in_progress" }))).toBe("failed")
    })
  })

  it("saves a copy through the save dialog and records the returned summary", async () => {
    await upsertBrowserDownload({
      backend: "local-chromium",
      downloadId: "d1",
      sessionId: "s1",
      state: "completed",
      savedPath: "/Users/me/Downloads/report.pdf",
    })
    // The runtime summary may omit `backend`; the row keeps its own key.
    saveAsMock.mockResolvedValue({
      id: "d1",
      sessionId: "s1",
      filename: "report.pdf",
      size: 10,
      state: "saved",
      savedPath: "/Users/me/Desktop/report.pdf",
    })
    const { result } = renderHook(() => useBrowserDownloadActions())
    let outcome = ""
    await act(async () => {
      outcome = await result.current.saveAs(row())
    })
    expect(outcome).toBe("ok")
    expect(saveAsMock).toHaveBeenCalledWith("s1", "d1")
    const stored = await getDb().browserDownloads.get("local-chromium:d1")
    expect(stored).toMatchObject({ state: "saved", savedPath: "/Users/me/Desktop/report.pdf" })
    expect(await getDb().browserDownloads.get("remote:d1")).toBeUndefined()
  })

  it("treats a dismissed save dialog as cancelled and a rejection as failed", async () => {
    await upsertBrowserDownload({ backend: "local-chromium", downloadId: "d1", state: "completed" })
    const { result } = renderHook(() => useBrowserDownloadActions())
    saveAsMock.mockResolvedValueOnce(null)
    saveAsMock.mockRejectedValueOnce("download_not_found")
    await act(async () => {
      expect(await result.current.saveAs(row())).toBe("cancelled")
      expect(await result.current.saveAs(row())).toBe("failed")
    })
    expect((await getDb().browserDownloads.get("local-chromium:d1"))?.state).toBe("completed")
  })

  it("opens and reveals the saved file", async () => {
    openMock.mockResolvedValue(undefined)
    revealMock.mockResolvedValue(undefined)
    const { result } = renderHook(() => useBrowserDownloadActions())
    await act(async () => {
      expect(await result.current.open(row())).toBe("ok")
      expect(await result.current.reveal(row())).toBe("ok")
    })
    expect(openMock).toHaveBeenCalledWith("/Users/me/Downloads/report.pdf")
    expect(revealMock).toHaveBeenCalledWith("/Users/me/Downloads/report.pdf")
  })

  it("reports a refused file type as blocked and other errors as failed", async () => {
    const { result } = renderHook(() => useBrowserDownloadActions())
    openMock.mockRejectedValueOnce("download_open_blocked_executable")
    openMock.mockRejectedValueOnce(new Error("download_path_not_allowed"))
    await act(async () => {
      expect(await result.current.open(row())).toBe("blocked")
      expect(await result.current.open(row())).toBe("failed")
    })
  })

  it("attaches the file to the chosen chat and marks it attached", async () => {
    await upsertBrowserDownload({ backend: "local-chromium", downloadId: "d1", state: "completed" })
    readMock.mockResolvedValue(new Uint8Array([1]))
    sendFileBytes.mockResolvedValue("sent")
    const { result } = renderHook(() => useBrowserDownloadActions("chat-9"))
    await act(async () => {
      expect(await result.current.attach(row())).toBe("ok")
    })
    expect(sendFileBytes).toHaveBeenCalledWith(
      new Uint8Array([1]),
      { filename: "report.pdf", mimeType: undefined, sourceUrl: "https://example.com/report.pdf" },
      { sessionId: "chat-9" }
    )
    expect((await getDb().browserDownloads.get("local-chromium:d1"))?.state).toBe("attached")
  })

  it("passes through a refused attach and a read failure", async () => {
    readMock.mockResolvedValue(new Uint8Array([1]))
    sendFileBytes.mockResolvedValue("no-session")
    const { result } = renderHook(() => useBrowserDownloadActions())
    await act(async () => {
      expect(await result.current.attach(row())).toBe("no-session")
      expect(await result.current.attach(row({ savedPath: undefined }))).toBe("failed")
    })
    readMock.mockRejectedValue(new Error("denied"))
    await act(async () => {
      expect(await result.current.attach(row())).toBe("failed")
    })
  })

  it("reports a file Rust refused as too large", async () => {
    readMock.mockRejectedValue("download_too_large: 70000000 bytes")
    const { result } = renderHook(() => useBrowserDownloadActions())
    await act(async () => {
      expect(await result.current.attach(row())).toBe("too-large")
    })
    expect(sendFileBytes).not.toHaveBeenCalled()
  })

  it("removes one entry and clears finished ones", async () => {
    await upsertBrowserDownload({ backend: "local-chromium", downloadId: "d1", state: "completed" })
    await upsertBrowserDownload({ backend: "embedded", downloadId: "x", state: "failed" })
    const { result } = renderHook(() => useBrowserDownloadActions())
    await act(async () => {
      expect(await result.current.remove(row())).toBe("ok")
    })
    expect(await getDb().browserDownloads.get("local-chromium:d1")).toBeUndefined()
    await act(async () => {
      expect(await result.current.clear()).toBe("ok")
    })
    expect(await getDb().browserDownloads.get("embedded:x")).toBeUndefined()
  })
})

describe("downloadReadFailure", () => {
  it("recognizes the size refusal in any error shape", () => {
    expect(downloadReadFailure(new Error("download_too_large"))).toBe("too-large")
    expect(downloadReadFailure("download_too_large")).toBe("too-large")
    expect(downloadReadFailure({ code: 1 })).toBe("failed")
  })
})
