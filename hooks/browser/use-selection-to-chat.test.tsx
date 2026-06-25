import { renderHook } from "@testing-library/react"

import type { BrowserSelection } from "@/lib/browser/protocol"

const mockSend = jest.fn().mockResolvedValue(undefined)
const mockInterrupt = jest.fn().mockResolvedValue(undefined)
const mockCapture = jest.fn()
let mockStoreState: {
  activeSessionId: string | null
  sessions: Record<string, { status: string }>
}

jest.mock("@/hooks/chat/use-claude-chat", () => ({
  useClaudeChat: () => ({ send: mockSend, interruptAndSteer: mockInterrupt }),
}))
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: { getState: () => mockStoreState },
}))
jest.mock("@/lib/browser/client", () => ({
  // Lazy read so the factory doesn't touch `mockCapture` before its
  // initialization (eager reads TDZ under coverage instrumentation).
  browserClient: { embedCapture: (...args: unknown[]) => mockCapture(...args) },
}))
jest.mock("@/lib/chat/attachments/dispatch", () => ({
  buildSendContent: jest.fn(async (text: string, files: unknown[]) => ({
    content: files.length ? [{ type: "image" }, { type: "text", text }] : text,
    rejected: [],
    tokens: 0,
  })),
}))

import { useSelectionToChat } from "./use-selection-to-chat"

const SELECTION: BrowserSelection = {
  paneId: "browser-pane",
  selector: "#go",
  domPath: "button#go",
  tagName: "button",
  id: "go",
  classes: null,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  outerHTML: '<button id="go"></button>',
  text: "Go",
  pageUrl: "http://localhost:3000/",
  pageTitle: "Home",
}

beforeEach(() => {
  mockSend.mockClear().mockResolvedValue(undefined)
  mockInterrupt.mockClear().mockResolvedValue(undefined)
  mockCapture.mockReset().mockResolvedValue({ bytes: "AAAA", width: 10, height: 10 })
  mockStoreState = { activeSessionId: "s1", sessions: { s1: { status: "idle" } } }
})

it("sends a comment with screenshot to the active session when idle", async () => {
  const { result } = renderHook(() => useSelectionToChat())
  const ok = await result.current.sendComment(SELECTION, "make it blue", {
    captureRect: { x: 0, y: 0, width: 100, height: 100 },
  })
  expect(ok).toBe(true)
  expect(mockCapture).toHaveBeenCalledWith({ x: 0, y: 0, width: 100, height: 100 })
  expect(mockInterrupt).not.toHaveBeenCalled()
  const [content, opts, callOpts] = mockSend.mock.calls[0]
  expect(Array.isArray(content)).toBe(true) // image + text blocks
  expect(opts).toBeUndefined()
  expect(callOpts).toEqual({ sessionId: "s1" })
})

it("interrupts before sending when the session is streaming", async () => {
  mockStoreState.sessions.s1.status = "streaming"
  const { result } = renderHook(() => useSelectionToChat())
  await result.current.sendComment(SELECTION, "tweak")
  expect(mockInterrupt).toHaveBeenCalledWith("s1")
  expect(mockSend).toHaveBeenCalled()
})

it("still sends (text-only) when the screenshot fails", async () => {
  mockCapture.mockRejectedValueOnce(new Error("no window"))
  const { result } = renderHook(() => useSelectionToChat())
  await result.current.sendComment(SELECTION, "fix", {
    captureRect: { x: 0, y: 0, width: 10, height: 10 },
  })
  const [content] = mockSend.mock.calls[0]
  expect(typeof content).toBe("string") // no image block
})

it("can skip the screenshot explicitly", async () => {
  const { result } = renderHook(() => useSelectionToChat())
  await result.current.sendComment(SELECTION, "fix", {
    includeScreenshot: false,
    captureRect: { x: 0, y: 0, width: 10, height: 10 },
  })
  expect(mockCapture).not.toHaveBeenCalled()
})

it("sends text-only when no captureRect is available", async () => {
  const { result } = renderHook(() => useSelectionToChat())
  await result.current.sendComment(SELECTION, "fix")
  expect(mockCapture).not.toHaveBeenCalled()
  expect(typeof mockSend.mock.calls[0][0]).toBe("string")
})

it("targets an explicit session id over the active one", async () => {
  const { result } = renderHook(() => useSelectionToChat())
  await result.current.sendComment(SELECTION, "fix", { sessionId: "other" })
  expect(mockSend.mock.calls[0][2]).toEqual({ sessionId: "other" })
})

it("no-ops on an empty comment", async () => {
  const { result } = renderHook(() => useSelectionToChat())
  const ok = await result.current.sendComment(SELECTION, "   ")
  expect(ok).toBe(false)
  expect(mockSend).not.toHaveBeenCalled()
})

it("throws when there is no session", async () => {
  mockStoreState = { activeSessionId: null, sessions: {} }
  const { result } = renderHook(() => useSelectionToChat())
  await expect(result.current.sendComment(SELECTION, "fix")).rejects.toThrow(
    "No active chat session"
  )
})
