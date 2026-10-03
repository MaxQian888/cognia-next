"use client"

/**
 * The latest run's todo list and where it stands.
 *
 * Read from the persisted run record (`TodoWrite` snapshots, written with a
 * short debounce by `use-run-record-persistence`), which is what the plan-mode
 * tasks sheet showed. The summary card and that sheet now share this hook.
 */

import { useLiveQuery } from "dexie-react-hooks"

import { countCompletedTodos, type TodoEntry } from "@/lib/chat/todos"
import { getLatestRunRecord } from "@/lib/db/run-records"

export interface SessionRunProgress {
  todos: TodoEntry[]
  done: number
  total: number
  /** The step in progress, else the next pending one; null when all are done. */
  current: TodoEntry | null
}

const NO_TODOS: TodoEntry[] = []

/** Pure projection, exported for the card's tests. */
export function summarizeRunProgress(todos: readonly TodoEntry[]): SessionRunProgress {
  const current =
    todos.find((todo) => todo.status === "in_progress") ??
    todos.find((todo) => todo.status === "pending") ??
    null
  return { todos: [...todos], done: countCompletedTodos(todos), total: todos.length, current }
}

export function useSessionRunProgress(sessionId: string): SessionRunProgress {
  const record = useLiveQuery(() => getLatestRunRecord(sessionId), [sessionId])
  return summarizeRunProgress(record?.todos ?? NO_TODOS)
}
