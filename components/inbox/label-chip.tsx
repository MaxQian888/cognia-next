"use client"

/**
 * Small presentational label pill (CRM, schema v83). A color dot + name, with
 * an optional remove affordance used by the label picker. Pure — no data
 * access — so it renders in conversation rows, the header, and the picker.
 */

import { XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
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
    <span
      data-testid={`label-chip-${label.id}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-none",
        "bg-muted/40",
        className
      )}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full border"
        style={label.color ? { backgroundColor: label.color } : undefined}
      />
      <span className="max-w-[10rem] truncate">{label.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("removeAria", { name: label.name })}
          className="-mr-0.5 ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <XIcon className="size-2.5" aria-hidden />
        </button>
      )}
    </span>
  )
}
