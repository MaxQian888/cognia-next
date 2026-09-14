/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

import enChat from "@/i18n/messages/en/chat.json"
import type { SelectionRunRequest, SelectionRunState } from "@/hooks/chat/use-selection-action-run"
import { selectComposerContextSelections, useChatStore } from "@/stores/chat/chat-store"
import { useMessageSelectionActions } from "./use-message-selection-actions"

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

let mockRunState: SelectionRunState = { status: "idle" }
const mockBegin = jest.fn()
const mockClose = jest.fn()
jest.mock("@/hooks/chat/use-selection-action-run", () => ({
  useSelectionActionRun: () => ({
    state: mockRunState,
    run: mockBegin,
    stop: jest.fn(),
    close: mockClose,
  }),
}))

const mockBuildExcerpt = jest.fn()
jest.mock("@/lib/chat/selection/message-excerpt", () => ({
  buildMessageExcerptSelection: (input: unknown) => mockBuildExcerpt(input),
}))

let mockSavedLocale: string | null = null
const mockSetPref = jest.fn(async () => undefined)
jest.mock("@/lib/tauri/store", () => ({
  getPref: jest.fn(async () => mockSavedLocale),
  setPref: (...args: unknown[]) => mockSetPref(...(args as [])),
}))

const copy = enChat.selection
const PASSAGE = { text: "the lockfile is stale", messageIds: ["m1"], context: "whole reply" }

function chip(title: string) {
  return {
    kind: "entity",
    entityKind: "message",
    entityId: "s1#m1",
    title,
    snapshot: "x",
    comment: "",
    capturedAt: 1,
  }
}

const staged = () => selectComposerContextSelections(useChatStore.getState(), "s1")

function setup() {
  return renderHook(() => useMessageSelectionActions({ sessionId: "s1" }))
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRunState = { status: "idle" }
  mockSavedLocale = null
  act(() => useChatStore.getState().clear())
})

describe("useMessageSelectionActions", () => {
  describe("referencePassage", () => {
    it("stages the passage as a quote into the conversation's composer", async () => {
      mockBuildExcerpt.mockResolvedValue(chip("user: the lockfile…"))
      const { result } = setup()
      let ok = false
      await act(async () => {
        ok = await result.current.referencePassage(PASSAGE)
      })
      expect(ok).toBe(true)
      expect(mockBuildExcerpt).toHaveBeenCalledWith({
        sessionId: "s1",
        messageIds: ["m1"],
        text: PASSAGE.text,
        excerpt: { derivation: "quote", quote: PASSAGE.text },
      })
      expect(staged()).toHaveLength(1)
      expect(toastSuccess).toHaveBeenCalledWith(
        copy.referenced.replace("{title}", "user: the lockfile…")
      )
    })

    it("says so, and stages nothing, when the message cannot be read", async () => {
      mockBuildExcerpt.mockResolvedValue(null)
      const { result } = setup()
      await act(async () => {
        await expect(result.current.referencePassage(PASSAGE)).resolves.toBe(false)
      })
      mockBuildExcerpt.mockRejectedValue(new Error("db closed"))
      await act(async () => {
        await expect(result.current.referencePassage(PASSAGE)).resolves.toBe(false)
      })
      expect(staged()).toHaveLength(0)
      expect(toastError).toHaveBeenCalledTimes(2)
      expect(toastError).toHaveBeenCalledWith(copy.referenceError)
    })
  })

  describe("start", () => {
    it("asks about the passage with the messages around it as context", () => {
      const { result } = setup()
      act(() => result.current.start("explain", PASSAGE))
      expect(mockBegin).toHaveBeenCalledWith({
        action: "explain",
        quote: PASSAGE.text,
        sessionId: "s1",
        messageIds: ["m1"],
        context: "whole reply",
      })
    })

    it("translates into the chosen language, remembered for next time", () => {
      const { result } = setup()
      act(() => result.current.start("translate", PASSAGE))
      expect(mockBegin.mock.calls[0]![0]).toMatchObject({ targetLocale: "en" })

      act(() => result.current.chooseLocale("ja"))
      expect(result.current.targetLocale).toBe("ja")
      expect(mockSetPref).toHaveBeenCalledWith("selectionToolbar.translateLocale", "ja")
      act(() => result.current.start("translate", PASSAGE))
      expect(mockBegin.mock.calls[1]![0]).toMatchObject({ targetLocale: "ja" })

      // A one-off choice for this run does not need to be the remembered one.
      act(() => result.current.start("translate", PASSAGE, "fr"))
      expect(mockBegin.mock.calls[2]![0]).toMatchObject({ targetLocale: "fr" })
    })

    it("ignores a language it does not offer", () => {
      const { result } = setup()
      act(() => result.current.chooseLocale("tlh"))
      expect(result.current.targetLocale).toBe("en")
      expect(mockSetPref).not.toHaveBeenCalled()
    })

    // One preference for every surface that translates a selection.
    it("starts from the language the desktop selection toolbar remembered", async () => {
      mockSavedLocale = "ko"
      const { result } = setup()
      await waitFor(() => expect(result.current.targetLocale).toBe("ko"))
    })
  })

  describe("referenceResult", () => {
    const request = (over: Partial<SelectionRunRequest> = {}): SelectionRunRequest => ({
      action: "summarize",
      quote: PASSAGE.text,
      sessionId: "s1",
      messageIds: ["m1", "m2"],
      context: "",
      ...over,
    })

    it("stages the answer as what it is, with the passage it came from", async () => {
      mockRunState = {
        status: "done",
        request: request({ action: "translate", targetLocale: "ja" }),
        text: "訳",
        parts: 1,
      }
      mockBuildExcerpt.mockResolvedValue(chip("t"))
      const { result } = setup()
      await act(async () => {
        await expect(result.current.referenceResult("訳")).resolves.toBe(true)
      })
      expect(mockBuildExcerpt).toHaveBeenCalledWith({
        sessionId: "s1",
        messageIds: ["m1", "m2"],
        text: "訳",
        excerpt: { derivation: "translation", quote: PASSAGE.text, language: "ja" },
      })
      expect(mockClose).toHaveBeenCalled()
    })

    it("does nothing with no answer showing", async () => {
      const { result } = setup()
      await act(async () => {
        await expect(result.current.referenceResult("x")).resolves.toBe(false)
      })
      expect(mockBuildExcerpt).not.toHaveBeenCalled()
    })

    it("keeps the answer open when it cannot be staged", async () => {
      mockRunState = { status: "done", request: request(), text: "sum", parts: 1 }
      mockBuildExcerpt.mockResolvedValue(null)
      const { result } = setup()
      await act(async () => {
        await expect(result.current.referenceResult("sum")).resolves.toBe(false)
      })
      expect(mockClose).not.toHaveBeenCalled()
      expect(toastError).toHaveBeenCalledWith(copy.referenceError)
    })
  })

  it("retries the run on screen with the same request", () => {
    const failed: SelectionRunRequest = {
      action: "summarize",
      quote: PASSAGE.text,
      sessionId: "s1",
      messageIds: ["m1"],
      context: PASSAGE.context,
    }
    mockRunState = { status: "failed", request: failed, text: "", message: "timeout" }
    const { result } = setup()
    act(() => result.current.retry())
    expect(mockBegin).toHaveBeenCalledWith(failed)
  })

  it("names a language in the UI's words, and leaves an unknown tag as it is", () => {
    const { result } = setup()
    expect(result.current.languageLabel("ja")).toBe("Japanese")
    expect(result.current.languageLabel("tlh")).toBe("tlh")
    expect(result.current.languageLabel(undefined)).toBeUndefined()
  })
})
