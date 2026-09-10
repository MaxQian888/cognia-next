/**
 * @jest-environment jsdom
 */
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let issuesValue: unknown[] = []
let plansValue: unknown[] = []
let runsValue: unknown[] = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (fn: () => unknown) => {
    const src = fn.toString()
    if (src.includes("listAllPlans")) return plansValue
    if (src.includes("listIssueRuns")) return runsValue
    return issuesValue
  },
}))
jest.mock("@/lib/db/issues", () => ({ listIssues: jest.fn() }))
jest.mock("@/lib/db/plans", () => ({ listAllPlans: jest.fn() }))
jest.mock("@/lib/db/issue-runs", () => ({ listIssueRuns: jest.fn() }))

const push = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: { pushWorkspaceSnapshot: (...a: unknown[]) => push(...a) },
}))

import { act, renderHook } from "@testing-library/react"
import { useCodeServerWorkspaceSync } from "./use-code-server-workspace-sync"

const issue = (over: Record<string, unknown> = {}) => ({
  id: "i1",
  identifier: "MERC-1",
  title: "Ship the board",
  description: "",
  status: "todo",
  updatedAt: 5,
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  issuesValue = [issue()]
  plansValue = []
  runsValue = []
})

it("pushes a snapshot once the pane is ready", () => {
  renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
  expect(push).toHaveBeenCalledTimes(1)
  const [root, snapshot] = push.mock.calls[0]!
  expect(root).toBe("/repo")
  expect(snapshot.groups.map((g: { id: string }) => g.id)).toEqual(["issues", "plans", "runs"])
})

it("stays silent until the workbench is ready", () => {
  // Pushing before the companion extension has dialled back just fails.
  renderHook(() => useCodeServerWorkspaceSync(false, "/repo"))
  expect(push).not.toHaveBeenCalled()
})

it("does not re-push an identical snapshot", async () => {
  // The live queries re-fire on any write to the tables they touched, including
  // ones that change nothing this panel shows.
  const { rerender } = renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
  await act(async () => {})
  rerender()
  rerender()
  expect(push).toHaveBeenCalledTimes(1)
})

it("pushes again when the work actually changes", () => {
  const { rerender } = renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
  issuesValue = [issue({ title: "Ship the board differently" })]
  rerender()
  expect(push).toHaveBeenCalledTimes(2)
})

it("carries a file target recovered from the issue text", () => {
  issuesValue = [issue({ title: "crash in lib/a.ts:42" })]
  renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
  const [, snapshot] = push.mock.calls[0]!
  expect(snapshot.groups[0].rows[0]).toMatchObject({ path: "lib/a.ts", line: 42 })
})

it("retries after a failed push instead of latching the deduper", () => {
  // Otherwise a push that failed while the workbench was booting would suppress
  // every identical snapshot afterwards, leaving the panel permanently empty.
  push.mockRejectedValueOnce(new Error("no extension connected"))
  const { rerender } = renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
  return Promise.resolve().then(() => {
    rerender()
    expect(push).toHaveBeenCalledTimes(2)
  })
})

it("sends the same data to a newly selected workspace", () => {
  const { rerender } = renderHook(({ root }) => useCodeServerWorkspaceSync(true, root), {
    initialProps: { root: "/first" },
  })
  rerender({ root: "/second" })
  expect(push).toHaveBeenLastCalledWith("/second", expect.any(Object))
})

it("retries extension startup without a data change and cancels on unmount", async () => {
  jest.useFakeTimers()
  try {
    push.mockRejectedValueOnce(new Error("extension starting"))
    const { unmount } = renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_000)
    })
    expect(push).toHaveBeenCalledTimes(2)
    unmount()
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000)
    })
    expect(push).toHaveBeenCalledTimes(2)
  } finally {
    jest.useRealTimers()
  }
})
