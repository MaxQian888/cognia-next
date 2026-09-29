/** @jest-environment jsdom */
type Handler = (payload: unknown) => void
const subscribers = new Map<string, Handler>()
const localHandlers: Array<(event: unknown) => void> = []
const mockRpc = jest.fn()
const mockOnEvent = jest.fn()

jest.mock("@/lib/tauri", () => ({
  transport: {
    call: jest.fn(),
    subscribe: jest.fn((event: string, handler: Handler) => {
      subscribers.set(event, handler)
      return () => subscribers.delete(event)
    }),
  },
}))

jest.mock("@/lib/browser/local-client", () => ({
  toFrameBytes: jest.requireActual("@/lib/browser/local-client").toFrameBytes,
  localBrowser: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    onEvent: (...args: unknown[]) => mockOnEvent(...args),
  },
}))

import { transport } from "@/lib/tauri"
import type { BrowserDownloadSummary } from "./session-types"
import {
  EMBEDDED_DOWNLOAD_EVENT,
  onBrowserDownloadAttachRequest,
  requestBrowserDownloadAttach,
  cancelLocalDownload,
  embeddedDownloadToSummary,
  getDownloadsDir,
  onBrowserDownload,
  openDownload,
  readDownload,
  revealDownload,
  chooseDownloadsDir,
  resetDownloadsDir,
  setAskWhereToSave,
  isDownloadOpenBlocked,
  saveDownloadAs,
} from "./downloads-client"

const call = transport.call as jest.Mock

beforeEach(() => {
  call.mockReset()
  call.mockResolvedValue(undefined)
  mockRpc.mockReset()
  mockRpc.mockResolvedValue(undefined)
  mockOnEvent.mockReset()
  mockOnEvent.mockImplementation(async (handler: (event: unknown) => void) => {
    localHandlers.push(handler)
    return () => localHandlers.splice(localHandlers.indexOf(handler), 1)
  })
  subscribers.clear()
  localHandlers.length = 0
})

it("wraps the downloads directory and file commands without renderer paths", async () => {
  await getDownloadsDir()
  await chooseDownloadsDir(true)
  await resetDownloadsDir()
  await setAskWhereToSave(false)
  await revealDownload("/d/a.pdf")
  await openDownload("/d/a.pdf")
  expect(call.mock.calls).toEqual([
    ["browser_downloads_dir_get"],
    ["browser_downloads_dir_choose", { askWhereToSave: true }],
    ["browser_downloads_dir_reset"],
    ["browser_downloads_dir_set", { askWhereToSave: false }],
    ["browser_download_reveal", { path: "/d/a.pdf" }],
    ["browser_download_open", { path: "/d/a.pdf" }],
  ])
})

it("saves a local download through the native save dialog command", async () => {
  const saved = {
    id: "d1",
    sessionId: "s1",
    filename: "a.pdf",
    size: 3,
    state: "saved",
    savedPath: "/Users/me/Desktop/a.pdf",
  }
  call.mockResolvedValueOnce(saved)
  await expect(saveDownloadAs("s1", "d1")).resolves.toEqual(saved)
  expect(call).toHaveBeenCalledWith("browser_download_save_as", {
    sessionId: "s1",
    downloadId: "d1",
  })
  expect(mockRpc).not.toHaveBeenCalled()
})

it("resolves a cancelled save dialog to null and propagates Rust errors", async () => {
  call.mockResolvedValueOnce(null)
  await expect(saveDownloadAs("s1", "d1")).resolves.toBeNull()
  call.mockRejectedValueOnce("download_not_found")
  await expect(saveDownloadAs("s1", "missing")).rejects.toBe("download_not_found")
})

it("resolves a cancelled folder picker to null", async () => {
  call.mockResolvedValueOnce(null)
  await expect(chooseDownloadsDir(false)).resolves.toBeNull()
  const info = { path: "/Volumes/Data/dl", isDefault: false, askWhereToSave: false }
  call.mockResolvedValueOnce(info)
  await expect(chooseDownloadsDir(false)).resolves.toEqual(info)
})

it("recognises the blocked-type refusal", () => {
  expect(isDownloadOpenBlocked("download_open_blocked_executable")).toBe(true)
  expect(isDownloadOpenBlocked(new Error("download_open_blocked_executable"))).toBe(true)
  expect(isDownloadOpenBlocked(new Error("download_not_found"))).toBe(false)
})

it("routes local download cancel through the runtime op", async () => {
  await cancelLocalDownload("s", "d")
  expect(mockRpc.mock.calls).toEqual([
    ["browser.download.cancel", { sessionId: "s", downloadId: "d" }],
  ])
  expect(mockRpc).not.toHaveBeenCalledWith("browser.download.save", expect.anything())
})

describe("embeddedDownloadToSummary", () => {
  const requested = {
    phase: "requested" as const,
    id: "e1",
    url: "https://a.test/f.zip",
    filename: "f.zip",
  }

  it("starts in progress and keeps startedAt through completion", () => {
    const first = embeddedDownloadToSummary(requested, undefined, 100)
    expect(first).toMatchObject({
      state: "in_progress",
      startedAt: 100,
      backend: "embedded",
      sessionId: "embedded",
    })
    const done = embeddedDownloadToSummary(
      { ...requested, phase: "finished", success: true, savedPath: "/d/f (1).zip", filename: "" },
      first,
      200
    )
    expect(done).toMatchObject({
      state: "completed",
      startedAt: 100,
      finishedAt: 200,
      savedPath: "/d/f (1).zip",
      filename: "f (1).zip",
    })
  })

  it("marks failures with the reported error", () => {
    expect(
      embeddedDownloadToSummary({ ...requested, phase: "finished", success: false }, undefined, 5)
    ).toMatchObject({ state: "failed", error: "download_failed" })
    expect(
      embeddedDownloadToSummary(
        { ...requested, phase: "finished", error: "disk_full" },
        undefined,
        5
      )
    ).toMatchObject({ state: "failed", error: "disk_full" })
  })
})

it("folds embedded and local download events into one feed", async () => {
  const seen: BrowserDownloadSummary[] = []
  let clock = 10
  const unlisten = await onBrowserDownload((d) => seen.push(d), { now: () => clock++ })
  const embedded = subscribers.get(EMBEDDED_DOWNLOAD_EVENT)!
  embedded({ phase: "requested", id: "e1", url: "u", filename: "a.txt" })
  embedded({
    phase: "finished",
    id: "e1",
    url: "u",
    filename: "a.txt",
    success: true,
    savedPath: "/d/a.txt",
  })
  embedded({ bogus: true })
  localHandlers[0]({
    type: "download.updated",
    sessionId: "s1",
    download: { id: "l1", sessionId: "s1", filename: "b.pdf", size: 3, state: "in_progress" },
  })
  localHandlers[0]({ type: "download.updated", sessionId: "s1", download: { id: "bad" } })
  localHandlers[0]({ type: "pages.changed", sessionId: "s1" })
  expect(seen.map((d) => [d.id, d.state])).toEqual([
    ["e1", "in_progress"],
    ["e1", "completed"],
    ["l1", "in_progress"],
  ])
  expect(seen[1].startedAt).toBe(10)
  unlisten()
  expect(subscribers.size).toBe(0)
  expect(localHandlers).toHaveLength(0)
})

it("detaches the embedded listener when the local subscription fails", async () => {
  mockOnEvent.mockRejectedValueOnce(new Error("no ipc"))
  await expect(onBrowserDownload(() => undefined)).rejects.toThrow("no ipc")
  expect(subscribers.size).toBe(0)
})

describe("download attach requests", () => {
  const download = {
    id: "d1",
    sessionId: "s1",
    filename: "a.pdf",
    size: 3,
    state: "completed" as const,
  }

  it("is claimed by the composer that owns the chat", () => {
    const seen: string[] = []
    const off = onBrowserDownloadAttachRequest((request) => {
      seen.push(request.chatSessionId)
      return request.chatSessionId === "chat-1"
    })
    expect(requestBrowserDownloadAttach(download, "chat-1")).toBe(true)
    expect(requestBrowserDownloadAttach(download, "chat-2")).toBe(false)
    off()
    expect(requestBrowserDownloadAttach(download, "chat-1")).toBe(false)
    expect(seen).toEqual(["chat-1", "chat-2"])
  })

  it("ignores malformed downloads", () => {
    const handler = jest.fn(() => true)
    const off = onBrowserDownloadAttachRequest(handler)
    expect(requestBrowserDownloadAttach({ id: "x" } as unknown as typeof download, "chat-1")).toBe(
      false
    )
    expect(handler).not.toHaveBeenCalled()
    off()
  })
})

describe("readDownload", () => {
  it("normalizes the raw response to bytes", async () => {
    call.mockResolvedValueOnce(new Uint8Array([1, 2]).buffer)
    await expect(readDownload("/d/a.bin")).resolves.toEqual(new Uint8Array([1, 2]))
    expect(call).toHaveBeenLastCalledWith("browser_download_read", { path: "/d/a.bin" })
    call.mockResolvedValueOnce([3, 4])
    await expect(readDownload("/d/b.bin")).resolves.toEqual(new Uint8Array([3, 4]))
    call.mockResolvedValueOnce(new Uint8Array([5]))
    await expect(readDownload("/d/c.bin")).resolves.toEqual(new Uint8Array([5]))
  })

  it("rejects a response that carries no bytes", async () => {
    call.mockResolvedValueOnce({ nope: true })
    await expect(readDownload("/d/a.bin")).rejects.toThrow("no bytes")
  })
})
