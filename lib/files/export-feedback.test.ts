/**
 * @jest-environment jsdom
 */
const toastSuccessMock = jest.fn()
const toastErrorMock = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccessMock(...a),
    error: (...a: unknown[]) => toastErrorMock(...a),
  },
}))

const revealItemInDirMock = jest.fn()
jest.mock("@/lib/native/opener", () => ({
  revealItemInDir: (...a: unknown[]) => revealItemInDirMock(...a),
}))

const shareMock = jest.fn()
jest.mock("@/lib/capacitor/share", () => ({
  share: (...a: unknown[]) => shareMock(...a),
}))

import { notifyExportOutcome } from "./export-feedback"
import type { SaveExportOutcome } from "./save-export"

// Echoes the key + a JSON of the vars so assertions can see both.
const t = (key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key

beforeEach(() => {
  toastSuccessMock.mockReset()
  toastErrorMock.mockReset()
  revealItemInDirMock.mockReset()
  shareMock.mockReset()
})

describe("notifyExportOutcome", () => {
  it("stays silent on cancellation", () => {
    notifyExportOutcome({ kind: "cancelled" }, { t })
    expect(toastSuccessMock).not.toHaveBeenCalled()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it("shows an error toast on failure", () => {
    notifyExportOutcome({ kind: "error", message: "boom" }, { t })
    expect(toastErrorMock).toHaveBeenCalledWith('location.exportFailed:{"message":"boom"}')
  })

  it("web: reports the downloads folder with the filename", () => {
    const outcome: SaveExportOutcome = {
      kind: "saved",
      platform: "web",
      location: "downloads",
      filename: "chat.md",
    }
    notifyExportOutcome(outcome, { t })
    expect(toastSuccessMock).toHaveBeenCalledWith(
      'location.savedToDownloads:{"filename":"chat.md"}'
    )
  })

  it("tauri: shows the path with a reveal-in-folder action", () => {
    const outcome: SaveExportOutcome = {
      kind: "saved",
      platform: "tauri",
      location: "/home/u/chat.md",
      filename: "chat.md",
    }
    notifyExportOutcome(outcome, { t })
    expect(toastSuccessMock).toHaveBeenCalledWith(
      'location.savedToPath:{"path":"/home/u/chat.md"}',
      expect.objectContaining({
        action: expect.objectContaining({ label: "location.revealInFolder" }),
      })
    )
    // Fire the action and confirm it reveals the saved file.
    const opts = toastSuccessMock.mock.calls[0][1] as { action: { onClick: () => void } }
    opts.action.onClick()
    expect(revealItemInDirMock).toHaveBeenCalledWith("/home/u/chat.md")
  })

  it("mobile: shows the path with a share action using the file uri", () => {
    const outcome: SaveExportOutcome = {
      kind: "saved",
      platform: "mobile",
      location: "Documents/cognia/exports/chat.md",
      uri: "file:///docs/chat.md",
      filename: "chat.md",
    }
    notifyExportOutcome(outcome, { t, shareTitle: "My chat" })
    const opts = toastSuccessMock.mock.calls[0][1] as {
      action: { label: string; onClick: () => void }
    }
    expect(opts.action.label).toBe("location.shareFile")
    opts.action.onClick()
    expect(shareMock).toHaveBeenCalledWith({ title: "My chat", files: ["file:///docs/chat.md"] })
  })

  it("mobile: falls back to location when uri is absent", () => {
    const outcome: SaveExportOutcome = {
      kind: "saved",
      platform: "mobile",
      location: "file:///docs/x.md",
      filename: "x.md",
    }
    notifyExportOutcome(outcome, { t })
    const opts = toastSuccessMock.mock.calls[0][1] as { action: { onClick: () => void } }
    opts.action.onClick()
    expect(shareMock).toHaveBeenCalledWith({ title: undefined, files: ["file:///docs/x.md"] })
  })
})
