import { act, renderHook } from "@testing-library/react"

const status = jest.fn()
jest.mock("@/lib/codeserver/client", () => ({
  CODESERVER_EVENTS: {
    brokerIssue: "codeserver://broker-issue",
    editorEvent: "codeserver://editor-event",
  },
  codeServerClient: { status: (root: string) => status(root) },
}))

const unlisten = jest.fn()
let handlers: Record<string, ((payload: unknown) => void)[]> = {}
jest.mock("@/lib/tauri/events", () => ({
  onTauriEvent: (name: string, handler: (payload: unknown) => void) => {
    ;(handlers[name] ??= []).push(handler)
    return Promise.resolve(unlisten)
  },
}))
jest.mock("@/lib/tauri/safe-unlisten", () => ({
  safeUnlisten: (fn: (() => void) | null) => fn?.(),
}))

import {
  BROKER_STATUS_STARTUP_POLL_MS,
  useCodeServerBrokerStatus,
} from "./use-code-server-broker-status"

const emit = (name: string, payload: unknown) =>
  act(async () => {
    for (const handler of handlers[name] ?? []) handler(payload)
    for (let i = 0; i < 4; i += 1) await Promise.resolve()
  })

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
  })

const running = (broker?: unknown) => ({ running: true, port: 1, version: "x", broker })

beforeEach(() => {
  handlers = {}
  status.mockReset()
  unlisten.mockClear()
})

afterEach(() => jest.useRealTimers())

it("reports why the broker is off for a running managed workbench", async () => {
  status.mockResolvedValue(running({ enabled: false, reason: "admin-disabled" }))
  const { result } = renderHook(() => useCodeServerBrokerStatus(true, "/w"))
  await flush()
  expect(status).toHaveBeenCalledWith("/w")
  expect(result.current).toEqual({ enabled: false, reason: "admin-disabled" })
})

it("asks again while the workbench is still starting, and stops once it runs", async () => {
  jest.useFakeTimers()
  status
    .mockResolvedValueOnce({ running: false, port: null, version: "x" })
    .mockResolvedValue(running({ enabled: true }))
  const { result } = renderHook(() => useCodeServerBrokerStatus(true, "/w"))
  await flush()
  expect(result.current).toBeNull()
  await act(async () => {
    jest.advanceTimersByTime(BROKER_STATUS_STARTUP_POLL_MS)
  })
  await flush()
  expect(result.current).toEqual({ enabled: true })
  await act(async () => {
    jest.advanceTimersByTime(BROKER_STATUS_STARTUP_POLL_MS * 3)
  })
  expect(status).toHaveBeenCalledTimes(2)
})

it("re-reads when an issue is recorded or the extension connects for its own root", async () => {
  status.mockResolvedValue(running({ enabled: true }))
  const { result } = renderHook(() => useCodeServerBrokerStatus(true, "/w"))
  await flush()

  status.mockResolvedValue(running({ enabled: false, reason: "protocol-incompatible" }))
  await emit("codeserver://broker-issue", { root: "/other", issue: "install-failed" })
  expect(status).toHaveBeenCalledTimes(1)
  await emit("codeserver://broker-issue", { root: "/w/", issue: "protocol-incompatible" })
  expect(result.current).toEqual({ enabled: false, reason: "protocol-incompatible" })

  status.mockResolvedValue(running({ enabled: true }))
  await emit("codeserver://editor-event", { root: "/w", name: "activeEditorChanged" })
  expect(status).toHaveBeenCalledTimes(2)
  await emit("codeserver://editor-event", { root: "/w", name: "bridgeConnected" })
  expect(result.current).toEqual({ enabled: true })
})

it("reports nothing for the native profile's missing broker field", async () => {
  status.mockResolvedValue(running(undefined))
  const { result } = renderHook(() => useCodeServerBrokerStatus(true, "/w"))
  await flush()
  expect(result.current).toBeNull()
})

it("stays idle while disabled and unsubscribes on unmount", async () => {
  const { rerender, unmount } = renderHook(
    ({ enabled }) => useCodeServerBrokerStatus(enabled, "/w"),
    { initialProps: { enabled: false } }
  )
  await flush()
  expect(status).not.toHaveBeenCalled()
  status.mockResolvedValue(running({ enabled: true }))
  rerender({ enabled: true })
  await flush()
  unmount()
  expect(unlisten).toHaveBeenCalledTimes(2)
})
