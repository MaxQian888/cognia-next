/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"

import type { TodoEntry } from "@/lib/chat/todos"
import { upsertRunRecord, type RunRecordRow } from "@/lib/db/run-records"
import { getDb } from "@/lib/db/schema"

import { summarizeRunProgress, useSessionRunProgress } from "./use-session-run-progress"

const todo = (content: string, status: TodoEntry["status"]): TodoEntry => ({ content, status })

function record(sessionId: string, runId: number, startedAt: number, todos: TodoEntry[]) {
  return {
    sessionId,
    runId,
    startedAt,
    status: "done",
    tools: [],
    subagents: [],
    todos,
    todoCounts: { done: 0, total: todos.length },
    counts: { tools: 0, subagents: 0 },
  } as RunRecordRow
}

// The first `getDb()` opens the database and runs the schema once (slow).
beforeEach(async () => {
  await getDb().runRecords.clear()
}, 30_000)

describe("summarizeRunProgress", () => {
  it("prefers the step in progress as the current one", () => {
    const progress = summarizeRunProgress([
      todo("a", "completed"),
      todo("b", "pending"),
      todo("c", "in_progress"),
    ])
    expect(progress).toMatchObject({ done: 1, total: 3, current: { content: "c" } })
  })

  it("falls back to the next pending step, then to none", () => {
    expect(summarizeRunProgress([todo("a", "completed"), todo("b", "pending")]).current).toEqual(
      todo("b", "pending")
    )
    expect(summarizeRunProgress([todo("a", "completed")]).current).toBeNull()
    expect(summarizeRunProgress([])).toEqual({ todos: [], done: 0, total: 0, current: null })
  })
})

describe("useSessionRunProgress", () => {
  it("reads the newest run record of the session", async () => {
    await upsertRunRecord(record("s1", 1, 100, [todo("old", "pending")]))
    await upsertRunRecord(
      record("s1", 2, 200, [todo("shipped", "completed"), todo("now", "in_progress")])
    )
    await upsertRunRecord(record("s2", 3, 300, [todo("other", "pending")]))

    const { result } = renderHook(() => useSessionRunProgress("s1"))

    await waitFor(() => expect(result.current.total).toBe(2))
    expect(result.current.done).toBe(1)
    expect(result.current.current?.content).toBe("now")
  })

  it("is empty for a session with no runs", () => {
    const { result } = renderHook(() => useSessionRunProgress("none"))
    expect(result.current.total).toBe(0)
  })
})
