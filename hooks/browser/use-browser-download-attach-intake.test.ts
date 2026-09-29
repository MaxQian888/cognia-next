/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor } from "@testing-library/react"

jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))
jest.mock("@/lib/browser/downloads-client", () => ({
  ...jest.requireActual("@/lib/browser/downloads-client"),
  readDownload: jest.fn(),
}))
jest.mock("@/lib/db/browser-downloads", () => ({
  ...jest.requireActual("@/lib/db/browser-downloads"),
  upsertBrowserDownload: jest.fn().mockResolvedValue(undefined),
}))
// Keep the chat runtime's import graph out of this suite.
jest.mock("@/hooks/browser/use-browser-downloads", () => ({
  downloadReadFailure: (error: unknown) =>
    String(error).includes("download_too_large") ? "too-large" : "failed",
}))
jest.mock("@/hooks/browser/use-selection-to-chat", () => ({
  mediaTypeForFilename: (name: string) =>
    name.endsWith(".png") ? "image/png" : "application/octet-stream",
}))

import { toast } from "sonner"

import { readDownload, requestBrowserDownloadAttach } from "@/lib/browser/downloads-client"
import type { BrowserDownloadSummary } from "@/lib/browser/session-types"
import { upsertBrowserDownload } from "@/lib/db/browser-downloads"

import { useBrowserDownloadAttachIntake } from "./use-browser-download-attach-intake"

const readMock = readDownload as jest.Mock
const upsertMock = upsertBrowserDownload as jest.Mock

const DOWNLOAD: BrowserDownloadSummary = {
  id: "d1",
  sessionId: "s1",
  filename: "shot.png",
  size: 3,
  state: "completed",
  backend: "local-chromium",
  savedPath: "/Users/me/Downloads/shot.png",
}

beforeEach(() => {
  jest.clearAllMocks()
  readMock.mockResolvedValue(new Uint8Array([1, 2, 3]))
})

function mount(sessionId: string | null, staged: (files: File[]) => File[] = (files) => files) {
  const acceptFiles = jest.fn(async (files: File[]) => staged(files))
  const hook = renderHook(() => useBrowserDownloadAttachIntake({ sessionId, acceptFiles }))
  return { ...hook, acceptFiles }
}

it("claims a request for its own chat and stages the file through the intake gate", async () => {
  const { acceptFiles } = mount("chat-1")
  expect(requestBrowserDownloadAttach(DOWNLOAD, "chat-1")).toBe(true)
  await waitFor(() => expect(acceptFiles).toHaveBeenCalled())
  expect(readMock).toHaveBeenCalledWith("/Users/me/Downloads/shot.png")
  const [file] = acceptFiles.mock.calls[0][0]
  expect(file.name).toBe("shot.png")
  expect(file.type).toBe("image/png")
  expect(file.size).toBe(3)
  await waitFor(() =>
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ downloadId: "d1", backend: "local-chromium", state: "attached" })
    )
  )
})

it("leaves another chat's request, a pathless download and a sessionless composer unclaimed", () => {
  mount("chat-1")
  mount(null)
  expect(requestBrowserDownloadAttach(DOWNLOAD, "chat-2")).toBe(false)
  expect(requestBrowserDownloadAttach({ ...DOWNLOAD, savedPath: undefined }, "chat-1")).toBe(false)
  expect(readMock).not.toHaveBeenCalled()
})

it("stops listening on unmount", () => {
  const { unmount } = mount("chat-1")
  unmount()
  expect(requestBrowserDownloadAttach(DOWNLOAD, "chat-1")).toBe(false)
})

it("explains a file too large to attach, and any other read failure", async () => {
  mount("chat-1")
  readMock.mockRejectedValueOnce("download_too_large")
  requestBrowserDownloadAttach(DOWNLOAD, "chat-1")
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "This file is larger than 64 MB and can't be attached to the chat."
    )
  )
  readMock.mockRejectedValueOnce(new Error("outside_downloads"))
  requestBrowserDownloadAttach(DOWNLOAD, "chat-1")
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith("Could not attach the file to the chat")
  )
})

it("does not mark a file the gate refused as attached", async () => {
  const { acceptFiles } = mount("chat-1", () => [])
  requestBrowserDownloadAttach({ ...DOWNLOAD, filename: "" }, "chat-1")
  await waitFor(() => expect(acceptFiles).toHaveBeenCalled())
  expect(acceptFiles.mock.calls[0][0][0].name).toBe("shot.png")
  expect(upsertMock).not.toHaveBeenCalled()
})
