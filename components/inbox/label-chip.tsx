"use client"

/**
 * Small presentational label pill (CRM, schema v83). A color dot + name, with
 * an optional remove affordance used by the label picker. Pure — no data
 * access — so it renders in conversation rows, the header, and the picker.
 */

import { XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { ConversationLabelRow } from "@/lib/db/crm-types"

export interface LabelChipProps {
  label: ConversationLabelRow
  /** When provided, renders a small × that calls this. */
  onRemove?: () => void
  className?: string
}

export function LabelChip({ label, onRemove, className }: LabelChipProps) {
  const t = useTranslations("inbox.labels")
  return (
    <Badge
      variant="secondary"
      data-testid={`label-chip-${label.id}`}
      className={cn("gap-1 text-[11px] leading-none", className)}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full border"
        style={label.color ? { backgroundColor: label.color } : undefined}
      />
      <span className="max-w-[10rem] truncate">{label.name}</span>
      {onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          aria-label={t("removeAria", { name: label.name })}
          className="-mr-1 ml-0.5 size-4 rounded-full text-muted-foreground"
        >
          <XIcon className="size-2.5" aria-hidden />
        </Button>
      )}
    </Badge>
  )
}
