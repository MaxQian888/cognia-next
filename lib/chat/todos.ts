/**
 * Pure parsing for Claude's `TodoWrite` tool payload — shared by the transcript
 * renderer (`<TodoList>`) and the run-record aggregator. No React, no I/O, so
 * the snapshot semantics are unit tested in isolation.
 */

/** One todo item from a `TodoWrite` snapshot. */
export interface TodoEntry {
  content: string
  status: "pending" | "in_progress" | "completed"
  activeForm?: string
}

/**
 * Parse a `TodoWrite` tool input into a todo list, or `null` when the payload
 * is missing/empty/malformed (caller then falls through to generic rendering).
 * `TodoWrite` is authoritative full-snapshot: each call carries the complete
 * list, so a later snapshot fully replaces an earlier one.
 */
export function parseTodoInput(input: unknown): TodoEntry[] | null {
  if (!input || typeof input !== "object") return null
  const todos = (input as { todos?: unknown }).todos
  if (!Array.isArray(todos) || todos.length === 0) return null
  const out: TodoEntry[] = []
  for (const t of todos) {
    if (!t || typeof t !== "object") return null
    const content = (t as { content?: unknown }).content
    const status = (t as { status?: unknown }).status
    const activeForm = (t as { activeForm?: unknown }).activeForm
    if (typeof content !== "string") return null
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return null
    out.push({
      content,
      status,
      activeForm: typeof activeForm === "string" ? activeForm : undefined,
    })
  }
  return out
}

/** Count of completed todos in a snapshot. */
export function countCompletedTodos(todos: readonly TodoEntry[]): number {
  return todos.filter((t) => t.status === "completed").length
}
