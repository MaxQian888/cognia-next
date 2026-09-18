"use client"

/**
 * `<TodoList>` — the structured checklist rendered from Claude's `TodoWrite`
 * tool snapshot. Extracted from the transcript renderer so the same list is
 * reused by the Run Panel's Plan section, keeping a single visual treatment for
 * plan progress wherever it appears.
 */
import { useState } from "react"
import { CheckCircle2Icon, CircleIcon, ClockIcon, ListChecksIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { TaskItem } from "@/components/ai-elements/task"
import { ToolRowShell, type ToolDotStatus } from "@/components/chat/message-parts/tool-row"
import { cn } from "@/lib/utils"
import { countCompletedTodos, type TodoEntry } from "@/lib/chat/todos"

function TodoStatusGlyph({ status }: { status: TodoEntry["status"] }) {
  if (status === "completed") {
    return <CheckCircle2Icon className="size-3.5 shrink-0 text-green-600" />
  }
  if (status === "in_progress") {
    return <ClockIcon className="size-3.5 shrink-0 animate-pulse text-yellow-600" />
  }
  return <CircleIcon className="size-3.5 shrink-0 text-muted-foreground" />
}

export interface TodoListProps {
  todos: readonly TodoEntry[]
  /** Whether the collapsible opens by default (transcript: true). */
  defaultOpen?: boolean
  className?: string
}

export function TodoList({ todos, defaultOpen = true, className }: TodoListProps) {
  const t = useTranslations("chat.message")
  const [open, setOpen] = useState(defaultOpen)
  const completed = countCompletedTodos(todos)
  const title = t("todoPlanTitle", { done: completed, total: todos.length })
  // The plan snapshot is an activity row like the tool calls around it: the
  // dot breathes while any item is in progress and settles green once all are
  // done; the checklist expands under the left rule.
  const status: ToolDotStatus =
    completed === todos.length
      ? "complete"
      : todos.some((todo) => todo.status === "in_progress")
        ? "running"
        : "pending"
  return (
    <ToolRowShell
      className={cn("mb-2 w-full", className)}
      status={status}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      ariaLabel={title}
      testId="todo-list"
      lead={<span className="shrink-0 text-xs font-medium text-foreground/80">{title}</span>}
      icon={<ListChecksIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
      target={<span className="flex-1" />}
    >
      <div className="mb-1 space-y-1.5 border-l pl-3 pt-1">
        {todos.map((todo, i) => (
          <TaskItem
            key={i}
            className={cn(
              "flex items-start gap-2 text-xs",
              todo.status === "completed" && "text-muted-foreground line-through",
              todo.status === "in_progress" && "text-foreground"
            )}
          >
            <TodoStatusGlyph status={todo.status} />
            <span className="min-w-0 flex-1 break-words">
              {todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content}
            </span>
          </TaskItem>
        ))}
      </div>
    </ToolRowShell>
  )
}
