"use client"

/**
 * `<TodoList>` — the structured checklist rendered from Claude's `TodoWrite`
 * tool snapshot. Extracted from the transcript renderer so the same list is
 * reused by the Run Panel's Plan section, keeping a single visual treatment for
 * plan progress wherever it appears.
 */
import { CheckCircle2Icon, CircleIcon, ClockIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Task, TaskContent, TaskItem, TaskTrigger } from "@/components/ai-elements/task"
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
  const completed = countCompletedTodos(todos)
  return (
    <Task defaultOpen={defaultOpen} className={cn("not-prose mb-2 w-full", className)}>
      <TaskTrigger title={t("todoPlanTitle", { done: completed, total: todos.length })} />
      <TaskContent>
        {todos.map((todo, i) => (
          <TaskItem
            key={i}
            className={cn(
              "flex items-start gap-2",
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
      </TaskContent>
    </Task>
  )
}
