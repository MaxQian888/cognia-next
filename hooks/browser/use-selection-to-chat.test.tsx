import { renderHook } from "@testing-library/react"

import type { BrowserSelection } from "@/lib/browser/protocol"

const mockSend = jest.fn().mockResolvedValue(undefined)
const mockInterrupt = jest.fn().mockResolvedValue(undefined)
/** Swapped to null by the "no provider" cases below. */
let mockRuntime: { send: typeof mockSend; interruptAndSteer: typeof mockInterrupt } | null = {
  send: mockSend,
  interruptAndSteer: mockInterrupt,
}
const mockCapture = jest.fn()
const mockSaveAnnotation = jest.fn().mockResolvedValue(undefined)
const mockTransitionAnnotation = jest.fn().mockResolvedValue(true)
let mockStoreState: {
  activeSessionId: string | null
  sessions: Record<string, { status: string }>
}

jest.mock("@/hooks/chat/use-claude-chat", () => ({
  // The hook reads the runtime OPTIONALLY, so that surfaces which merely
  // construct it outside a provider (the artifacts dock body, Storybook) still
  // render. Returning null here is what the "no provider" cases assert on.
  useOptionalClaudeChat: () => mockRuntime,
  useClaudeChat: () => mockRuntime,
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
jest.mock("@/lib/db/browser-annotations", () => ({
  saveBrowserAnnotation: (...args: unknown[]) => mockSaveAnnotation(...args),
  transitionBrowserAnnotation: (...args: unknown[]) => mockTransitionAnnotation(...args),
  // Used by the batch formatter to headline the batch by surface. Mirrors the
  // real normalisation: a row with no target is the web annotation it was.
  resolveAnnotationTarget: (row: { target?: unknown; baseUrl?: string }) =>
    row.target ?? { kind: "web", baseUrl: row.baseUrl ?? "" },
}))

import { buildSendContent } from "@/lib/chat/attachments/dispatch"
import { useSelectionToChat } from "./use-selection-to-chat"

const mockBuild = buildSendContent as jest.Mock

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
  mockSaveAnnotation.mockClear().mockResolvedValue(undefined)
  mockTransitionAnnotation.mockClear().mockResolvedValue(true)
  mockStoreState = { activeSessionId: "s1", sessions: { s1: { status: "idle" } } }
})

it("queues a durable annotation and sends a batch with one screenshot", async () => {
  mockStoreState.sessions.s1.status = "streaming"
  const { result } = renderHook(() => useSelectionToChat())
  const annotation = await result.current.queueAnnotation(SELECTION, "fix contrast", {
    baseUrl: "http://localhost:3000",
  })
  expect(mockSaveAnnotation).toHaveBeenCalledWith(
    expect.objectContaining({ comment: "fix contrast", status: "pending", sessionId: "s1" })
  )
  const ok = await result.current.sendAnnotations([annotation!], {
    captureRect: { x: 0, y: 0, width: 100, height: 100 },
  })
  expect(ok).toBe(true)
  expect(mockCapture).toHaveBeenCalledTimes(1)
  expect(mockInterrupt).toHaveBeenCalledWith("s1")
  expect(mockSend).toHaveBeenCalledTimes(1)
  expect(mockTransitionAnnotation).toHaveBeenCalledWith(
    annotation!.id,
    "acknowledged",
    expect.any(Number)
  )
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

describe("sendScreenshot", () => {
  const RECT = { x: 0, y: 0, width: 100, height: 100 }

  it("captures the rect and sends an image + context line", async () => {
    const { result } = renderHook(() => useSelectionToChat())
    const ok = await result.current.sendScreenshot(RECT, { pageUrl: "http://localhost:3000/" })
    expect(ok).toBe(true)
    expect(mockCapture).toHaveBeenCalledWith(RECT)
    const [content, opts, callOpts] = mockSend.mock.calls[0]
    expect(Array.isArray(content)).toBe(true) // image + text blocks
    expect(opts).toBeUndefined()
    expect(callOpts).toEqual({ sessionId: "s1" })
  })

  it("returns false when no session is available", async () => {
    mockStoreState = { activeSessionId: null, sessions: {} }
    const { result } = renderHook(() => useSelectionToChat())
    const ok = await result.current.sendScreenshot(RECT)
    expect(ok).toBe(false)
    expect(mockCapture).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it("interrupts a streaming session before sending", async () => {
    mockStoreState.sessions.s1.status = "streaming"
    const { result } = renderHook(() => useSelectionToChat())
    await result.current.sendScreenshot(RECT)
    expect(mockInterrupt).toHaveBeenCalledWith("s1")
    expect(mockSend).toHaveBeenCalled()
  })

  it("targets an explicit session id over the active one", async () => {
    const { result } = renderHook(() => useSelectionToChat())
    await result.current.sendScreenshot(RECT, { sessionId: "other" })
    expect(mockSend.mock.calls[0][2]).toEqual({ sessionId: "other" })
  })

  it("sends bytes captured by a host-neutral browser engine without recapturing", async () => {
    const { result } = renderHook(() => useSelectionToChat())
    const ok = await result.current.sendScreenshotBytes("REMOTE_PNG", {
      pageUrl: "https://example.com/",
    })

    expect(ok).toBe(true)
    expect(mockCapture).not.toHaveBeenCalled()
    expect(mockBuild).toHaveBeenCalledWith(
      "Screenshot of the in-app browser preview at https://example.com/.",
      [expect.objectContaining({ url: "data:image/png;base64,REMOTE_PNG" })]
    )
  })

  it("throws when the capture yields no image", async () => {
    mockCapture.mockResolvedValueOnce({ bytes: "", width: 0, height: 0 })
    const { result } = renderHook(() => useSelectionToChat())
    await expect(result.current.sendScreenshot(RECT)).rejects.toThrow("no image")
    expect(mockSend).not.toHaveBeenCalled()
  })
})

describe("sendText", () => {
  it("builds text-only content and sends it to the active session", async () => {
    const { result } = renderHook(() => useSelectionToChat())
    const ok = await result.current.sendText("replay the login flow")
    expect(ok).toBe(true)
    // No files — the recorded-flow export is a prompt, never an image.
    expect(mockBuild).toHaveBeenCalledWith("replay the login flow", [])
    const [content, opts, callOpts] = mockSend.mock.calls[0]
    expect(content).toBe("replay the login flow") // no image blocks
    expect(opts).toBeUndefined()
    expect(callOpts).toEqual({ sessionId: "s1" })
    expect(mockCapture).not.toHaveBeenCalled()
  })

  it("no-ops on empty text", async () => {
    const { result } = renderHook(() => useSelectionToChat())
    expect(await result.current.sendText("")).toBe(false)
    expect(mockBuild).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it("no-ops on whitespace-only text", async () => {
    const { result } = renderHook(() => useSelectionToChat())
    expect(await result.current.sendText("  \n\t ")).toBe(false)
    expect(mockBuild).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  // Unlike sendComment, which throws — a missing session is a normal outcome
  // here, so the caller gets a false rather than an exception.
  it("returns false when there is no session and none was given", async () => {
    mockStoreState = { activeSessionId: null, sessions: {} }
    const { result } = renderHook(() => useSelectionToChat())
    expect(await result.current.sendText("go")).toBe(false)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it("targets an explicit session id over the active one", async () => {
    const { result } = renderHook(() => useSelectionToChat())
    const ok = await result.current.sendText("go", { sessionId: "other" })
    expect(ok).toBe(true)
    expect(mockSend.mock.calls[0][2]).toEqual({ sessionId: "other" })
  })

  it("sends to an explicit session even when none is active", async () => {
    mockStoreState = { activeSessionId: null, sessions: {} }
    const { result } = renderHook(() => useSelectionToChat())
    expect(await result.current.sendText("go", { sessionId: "other" })).toBe(true)
    expect(mockSend.mock.calls[0][2]).toEqual({ sessionId: "other" })
  })

  // The documented contract vs sendComment: the interrupt exists only because
  // the steer queue drops image blocks. Text has none, so a mid-turn send must
  // ride the steer queue instead of tearing down the live turn.
  it("does not interrupt a streaming session — enqueuing text mid-turn is intended", async () => {
    mockStoreState.sessions.s1.status = "streaming"
    const { result } = renderHook(() => useSelectionToChat())
    const ok = await result.current.sendText("go")
    expect(ok).toBe(true)
    expect(mockInterrupt).not.toHaveBeenCalled()
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it("does not interrupt a session awaiting approval either", async () => {
    mockStoreState.sessions.s1.status = "awaiting_approval"
    const { result } = renderHook(() => useSelectionToChat())
    await result.current.sendText("go")
    expect(mockInterrupt).not.toHaveBeenCalled()
    expect(mockSend).toHaveBeenCalledTimes(1)
  })
})

describe("without a chat runtime provider", () => {
  afterEach(() => {
    mockRuntime = { send: mockSend, interruptAndSteer: mockInterrupt }
  })

  it("constructs, so a surface outside the provider still renders", () => {
    mockRuntime = null
    // The artifacts dock body builds this hook and is itself rendered in
    // Storybook and in unit tests, where no runtime is mounted. Throwing on
    // construction would make those surfaces unrenderable.
    expect(() => renderHook(() => useSelectionToChat())).not.toThrow()
  })

  it("refuses loudly instead of reporting a send that never happened", async () => {
    mockRuntime = null
    const { result } = renderHook(() => useSelectionToChat())
    await expect(result.current.sendText("hello")).rejects.toThrow(/ClaudeChatRuntimeProvider/)
    expect(mockSend).not.toHaveBeenCalled()
  })
})

describe("queueing against a non-web target", () => {
  it("records an artifact target and writes no baseUrl", async () => {
    // An artifact element was never on a page, so inventing a `baseUrl` for it
    // would put a fictitious URL in the row and then in the model's prompt.
    const { result } = renderHook(() => useSelectionToChat())
    await result.current.queueAnnotation(
      {
        selector: "#card > button",
        domPath: "div.card > button",
        tagName: "button",
        id: null,
        classes: null,
        rect: { x: 0, y: 0, width: 1, height: 1 },
        outerHTML: "<button></button>",
        text: "Go",
      },
      "make it blue",
      { sessionId: "s1", target: { kind: "artifact", artifactId: "a1" }, intent: "fix" }
    )

    const written = mockSaveAnnotation.mock.calls.at(-1)?.[0]
    expect(written.target).toEqual({ kind: "artifact", artifactId: "a1" })
    expect(written).not.toHaveProperty("baseUrl")
    expect(written.intent).toBe("fix")
  })

  it("still accepts a plain baseUrl, so the browser call sites are unchanged", async () => {
    const { result } = renderHook(() => useSelectionToChat())
    await result.current.queueAnnotation(SELECTION, "tighten", {
      sessionId: "s1",
      baseUrl: "https://example.test",
    })
    const written = mockSaveAnnotation.mock.calls.at(-1)?.[0]
    expect(written.baseUrl).toBe("https://example.test")
    expect(written.target).toEqual({ kind: "web", baseUrl: "https://example.test" })
  })
})
