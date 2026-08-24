"use client"

/**
 * The status bar's run-state readout — a coloured dot plus the current turn
 * state (idle / streaming / awaiting approval / error).
 *
 * Lives in its own module for two reasons. It is a customizable status-bar
 * segment (`runStatus` in `@/types/shell/bars`), so the zone renderer needs to
 * mount it by id like every other segment; and it subscribes to the chat
 * store's session map, which changes per streamed token — keeping that
 * subscription in a leaf means a streaming turn re-renders this span instead
 * of the whole bar.
 *
 * It reads the AGGREGATE state, not `useChatStore(s => s.status)`. That field
 * is the focused slice projected onto the store top level, so with two
 * background turns in flight and a quiet conversation on screen the status bar
 * said "Idle" — the one readout in the shell whose entire job is to answer
 * "is anything happening". The count appears once more than one conversation
 * is running, because "Responding…" is equally true of one and of five.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { aggregateRunState } from "@/lib/chat/aggregate-run-state"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat/chat-store"

type RunStatus = "idle" | "streaming" | "awaiting_approval" | "error"

export function StatusBarRunState() {
  const t = useTranslations("desktop.statusBar")
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const run = useMemo(
    () => aggregateRunState({ sessions, activeSessionId }),
    [sessions, activeSessionId]
  )
  const status = run.status
  const label =
    run.active > 1 ? t("runningCount", { count: run.active }) : statusLabelFor(status, t)

  return (
    <button
      type="button"
      data-testid="status-status"
      aria-label={label}
      data-run-active={run.active}
      data-run-elsewhere={run.activeElsewhere ? "true" : "false"}
      // Not interactive: no `onClick`, so it is taken out of the tab order
      // rather than presenting itself as something to press.
      tabIndex={-1}
      className="flex h-6 shrink-0 cursor-default items-center gap-1.5 px-2 text-muted-foreground transition-colors"
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          status === "streaming" && "animate-pulse bg-primary",
          status === "awaiting_approval" && "bg-amber-500",
          status === "error" && "bg-destructive",
          status === "idle" && "bg-muted-foreground/50"
        )}
      />
      <span>{label}</span>
    </button>
  )
}

function statusLabelFor(status: RunStatus, t: (key: string) => string): string {
  switch (status) {
    case "streaming":
      return t("streaming")
    case "awaiting_approval":
      return t("awaitingApproval")
    case "error":
      return t("error")
    default:
      return t("idle")
  }
}
