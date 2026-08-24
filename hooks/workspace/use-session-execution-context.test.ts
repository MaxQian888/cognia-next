/** @jest-environment jsdom */

const get = jest.fn()
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ sessions: { get } }) }))

const useClientLiveQuery = jest.fn()
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (query: () => unknown, deps: unknown[], initial: unknown) =>
    useClientLiveQuery(query, deps, initial),
}))

import { renderHook } from "@testing-library/react"

import { useSessionExecutionContext } from "./use-session-execution-context"

/**
 * Render the hook and hand back the query it registered, so the database
 * branch is actually exercised rather than only the wiring.
 */
function capturedQuery(sessionId: string | null | undefined): () => Promise<unknown> {
  let captured: (() => Promise<unknown>) | undefined
  useClientLiveQuery.mockImplementation((query: () => Promise<unknown>) => {
    captured = query
    return undefined
  })
  renderHook(() => useSessionExecutionContext(sessionId))
  return captured!
}

beforeEach(() => {
  get.mockReset()
  useClientLiveQuery.mockReset()
})

it("reads the named conversation's binding", async () => {
  get.mockResolvedValue({ executionContext: { projectRoot: "/repos/app" } })
  await expect(capturedQuery("s1")()).resolves.toEqual({ projectRoot: "/repos/app" })
  expect(get).toHaveBeenCalledWith("s1")
})

it("resolves null for no conversation instead of guessing the focused one", async () => {
  // In split view there are two focused-ish conversations; a panel that means
  // one of them has to say which.
  await expect(capturedQuery(null)()).resolves.toBeNull()
  expect(get).not.toHaveBeenCalled()
})

it("resolves null for a conversation with no binding yet", async () => {
  get.mockResolvedValue({ id: "s1" })
  await expect(capturedQuery("s1")()).resolves.toBeNull()
})

it("resolves null rather than throwing when the database is unavailable", async () => {
  get.mockRejectedValue(new Error("db closed"))
  await expect(capturedQuery("s1")()).resolves.toBeNull()
})

it("re-reads when the conversation changes", () => {
  useClientLiveQuery.mockReturnValue(null)
  renderHook(() => useSessionExecutionContext("s1"))
  expect(useClientLiveQuery).toHaveBeenLastCalledWith(expect.any(Function), ["s1"], null)
})

it("normalizes the pre-hydration undefined to null", () => {
  // A live query is undefined before its first result; a panel reading a
  // tri-state here would treat "not loaded" as a real answer.
  useClientLiveQuery.mockReturnValue(undefined)
  const { result } = renderHook(() => useSessionExecutionContext("s1"))
  expect(result.current).toBeNull()
})
