"use client"

/**
 * Conversation label picker (CRM, schema v83). Renders the conversation's
 * current labels as removable chips followed by a "＋" dropdown that toggles
 * the full catalog on/off. Add/remove go through addLabel / removeLabel, which
 * record the change on the assignment-event trail. The catalog comes from the
 * reactive useConversationLabels hook so newly-created labels appear live.
 */

import { useTranslations } from "next-intl"
import { TagIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { LabelChip } from "./label-chip"
import { useConversationLabels } from "@/hooks/connectors/use-conversation-labels"
import { mutateConversationOverride } from "@/lib/connectors/inbox-writes"

export interface LabelPickerProps {
  conversationKey: string
  sessionId: string
  selectedIds: string[]
}

export function LabelPicker({ conversationKey, sessionId, selectedIds }: LabelPickerProps) {
  const t = useTranslations("inbox.labels")
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
          <LabelChip key={l.id} label={l} onRemove={() => void toggle(l.id, false)} />
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
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("pickerTitle")}
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            {catalog.length === 0 ? (
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                {t("empty")}
              </DropdownMenuLabel>
            ) : (
              catalog.map((l) => (
                <DropdownMenuCheckboxItem
                  key={l.id}
                  checked={selected.has(l.id)}
                  onCheckedChange={(next) => void toggle(l.id, next === true)}
                  onSelect={(e) => e.preventDefault()}
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full border"
                      style={l.color ? { backgroundColor: l.color } : undefined}
                    />
                    {l.name}
                  </span>
                </DropdownMenuCheckboxItem>
              ))
            )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <a href="/settings?section=connections&connectionsTab=assets">{t("manage")}</a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
