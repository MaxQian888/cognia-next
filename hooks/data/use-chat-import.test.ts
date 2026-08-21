/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

const pickAndReadFilesMock = jest.fn()
jest.mock("@/lib/files/file-bridge", () => ({
  pickAndReadFiles: (args: unknown) => pickAndReadFilesMock(args),
}))

const logError = jest.fn()
jest.mock("@cognia/logging", () => {
  const fn = (...args: unknown[]) => logError(...args)
  return {
    createLogger: () => ({ error: fn, info: jest.fn(), warn: jest.fn() }),
  }
})

const importChatExportMock = jest.fn()
const applyImportedMock = jest.fn()
const acceptedExtensionsMock = jest.fn(() => ["json"])
jest.mock("@/lib/data/import-registry", () => {
  // Declared INSIDE the factory: a module-scope class would be in its TDZ when
  // Jest hoists this call. The hook compares with `instanceof` against this
  // very binding, so it must be a real class, not a plain object.
  class ChatImportUnsupportedError extends Error {
    readonly reason: string
    readonly format: string
    constructor(reason: string, format = "unknown") {
      super(`Could not import this file as a conversation export (${reason}).`)
      this.name = "ChatImportUnsupportedError"
      this.reason = reason
      this.format = format
    }
  }
  return {
    importChatExport: (raw: unknown) => importChatExportMock(raw),
    applyImported: (conv: unknown) => applyImportedMock(conv),
    getAcceptedChatImportExtensions: () => acceptedExtensionsMock(),
    parseChatImportPayload: (raw: string) => {
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    },
    ChatImportUnsupportedError,
  }
})

import { useChatImport } from "./use-chat-import"

beforeEach(() => {
  pickAndReadFilesMock.mockReset()
  importChatExportMock.mockReset()
  applyImportedMock.mockReset()
  acceptedExtensionsMock.mockReset()
  acceptedExtensionsMock.mockReturnValue(["json"])
  logError.mockClear()
})

describe("useChatImport", () => {
  it("starts in idle and reset returns to idle", async () => {
    const { result } = renderHook(() => useChatImport())
    expect(result.current.state.status).toBe("idle")
    act(() => result.current.reset())
    expect(result.current.state.status).toBe("idle")
  })

  it("loading → preview on successful pick + parse", async () => {
    pickAndReadFilesMock.mockResolvedValueOnce([{ content: '{"foo":1}' }])
    importChatExportMock.mockResolvedValueOnce({
      format: "openai",
      conversations: [{ id: "c1" }],
    })
    const { result } = renderHook(() => useChatImport())
    await act(async () => {
      await result.current.pickFile()
    })
    expect(result.current.state.status).toBe("preview")
    if (result.current.state.status === "preview") {
      expect(result.current.state.format).toBe("openai")
      expect(result.current.state.conversations).toHaveLength(1)
    }
  })

  it("returns to idle when no file is picked", async () => {
    pickAndReadFilesMock.mockResolvedValueOnce([])
    const { result } = renderHook(() => useChatImport())
    await act(async () => {
      await result.current.pickFile()
    })
    expect(result.current.state.status).toBe("idle")
  })

  it("transitions to error on parse / import failure", async () => {
    pickAndReadFilesMock.mockResolvedValueOnce([{ content: "not-json" }])
    const { result } = renderHook(() => useChatImport())
    await act(async () => {
      await result.current.pickFile()
    })
    await waitFor(() => expect(result.current.state.status).toBe("error"))
    expect(logError).toHaveBeenCalled()
  })

  it("applyAll: applying → done", async () => {
    pickAndReadFilesMock.mockResolvedValueOnce([{ content: "{}" }])
    importChatExportMock.mockResolvedValueOnce({
      format: "claude",
      conversations: [{ id: "c1" }, { id: "c2" }],
    })
    applyImportedMock.mockResolvedValueOnce({ sessions: 2, messages: 7 })
    const { result } = renderHook(() => useChatImport())
    await act(async () => {
      await result.current.pickFile()
    })
    await act(async () => {
      await result.current.applyAll()
    })
    expect(result.current.state.status).toBe("done")
    if (result.current.state.status === "done") {
      expect(result.current.state.sessionsAdded).toBe(2)
      expect(result.current.state.messagesAdded).toBe(7)
    }
  })

  it("applyAll: noop when not in preview state", async () => {
    const { result } = renderHook(() => useChatImport())
    await act(async () => {
      await result.current.applyAll()
    })
    expect(result.current.state.status).toBe("idle")
    expect(applyImportedMock).not.toHaveBeenCalled()
  })

  it("applyAll: error on apply failure", async () => {
    pickAndReadFilesMock.mockResolvedValueOnce([{ content: "{}" }])
    importChatExportMock.mockResolvedValueOnce({
      format: "claude",
      conversations: [{ id: "c1" }],
    })
    applyImportedMock.mockRejectedValueOnce(new Error("dexie down"))
    const { result } = renderHook(() => useChatImport())
    await act(async () => {
      await result.current.pickFile()
    })
    await act(async () => {
      await result.current.applyAll()
    })
    expect(result.current.state.status).toBe("error")
  })

  it("filters the picker by the registry's extensions, not a hard-coded json", async () => {
    // A plugin importer for a `.zip` Slack export used to be unselectable: the
    // filter was literally `["json"]`.
    acceptedExtensionsMock.mockReturnValue(["json", "zip", "jsonl"])
    pickAndReadFilesMock.mockResolvedValueOnce([])
    const { result } = renderHook(() => useChatImport())
    await act(async () => {
      await result.current.pickFile()
    })
    expect(pickAndReadFilesMock).toHaveBeenCalledWith({
      filters: [{ name: "Chat export", extensions: ["json", "zip", "jsonl"] }],
    })
  })

  it("hands non-JSON file text to the importers as a raw string", async () => {
    // The old flow did `JSON.parse(raw)` before dispatch, so a non-JSON export
    // could never reach an importer even when one was registered for it.
    pickAndReadFilesMock.mockResolvedValueOnce([{ content: "not json at all" }])
    importChatExportMock.mockResolvedValueOnce({ format: "acme:txt", conversations: [] })
    const { result } = renderHook(() => useChatImport())
    await act(async () => {
      await result.current.pickFile()
    })
    expect(importChatExportMock).toHaveBeenCalledWith("not json at all")
    expect(result.current.state.status).toBe("preview")
  })

  it("carries a typed rejection so the dialog can name the right flow", async () => {
    const { ChatImportUnsupportedError } = jest.requireMock("@/lib/data/import-registry") as {
      ChatImportUnsupportedError: new (reason: string, format?: string) => Error
    }
    pickAndReadFilesMock.mockResolvedValueOnce([{ content: '{"version":"3.0"}' }])
    importChatExportMock.mockRejectedValueOnce(
      new ChatImportUnsupportedError("cognia-backup", "cognia-v3")
    )
    const { result } = renderHook(() => useChatImport())
    await act(async () => {
      await result.current.pickFile()
    })
    expect(result.current.state).toMatchObject({
      status: "error",
      rejection: "cognia-backup",
    })
  })

  it("leaves `rejection` unset for an ordinary failure", async () => {
    pickAndReadFilesMock.mockRejectedValueOnce(new Error("picker exploded"))
    const { result } = renderHook(() => useChatImport())
    await act(async () => {
      await result.current.pickFile()
    })
    expect(result.current.state).toEqual({ status: "error", message: "picker exploded" })
  })
})
