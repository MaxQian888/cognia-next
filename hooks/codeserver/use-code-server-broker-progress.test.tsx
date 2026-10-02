import { act, renderHook } from "@testing-library/react"

import type { CodeServerEditorEvent } from "@/lib/codeserver/client"

const unlisten = jest.fn()
let subscribed: string[] = []
let handlers: ((payload: CodeServerEditorEvent) => void)[] = []
jest.mock("@/lib/tauri/events", () => ({
  onTauriEvent: (name: string, handler: (payload: CodeServerEditorEvent) => void) => {
    subscribed.push(name)
    handlers.push(handler)
    return Promise.resolve(unlisten)
  },
}))
jest.mock("@/lib/tauri/safe-unlisten", () => ({
  safeUnlisten: (fn: (() => void) | null) => fn?.(),
}))

import { STALE_PROGRESS_MS, useCodeServerBrokerProgress } from "./use-code-server-broker-progress"

const emit = (event: Omit<CodeServerEditorEvent, "payload"> & { payload: unknown }) =>
  act(() => {
    for (const handler of handlers) handler(event as CodeServerEditorEvent)
  })

const progress = (token: number, value: Record<string, unknown>, root = "/work/proj") =>
  emit({ root, name: "brokerProgress", payload: { token, value } })

const flush = () =>
  act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve()
  })

beforeEach(() => {
  subscribed = []
  handlers = []
  unlisten.mockClear()
})

afterEach(() => {
  jest.useRealTimers()
})

it("tracks an operation from begin through reports to end", async () => {
  const { result } = renderHook(() => useCodeServerBrokerProgress(true, "/work/proj"))
  await flush()
  expect(subscribed).toEqual(["codeserver://editor-event"])

  progress(4, { kind: "begin", operation: "saveAll", total: 3 })
  expect(result.current).toEqual([{ kind: "begin", operation: "saveAll", total: 3 }])

  progress(4, { kind: "report", operation: "saveAll", done: 2, total: 3, percentage: 67 })
  expect(result.current).toEqual([
    { kind: "report", operation: "saveAll", done: 2, total: 3, percentage: 67 },
  ])

  progress(4, { kind: "end", operation: "saveAll", total: 3 })
  expect(result.current).toEqual([])
})

it("lists concurrent operations most recent first", async () => {
  jest.useFakeTimers({ now: 1_000 })
  const { result } = renderHook(() => useCodeServerBrokerProgress(true, "/work/proj"))
  await flush()
  progress(1, { kind: "begin", operation: "applyEdit", path: "/work/proj/a.ts" })
  jest.setSystemTime(2_000)
  progress(2, { kind: "begin", operation: "managedProxyHandshake", pluginId: "acme.tools" })
  expect(result.current.map((v) => v.operation)).toEqual(["managedProxyHandshake", "applyEdit"])
})

it("ignores other workspaces, other events and malformed payloads", async () => {
  const { result } = renderHook(() => useCodeServerBrokerProgress(true, "/work/proj/"))
  await flush()
  progress(1, { kind: "begin", operation: "saveAll" }, "/work/other")
  emit({ root: "/work/proj", name: "activeEditorChanged", payload: { path: "/x" } })
  emit({ root: "/work/proj", name: "brokerProgress", payload: null })
  emit({ root: "/work/proj", name: "brokerProgress", payload: { token: 1 } })
  expect(result.current).toEqual([])
})

it("drops an operation whose end never arrived once the host deadline has certainly passed", async () => {
  jest.useFakeTimers()
  const { result } = renderHook(() => useCodeServerBrokerProgress(true, "/work/proj"))
  await flush()
  progress(1, { kind: "begin", operation: "saveAll" })
  act(() => {
    jest.advanceTimersByTime(STALE_PROGRESS_MS - 1)
  })
  // A report renews the window.
  progress(1, { kind: "report", operation: "saveAll", percentage: 50 })
  act(() => {
    jest.advanceTimersByTime(STALE_PROGRESS_MS - 1)
  })
  expect(result.current).toHaveLength(1)
  act(() => {
    jest.advanceTimersByTime(1)
  })
  expect(result.current).toEqual([])
})

it("forgets everything when the extension reconnects", async () => {
  const { result } = renderHook(() => useCodeServerBrokerProgress(true, "/work/proj"))
  await flush()
  progress(1, { kind: "begin", operation: "saveAll" })
  emit({ root: "/work/proj", name: "bridgeConnected", payload: null })
  expect(result.current).toEqual([])
})

it("does not subscribe while disabled, and clears on disable and unmount", async () => {
  const { result, rerender, unmount } = renderHook(
    ({ enabled }) => useCodeServerBrokerProgress(enabled, "/work/proj"),
    { initialProps: { enabled: false } }
  )
  await flush()
  expect(subscribed).toEqual([])

  rerender({ enabled: true })
  await flush()
  progress(1, { kind: "begin", operation: "saveAll" })
  expect(result.current).toHaveLength(1)

  rerender({ enabled: false })
  expect(result.current).toEqual([])
  expect(unlisten).toHaveBeenCalledTimes(1)
  unmount()
})
