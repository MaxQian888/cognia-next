"use client"

/**
 * Conversation lifecycle status control (CRM, schema v83). A compact chip that
 * shows the current status (colored dot + label) and, on click, lets the
 * operator move the conversation to open / pending / snoozed (with a duration)
 * / resolved. Writes via setStatus, which records the transition on the
 * assignment-event trail. Works in any shell — status is local Dexie state.
 */

import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { setStatus, type ConversationStatus } from "@/lib/db/conversation-overrides"

const STATUS_DOT: Record<ConversationStatus, string> = {
  open: "bg-emerald-500",
  pending: "bg-amber-500",
  snoozed: "bg-sky-500",
  resolved: "bg-muted-foreground",
}

const SNOOZE_OPTIONS: ReadonlyArray<{ key: "1h" | "8h" | "24h"; ms: number }> = [
  { key: "1h", ms: 60 * 60 * 1000 },
  { key: "8h", ms: 8 * 60 * 60 * 1000 },
  { key: "24h", ms: 24 * 60 * 60 * 1000 },
]

export interface LifecycleStatusChipProps {
  conversationKey: string
  sessionId: string
  status: ConversationStatus
}

export function LifecycleStatusChip({
  conversationKey,
  sessionId,
  status,
}: LifecycleStatusChipProps) {
  const t = useTranslations("inbox.lifecycle")

  const apply = async (next: ConversationStatus, snoozeUntil?: number) => {
    try {
      await setStatus(conversationKey, next, { sessionId, snoozeUntil })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          data-testid="lifecycle-status-chip"
          aria-label={t("aria", { status: t(`status.${status}`) })}
        >
          <span className={cn("size-2 rounded-full", STATUS_DOT[status])} aria-hidden />
          {t(`status.${status}`)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void apply("open")}>{t("status.open")}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void apply("pending")}>
          {t("status.pending")}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>{t("status.snoozed")}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {SNOOZE_OPTIONS.map((o) => (
              <DropdownMenuItem
                key={o.key}
                onClick={() => void apply("snoozed", Date.now() + o.ms)}
              >
                {t(`snooze.${o.key}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void apply("resolved")}>
          {t("status.resolved")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
