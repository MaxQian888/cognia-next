"use client"

/**
 * The status bar's run-state readout — a coloured dot plus the current turn
 * state (idle / streaming / awaiting approval / error).
 *
 * Lives in its own module for two reasons. It is a customizable status-bar
 * segment (`runStatus` in `@/types/shell/bars`), so the zone renderer needs to
 * mount it by id like every other segment; and it subscribes to
 * `useChatStore(s => s.status)`, which changes per streamed token — keeping
 * that subscription in a leaf means a streaming turn re-renders this span
 * instead of the whole bar.
 */

import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat/chat-store"

type RunStatus = "idle" | "streaming" | "awaiting_approval" | "error"

export function StatusBarRunState() {
  const t = useTranslations("desktop.statusBar")
  const status = useChatStore((s) => s.status)
  const label = statusLabelFor(status, t)

  return (
    <button
      type="button"
      data-testid="status-status"
      aria-label={label}
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
