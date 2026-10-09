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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { mutateConversationOverride } from "@/lib/connectors/inbox-writes"
import type { ConversationStatus } from "@/lib/db/conversation-overrides"
import { STATUS_DOT, StatusMenuItems, TRIAGE_DROPDOWN_KIT } from "./triage-menu-items"

// The presets moved to `lib/inbox/snooze-presets.ts` so the shared option
// lists can use them without importing this component; re-exported here for
// the callers that already import them from the chip.
export { SNOOZE_PRESETS, snoozeUntilFor, type SnoozePresetKey } from "@/lib/inbox/snooze-presets"

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
      await mutateConversationOverride({
        kind: "setStatus",
        conversationKey,
        status: next,
        sessionId,
        snoozeUntil,
      })
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
        {/* The same option list as the row menu, the keyboard's quick menu,
            the bulk bar and the phone sheet (`triage-menu-items.tsx`). */}
        <StatusMenuItems
          kit={TRIAGE_DROPDOWN_KIT}
          current={status}
          onSetStatus={(next, snoozeUntil) => void apply(next, snoozeUntil)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
