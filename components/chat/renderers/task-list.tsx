"use client"

import { memo, useCallback } from "react"
import { Circle, CheckCircle2, Square, SquareCheck } from "lucide-react"
import { cn } from "@/lib/utils"
import { Progress } from "@/components/ui/progress"

interface TaskItem {
  id: string
  text: React.ReactNode
  checked: boolean
  children?: TaskItem[]
}

interface TaskListProps {
  items: TaskItem[]
  className?: string
  interactive?: boolean
  onToggle?: (id: string, checked: boolean) => void
  showProgress?: boolean
  variant?: "checkbox" | "circle"
}

export const TaskList = memo(function TaskList({
  items,
  className,
  interactive = false,
  onToggle,
  showProgress = false,
  variant = "checkbox",
}: TaskListProps) {
  const handleToggle = useCallback(
    (id: string, currentChecked: boolean) => {
      if (interactive && onToggle) {
        onToggle(id, !currentChecked)
      }
    },
    [interactive, onToggle]
  )

  const flatItems = flattenItems(items)
  const completedCount = flatItems.filter((item) => item.checked).length
  const totalCount = flatItems.length
  const progress = totalCount > 0 ? (completedCount / totalCount) * 100 : 0

  return (
    <div className={cn("my-4", className)}>
      {showProgress && totalCount > 0 && (
        <div className="mb-3 space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Progress</span>
            <span>
              {completedCount} / {totalCount} ({Math.round(progress)}%)
            </span>
          </div>
          <Progress value={progress} className="h-1.5" />
        </div>
      )}
      <TaskListInner
        items={items}
        interactive={interactive}
        onToggle={handleToggle}
        variant={variant}
        depth={0}
      />
    </div>
  )
})

interface TaskListInnerProps {
  items: TaskItem[]
  interactive: boolean
  onToggle: (id: string, checked: boolean) => void
  variant: "checkbox" | "circle"
  depth: number
}

const TaskListInner = memo(function TaskListInner({
  items,
  interactive,
  onToggle,
  variant,
  depth,
}: TaskListInnerProps) {
  return (
    <ul className={cn("space-y-1", depth > 0 && "ml-6 mt-1")}>
      {items.map((item) => (
        <li key={item.id} className="group">
          <div
            className={cn(
              "flex items-start gap-2 py-0.5",
              interactive && "cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1",
              item.checked && "text-muted-foreground"
            )}
            onClick={() => onToggle(item.id, item.checked)}
            role={interactive ? "checkbox" : undefined}
            aria-checked={interactive ? item.checked : undefined}
          >
            <TaskCheckbox checked={item.checked} variant={variant} interactive={interactive} />
            <span
              className={cn(
                "flex-1 text-sm leading-relaxed",
                item.checked && "line-through decoration-muted-foreground/50"
              )}
            >
              {item.text}
            </span>
          </div>
          {item.children && item.children.length > 0 && (
            <TaskListInner
              items={item.children}
              interactive={interactive}
              onToggle={onToggle}
              variant={variant}
              depth={depth + 1}
            />
          )}
        </li>
      ))}
    </ul>
  )
})

interface TaskCheckboxProps {
  checked: boolean
  variant: "checkbox" | "circle"
  interactive: boolean
}

const TaskCheckbox = memo(function TaskCheckbox({
  checked,
  variant,
  interactive,
}: TaskCheckboxProps) {
  if (variant === "circle") {
    if (checked) {
      return <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-green-500" />
    }
    return (
      <Circle
        className={cn(
          "h-4 w-4 mt-0.5 shrink-0 text-muted-foreground/50",
          interactive && "group-hover:text-muted-foreground"
        )}
      />
    )
  }

  if (checked) {
    return <SquareCheck className="h-4 w-4 mt-0.5 shrink-0 text-green-500" />
  }
  return (
    <Square
      className={cn(
        "h-4 w-4 mt-0.5 shrink-0 text-muted-foreground/50",
        interactive && "group-hover:text-muted-foreground"
      )}
    />
  )
})

function flattenItems(items: TaskItem[]): TaskItem[] {
  const result: TaskItem[] = []
  for (const item of items) {
    result.push(item)
    if (item.children) {
      result.push(...flattenItems(item.children))
    }
  }
  return result
}

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

export default TaskList
