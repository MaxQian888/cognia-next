/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

const pickAndReadFilesMock = jest.fn()
jest.mock("@/lib/files/file-bridge", () => ({
  pickAndReadFiles: (args: unknown) => pickAndReadFilesMock(args),
}))

const logError = jest.fn()
jest.mock("@/lib/logger", () => {
  const fn = (...args: unknown[]) => logError(...args)
  return {
    createLogger: () => ({ error: fn, info: jest.fn(), warn: jest.fn() }),
  }
})

const importChatExportMock = jest.fn()
const applyImportedMock = jest.fn()
jest.mock("@/lib/data/import-registry", () => ({
  importChatExport: (raw: unknown) => importChatExportMock(raw),
  applyImported: (conv: unknown) => applyImportedMock(conv),
}))

import { useChatImport } from "./use-chat-import"

beforeEach(() => {
  pickAndReadFilesMock.mockReset()
  importChatExportMock.mockReset()
  applyImportedMock.mockReset()
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
})
