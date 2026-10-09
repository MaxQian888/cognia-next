"use client"

/**
 * Conversation label picker (CRM, schema v83). Renders the conversation's
 * current labels as removable chips followed by a "＋" dropdown that toggles
 * the full catalog on/off. Add/remove go through addLabel / removeLabel, which
 * record the change on the assignment-event trail. The catalog comes from the
 * reactive useConversationLabels hook so newly-created labels appear live.
 */

import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { TagIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { LabelChip } from "@/components/labels/label-chip"
import { useConversationLabels } from "@/hooks/connectors/use-conversation-labels"
import { mutateConversationOverride } from "@/lib/connectors/inbox-writes"
import { LabelMenuItems, TRIAGE_DROPDOWN_KIT } from "./triage-menu-items"

/** The label manager, where the conversation label catalog is edited. */
export const LABEL_MANAGER_HREF = "/settings?section=connections&connectionsTab=assets"

export interface LabelPickerProps {
  conversationKey: string
  sessionId: string
  selectedIds: string[]
}

export function LabelPicker({ conversationKey, sessionId, selectedIds }: LabelPickerProps) {
  const t = useTranslations("inbox.labels")
  const router = useRouter()
  const catalog = useConversationLabels()
  const selected = new Set(selectedIds)

  const toggle = async (labelId: string, next: boolean) => {
    try {
      await mutateConversationOverride({
        kind: next ? "addLabel" : "removeLabel",
        conversationKey,
        labelId,
        sessionId,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex items-center gap-1" data-testid="label-picker">
      {catalog
        .filter((l) => selected.has(l.id))
        .map((l) => (
          <LabelChip
            key={l.id}
            label={l}
            onRemove={() => void toggle(l.id, false)}
            removeLabel={t("removeAria", { name: l.name })}
          />
        ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            data-testid="label-picker-trigger"
            aria-label={t("addAria")}
          >
            <TagIcon className="size-3.5" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* Shared with the row menu, the keyboard's `l` menu, the bulk bar
              and the phone sheet (`triage-menu-items.tsx`). */}
          <LabelMenuItems
            kit={TRIAGE_DROPDOWN_KIT}
            stateOf={(labelId) => (selected.has(labelId) ? "checked" : "unchecked")}
            onToggle={(labelId, state) => void toggle(labelId, state !== "checked")}
            onManage={() => router.push(LABEL_MANAGER_HREF)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
