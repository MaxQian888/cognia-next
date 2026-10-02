import { renderHook } from "@testing-library/react"

import type { CodeServerBrokerIssueEvent } from "@/lib/codeserver/client"

const unlisten = jest.fn()
let subscribed: string[] = []
let handlers: ((payload: CodeServerBrokerIssueEvent) => void)[] = []
jest.mock("@/lib/tauri/events", () => ({
  onTauriEvent: (name: string, handler: (payload: CodeServerBrokerIssueEvent) => void) => {
    subscribed.push(name)
    handlers.push(handler)
    return Promise.resolve(unlisten)
  },
}))
jest.mock("@/lib/tauri/safe-unlisten", () => ({
  safeUnlisten: (fn: (() => void) | null) => fn?.(),
}))

import { useCodeServerBrokerIssues } from "./use-code-server-broker-issues"

const emit = (event: CodeServerBrokerIssueEvent) => {
  for (const handler of handlers) handler(event)
}

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
}

beforeEach(() => {
  subscribed = []
  handlers = []
  unlisten.mockClear()
})

it("reports an issue for its own workspace, ignoring trailing slashes", async () => {
  const onEvent = jest.fn()
  renderHook(() => useCodeServerBrokerIssues(true, "/work/proj", onEvent))
  await flush()
  expect(subscribed).toEqual(["codeserver://broker-issue"])

  emit({ root: "/work/proj/", issue: "credential-replayed" })
  expect(onEvent).toHaveBeenCalledWith({ root: "/work/proj/", issue: "credential-replayed" })
})

it("ignores another workspace's issue", async () => {
  const onEvent = jest.fn()
  renderHook(() => useCodeServerBrokerIssues(true, "/work/proj", onEvent))
  await flush()
  emit({ root: "/work/other", issue: "install-failed" })
  expect(onEvent).not.toHaveBeenCalled()
})

it("does not subscribe while disabled and unsubscribes on unmount", async () => {
  const onEvent = jest.fn()
  const { rerender, unmount } = renderHook(
    ({ enabled }) => useCodeServerBrokerIssues(enabled, "/work/proj", onEvent),
    { initialProps: { enabled: false } }
  )
  await flush()
  expect(subscribed).toEqual([])

  rerender({ enabled: true })
  await flush()
  expect(subscribed).toHaveLength(1)
  unmount()
  expect(unlisten).toHaveBeenCalledTimes(1)
})

it("uses the latest callback without resubscribing", async () => {
  const first = jest.fn()
  const second = jest.fn()
  const { rerender } = renderHook(
    ({ onEvent }) => useCodeServerBrokerIssues(true, "/work/proj", onEvent),
    { initialProps: { onEvent: first } }
  )
  await flush()
  rerender({ onEvent: second })
  await flush()
  emit({ root: "/work/proj", issue: "credential-replayed" })
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledTimes(1)
  expect(subscribed).toHaveLength(1)
})
