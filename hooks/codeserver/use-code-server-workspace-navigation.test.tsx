import { renderHook } from "@testing-library/react"

import type { CodeServerEditorEvent } from "@/lib/codeserver/client"

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))
jest.mock("@/lib/db/plans", () => ({ getPlan: jest.fn() }))
jest.mock("@/lib/db/issue-runs", () => ({ getIssueRun: jest.fn() }))

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

import { useCodeServerWorkspaceNavigation } from "./use-code-server-workspace-navigation"

const deps = {
  getPlan: async (id: string) => (id === "p1" ? { sessionId: "s1" } : undefined),
  getIssueRun: async (id: string) => (id === "r1" ? { issueId: "i1" } : undefined),
}

const emit = (event: Omit<Partial<CodeServerEditorEvent>, "payload"> & { payload: unknown }) => {
  for (const handler of handlers) {
    handler({
      root: "/work/proj",
      name: "workspaceRowActivated",
      ...event,
    } as CodeServerEditorEvent)
  }
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

beforeEach(() => {
  handlers = []
  push.mockClear()
  toastError.mockClear()
  unlisten.mockClear()
})

it("opens the plan's chat session when its row is clicked", async () => {
  renderHook(() => useCodeServerWorkspaceNavigation(true, "/work/proj", deps))
  await flush()
  emit({ payload: { id: "plan:p1", label: "Refactor" } })
  await flush()
  expect(push).toHaveBeenCalledWith("/?session=s1")
})

it("opens the issue a run is working", async () => {
  renderHook(() => useCodeServerWorkspaceNavigation(true, "/work/proj", deps))
  await flush()
  emit({ payload: { id: "run:r1", label: "agent-team" } })
  await flush()
  expect(push).toHaveBeenCalledWith("/issues?id=i1")
})

it("says so when the row's record is gone instead of navigating nowhere", async () => {
  renderHook(() => useCodeServerWorkspaceNavigation(true, "/work/proj", deps))
  await flush()
  emit({ payload: { id: "plan:gone", label: "Old plan" } })
  await flush()
  expect(push).not.toHaveBeenCalled()
  expect(toastError).toHaveBeenCalledWith('workspaceRowMissing:{"label":"Old plan"}')
})

it("ignores other roots, other events and a disabled hook", async () => {
  const { rerender } = renderHook(
    ({ enabled }) => useCodeServerWorkspaceNavigation(enabled, "/work/proj", deps),
    { initialProps: { enabled: false } }
  )
  await flush()
  expect(handlers).toHaveLength(0)
  rerender({ enabled: true })
  await flush()
  emit({ root: "/work/other", payload: { id: "issue:1", label: "x" } })
  emit({ name: "activeEditorChanged", payload: { id: "issue:1", label: "x" } })
  await flush()
  expect(push).not.toHaveBeenCalled()
})
