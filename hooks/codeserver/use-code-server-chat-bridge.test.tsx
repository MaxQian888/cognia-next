import { renderHook } from "@testing-library/react"

import type { CodeServerEditorEvent } from "@/lib/codeserver/client"

let mockIsTauri = true

jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri }))

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))

// Resolved against the real catalogue rather than stubbed to the key, so the
// prompt assertions below pin BOTH that the key exists and the text the user
// ends up with in their composer.
jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => {
    const messages = jest.requireActual("@/i18n/messages/en/projectEditor.json")
    return [...namespace.split(".").slice(1), ...key.split(".")].reduce(
      (node: Record<string, unknown> | undefined, part: string) =>
        node?.[part] as Record<string, unknown> | undefined,
      messages as Record<string, unknown>
    )
  },
}))

const mockStartNewSession = jest.fn().mockResolvedValue({ id: "new-session-123" })
jest.mock("@/lib/chat/start-session", () => ({
  startNewSession: () => mockStartNewSession(),
}))

const unlisten = jest.fn()
let handlers: ((payload: CodeServerEditorEvent) => void)[] = []
jest.mock("@/lib/tauri/events", () => ({
  onTauriEvent: (_name: string, handler: (payload: CodeServerEditorEvent) => void) => {
    handlers.push(handler)
    return Promise.resolve(unlisten)
  },
}))
jest.mock("@/lib/tauri/safe-unlisten", () => ({
  safeUnlisten: (fn: (() => void) | null) => fn?.(),
}))

// Minimal zustand mocks for the chat stores
const addContextSelection = jest.fn()
const mockChatState = {
  activeSessionId: "session-1",
  contextSelections: [] as Array<{ kind: string; relPath?: string; range?: unknown }>,
  addContextSelection,
}
jest.mock("@/stores/chat", () => ({
  useChatStore: Object.assign(() => mockChatState, { getState: () => mockChatState }),
}))

const stage = jest.fn()
jest.mock("@/stores/chat/composer-intent-store", () => ({
  useComposerIntentStore: Object.assign(() => ({ stage }), { getState: () => ({ stage }) }),
}))

import { useCodeServerChatBridge } from "./use-code-server-chat-bridge"
import type { ChatContextPayload } from "./use-code-server-chat-bridge"

function makeChatEvent(payload: Partial<ChatContextPayload> = {}): CodeServerEditorEvent {
  return {
    root: "/work/proj",
    name: "chatContextRequested",
    payload: {
      action: "addSelection",
      path: "/work/proj/src/index.ts",
      relativePath: "src/index.ts",
      language: "typescript",
      selection: { startLine: 10, startColumn: 1, endLine: 15, endColumn: 20 },
      selectedText: "const x = 1;",
      truncated: false,
      diagnostics: [],
      ...payload,
    } as unknown as CodeServerEditorEvent["payload"],
  }
}

const emit = (event: CodeServerEditorEvent) => {
  for (const handler of handlers) handler(event)
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

beforeEach(() => {
  mockIsTauri = true
  handlers = []
  unlisten.mockClear()
  addContextSelection.mockClear()
  stage.mockClear()
  mockStartNewSession.mockClear()
  mockChatState.activeSessionId = "session-1"
  mockChatState.contextSelections = []
  push.mockClear()
})

it("stages a FileSelectionRef when chatContextRequested event fires", async () => {
  renderHook(() => useCodeServerChatBridge(true, "/work/proj"))
  await flush()

  emit(makeChatEvent())
  await flush()

  expect(addContextSelection).toHaveBeenCalledTimes(1)
  expect(addContextSelection).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "file",
      relPath: "src/index.ts",
      title: "src/index.ts",
      snapshot: "const x = 1;",
      comment: "",
      range: { startLine: 10, endLine: 15 },
    })
  )
})

it("stages a composer intent with the explain prompt", async () => {
  renderHook(() => useCodeServerChatBridge(true, "/work/proj"))
  await flush()

  emit(makeChatEvent({ action: "explain" }))
  await flush()

  expect(stage).toHaveBeenCalledTimes(1)
  expect(stage).toHaveBeenCalledWith(
    "session-1",
    expect.objectContaining({
      prompt: "Please explain this code.",
    })
  )
})

it("stages a composer intent with the fix prompt", async () => {
  renderHook(() => useCodeServerChatBridge(true, "/work/proj"))
  await flush()

  emit(makeChatEvent({ action: "fix" }))
  await flush()

  expect(stage).toHaveBeenCalledWith(
    "session-1",
    expect.objectContaining({
      prompt: "Please fix the issues in this code.",
    })
  )
})

it("stages a composer intent with the review prompt", async () => {
  renderHook(() => useCodeServerChatBridge(true, "/work/proj"))
  await flush()

  emit(makeChatEvent({ action: "review" }))
  await flush()

  expect(stage).toHaveBeenCalledWith(
    "session-1",
    expect.objectContaining({
      prompt: "Please review this code for potential bugs and improvements.",
    })
  )
})

it("stages null prompt for addSelection (context-only, no pre-fill)", async () => {
  renderHook(() => useCodeServerChatBridge(true, "/work/proj"))
  await flush()

  emit(makeChatEvent({ action: "addSelection" }))
  await flush()

  expect(stage).toHaveBeenCalledWith("session-1", expect.objectContaining({ prompt: null }))
})

it("stages null prompt for addFile (context-only, no pre-fill)", async () => {
  renderHook(() => useCodeServerChatBridge(true, "/work/proj"))
  await flush()

  emit(makeChatEvent({ action: "addFile", selection: null, selectedText: null }))
  await flush()

  expect(addContextSelection).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "file",
      relPath: "src/index.ts",
      snapshot: "",
      range: undefined,
    })
  )
  expect(stage).toHaveBeenCalledWith("session-1", expect.objectContaining({ prompt: null }))
})

it("interpolates ${selection} in custom action prompts", async () => {
  renderHook(() => useCodeServerChatBridge(true, "/work/proj"))
  await flush()

  emit(
    makeChatEvent({
      action: "custom",
      customPrompt: "Translate this to Python: ${selection}",
      customLabel: "To Python",
      selectedText: "const x = 1;",
    })
  )
  await flush()

  expect(stage).toHaveBeenCalledWith(
    "session-1",
    expect.objectContaining({
      prompt: "Translate this to Python: const x = 1;",
    })
  )
})

it("deduplicates staging when the same file+range is already staged", async () => {
  mockChatState.contextSelections = [
    {
      kind: "file",
      relPath: "src/index.ts",
      range: { startLine: 10, endLine: 15 },
    },
  ]

  renderHook(() => useCodeServerChatBridge(true, "/work/proj"))
  await flush()

  emit(makeChatEvent())
  await flush()

  expect(addContextSelection).not.toHaveBeenCalled()
  // Intent is still staged even when deduped — the user triggered an action
  expect(stage).toHaveBeenCalledTimes(1)
})

it("ignores events from another project's pane when root is specified", async () => {
  renderHook(() => useCodeServerChatBridge(true, "/work/proj"))
  await flush()

  emit({ ...makeChatEvent(), root: "/work/other" })
  await flush()

  expect(addContextSelection).not.toHaveBeenCalled()
  expect(stage).not.toHaveBeenCalled()
})

it("accepts events from any root when none is specified", async () => {
  renderHook(() => useCodeServerChatBridge(true))
  await flush()

  emit({ ...makeChatEvent(), root: "/work/anything" })
  await flush()

  expect(addContextSelection).toHaveBeenCalledTimes(1)
})

it("does not subscribe while disabled", async () => {
  renderHook(() => useCodeServerChatBridge(false, "/work/proj"))
  await flush()

  expect(handlers).toHaveLength(0)
})

it("does not subscribe outside the desktop shell", async () => {
  mockIsTauri = false
  renderHook(() => useCodeServerChatBridge(true, "/work/proj"))
  await flush()

  expect(handlers).toHaveLength(0)
})

it("unsubscribes on unmount", async () => {
  const { unmount } = renderHook(() => useCodeServerChatBridge(true, "/work/proj"))
  await flush()

  unmount()

  expect(unlisten).toHaveBeenCalled()
})

it("ignores non-chatContextRequested events", async () => {
  renderHook(() => useCodeServerChatBridge(true, "/work/proj"))
  await flush()

  emit({
    root: "/work/proj",
    name: "activeEditorChanged",
    payload: { path: "/work/proj/a.ts" },
  })
  await flush()

  expect(addContextSelection).not.toHaveBeenCalled()
})

it("creates a new session when none is active", async () => {
  mockChatState.activeSessionId = null as unknown as string
  renderHook(() => useCodeServerChatBridge(true, "/work/proj"))
  await flush()

  emit(makeChatEvent())
  await flush()

  expect(mockStartNewSession).toHaveBeenCalledTimes(1)
  expect(stage).toHaveBeenCalledWith("new-session-123", expect.anything())
})

it("routes to the composer after staging", async () => {
  // Only the composer mounted for this session consumes a staged intent, and one
  // Pro IDE host is the Agent Team workspace Editor tab — a route with no
  // composer. Without the push, "Add to Chat" staged into a surface the user
  // could not see.
  renderHook(() => useCodeServerChatBridge(true, "/work/proj"))
  await flush()

  emit(makeChatEvent({ action: "explain" }))
  await flush()

  expect(stage).toHaveBeenCalledTimes(1)
  expect(push).toHaveBeenCalledWith("/")
})

it("does not route for an event belonging to another project's pane", async () => {
  renderHook(() => useCodeServerChatBridge(true, "/work/proj"))
  await flush()

  emit({ ...makeChatEvent(), root: "/work/other" })
  await flush()

  expect(stage).not.toHaveBeenCalled()
  expect(push).not.toHaveBeenCalled()
})

it("does not route after the hook has been torn down", async () => {
  const { unmount } = renderHook(() => useCodeServerChatBridge(true, "/work/proj"))
  await flush()

  const [handler] = handlers
  unmount()
  handler(makeChatEvent({ action: "explain" }))
  await flush()

  expect(push).not.toHaveBeenCalled()
})
