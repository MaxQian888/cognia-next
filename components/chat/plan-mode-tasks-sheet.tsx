"use client"

// Chat-header trigger that surfaces plan-mode todos for a non-team chat
// session. Reads the durable run-record's todo snapshot (the single source
// shared with the Run Panel's Plan section) so the list survives reload — the
// older in-memory `solo:<sessionId>` synthetic team was wiped on refresh.

import { useTranslations } from "next-intl"
import { ListTodoIcon } from "lucide-react"
import { useLiveQuery } from "dexie-react-hooks"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { TodoList } from "@/components/chat/todo-list"
import { getLatestRunRecord } from "@/lib/db/run-records"
import type { TodoEntry } from "@/lib/chat/todos"

export interface PlanModeTasksSheetProps {
  /** Active chat session id. */
  sessionId: string
  className?: string
}

const NO_TODOS: TodoEntry[] = []

export function PlanModeTasksSheet({ sessionId, className }: PlanModeTasksSheetProps) {
  const t = useTranslations("planModeTasks")
  // Live-read the latest persisted run record's todo snapshot; updates as the
  // run-record persistence hook writes new snapshots.
  const record = useLiveQuery(() => getLatestRunRecord(sessionId), [sessionId])
  const todos = record?.todos ?? NO_TODOS

  if (todos.length === 0) return null

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={className}
          data-testid="plan-mode-tasks-trigger"
          aria-label={t("triggerLabel", { count: todos.length })}
        >
          <ListTodoIcon className="mr-1.5 size-4" />
          <span className="text-xs">{t("triggerText", { count: todos.length })}</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("headerTitle")}</SheetTitle>
          <SheetDescription>{t("headerDescription")}</SheetDescription>
        </SheetHeader>
        <div className="mt-4 px-4 pb-4">
          <TodoList todos={todos} defaultOpen />
        </div>
      </SheetContent>
    </Sheet>
  )
}

export default PlanModeTasksSheet
