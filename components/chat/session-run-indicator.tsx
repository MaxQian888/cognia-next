"use client"

/**
 * A conversation's live turn state as one small glyph on its list row.
 *
 * Shared by the desktop sidebar row and the mobile drawer row, so both lists
 * say "replying", "waiting for your approval" and "the last turn failed" the
 * same way. Idle draws nothing.
 *
 * Each glyph is a named image (`role="img"`), not a live region: a list can
 * hold many running rows, and a `status` region per row would make a screen
 * reader announce every one of them on each list render. The name is read as
 * part of the row's button, which is where the reader meets it. The spinner is
 * drawn directly rather than through `Spinner`, whose accessible name is
 * exactly such a live region.
 */

import { Spinner } from "@/components/ui/spinner"
import { CircleAlertIcon, ShieldQuestionIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import type { ChatStatus } from "@/stores/chat/chat-store"
import { cn } from "@/lib/utils"

export interface SessionRunIndicatorProps {
  status: ChatStatus
  /** Test id stem; the state is appended (`<stem>-streaming`, `-awaiting`, `-error`). */
  testIdPrefix: string
  className?: string
}

export function SessionRunIndicator({ status, testIdPrefix, className }: SessionRunIndicatorProps) {
  const t = useTranslations("chat.sessionRun")
  if (status === "streaming") {
    return (
      <Spinner
        role="img"
        label={t("streaming")}
        className={cn("size-3 shrink-0 text-muted-foreground", className)}
        data-testid={`${testIdPrefix}-streaming`}
      />
    )
  }
  if (status === "awaiting_approval") {
    return (
      <ShieldQuestionIcon
        role="img"
        aria-label={t("awaitingApproval")}
        className={cn("size-3 shrink-0 text-amber-600", className)}
        data-testid={`${testIdPrefix}-awaiting`}
      />
    )
  }
  if (status === "error") {
    return (
      <CircleAlertIcon
        role="img"
        aria-label={t("error")}
        className={cn("size-3 shrink-0 text-destructive", className)}
        data-testid={`${testIdPrefix}-error`}
      />
    )
  }
  return null
}
