import { renderHook } from "@testing-library/react"

import type { CodeServerEditorEvent } from "@/lib/codeserver/client"

let mockIsTauri = true

jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri }))

const notifyActiveEditorChanged = jest.fn()
jest.mock("@/lib/files/project-editor-bridge", () => ({
  notifyActiveEditorChanged: () => notifyActiveEditorChanged(),
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

import { useCodeServerEditorEvents } from "./use-code-server-editor-events"

const emit = (event: Partial<CodeServerEditorEvent>) => {
  const payload = {
    root: "/work/proj",
    name: "activeEditorChanged",
    payload: null,
    ...event,
  } as CodeServerEditorEvent
  for (const handler of handlers) handler(payload)
}

/** Let the mocked `onTauriEvent` promise settle so the listener is registered. */
const flush = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
}

beforeEach(() => {
  mockIsTauri = true
  handlers = []
  unlisten.mockClear()
  notifyActiveEditorChanged.mockClear()
})

it("republishes a pushed editor change as the app's active-editor signal", async () => {
  renderHook(() => useCodeServerEditorEvents(true, "/work/proj"))
  await flush()

  emit({ name: "activeEditorChanged", payload: { path: "/work/proj/a.ts" } })

  expect(notifyActiveEditorChanged).toHaveBeenCalledTimes(1)
})

it("republishes every event kind that changes what the user is looking at", async () => {
  renderHook(() => useCodeServerEditorEvents(true, "/work/proj"))
  await flush()

  for (const name of [
    "activeEditorChanged",
    "selectionChanged",
    // A save changes both diagnostics and dirty state, both of which the
    // active-editor snapshot reports.
    "documentSaved",
    "diagnosticsChanged",
  ] as const) {
    emit({ name })
  }

  expect(notifyActiveEditorChanged).toHaveBeenCalledTimes(4)
})

it("ignores an event name it does not know", async () => {
  // A newer extension pushing something this build doesn't handle must not turn
  // into a spurious re-read of every subscriber.
  renderHook(() => useCodeServerEditorEvents(true, "/work/proj"))
  await flush()

  emit({ name: "somethingElse" as CodeServerEditorEvent["name"] })

  expect(notifyActiveEditorChanged).not.toHaveBeenCalled()
})

it("ignores events from another project's pane", async () => {
  // Two panes can be mounted; one project's cursor moving is not a reason to
  // re-read the other's.
  renderHook(() => useCodeServerEditorEvents(true, "/work/proj"))
  await flush()

  emit({ root: "/work/other" })

  expect(notifyActiveEditorChanged).not.toHaveBeenCalled()
})

it("accepts events from any root when none is specified", async () => {
  renderHook(() => useCodeServerEditorEvents(true))
  await flush()

  emit({ root: "/work/anything" })

  expect(notifyActiveEditorChanged).toHaveBeenCalledTimes(1)
})

it("does not subscribe while disabled", async () => {
  renderHook(() => useCodeServerEditorEvents(false, "/work/proj"))
  await flush()

  expect(handlers).toHaveLength(0)
})

it("does not subscribe outside the desktop shell", async () => {
  mockIsTauri = false
  renderHook(() => useCodeServerEditorEvents(true, "/work/proj"))
  await flush()

  expect(handlers).toHaveLength(0)
})

it("unsubscribes on unmount", async () => {
  const { unmount } = renderHook(() => useCodeServerEditorEvents(true, "/work/proj"))
  await flush()

  unmount()

  expect(unlisten).toHaveBeenCalled()
})

it("drops a late listener registration after unmount", async () => {
  // `onTauriEvent` resolves asynchronously; unmounting first must not leave a
  // listener attached to a dead component.
  const { unmount } = renderHook(() => useCodeServerEditorEvents(true, "/work/proj"))
  unmount()
  await flush()

  expect(unlisten).toHaveBeenCalled()
  emit({})
  expect(notifyActiveEditorChanged).not.toHaveBeenCalled()
})
