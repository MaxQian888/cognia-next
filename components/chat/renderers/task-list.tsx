"use client"

/**
 * `<TaskListItem>` — one GFM task-list row (`- [ ] …`) inside rendered
 * markdown. `components/chat/markdown/shared-components.tsx` swaps it in for
 * the `li` react-markdown would otherwise emit, so the checkbox is a glyph that
 * matches the rest of chat instead of a raw disabled `<input>`.
 *
 * It is deliberately display-only. The checklist the model *drives* is
 * `TodoWrite`, and that has its own renderer — `components/chat/todo-list.tsx`
 * — which owns collapsing, status vocabulary and the run-panel/plan-sheet
 * embeddings. A markdown checkbox is prose: nothing on the other end would
 * receive a toggle.
 *
 * (This file used to also export a `TaskList` that rendered a nested,
 * optionally interactive checklist with a progress bar. Nothing ever mounted
 * it — `shared-components.tsx` only ever imported `TaskListItem` — so its
 * `interactive` / `onToggle` / `showProgress` / `variant` options were
 * unreachable, and its click target was a `div[role=checkbox]` with no
 * `tabIndex` and no key handler, i.e. keyboard-inoperable. It was a second,
 * worse `TodoList`; it was removed rather than wired.)
 */

import { memo } from "react"
import { Square, SquareCheck } from "lucide-react"
import { cn } from "@/lib/utils"

interface TaskListItemProps {
  checked: boolean
  children: React.ReactNode
  className?: string
}

export const TaskListItem = memo(function TaskListItem({
  checked,
  children,
  className,
}: TaskListItemProps) {
  return (
    <li className={cn("flex items-start gap-2 list-none", className)}>
      {checked ? (
        <SquareCheck className="h-4 w-4 mt-0.5 shrink-0 text-green-500" />
      ) : (
        <Square className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground/50" />
      )}
      <span
        className={cn(
          "flex-1",
          checked && "line-through text-muted-foreground decoration-muted-foreground/50"
        )}
      >
        {children}
      </span>
    </li>
  )
})
