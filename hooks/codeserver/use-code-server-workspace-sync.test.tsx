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

import { renderHook } from "@testing-library/react"
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

it("does not re-push an identical snapshot", () => {
  // The live queries re-fire on any write to the tables they touched, including
  // ones that change nothing this panel shows.
  const { rerender } = renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
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
