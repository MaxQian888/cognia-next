"use client"

import { ClockIcon, FileTextIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { TwinDraft } from "@/types/twin"
import { cn } from "@/lib/utils"

export interface TwinDraftCardProps {
  draft: TwinDraft
  onSelect?: (draft: TwinDraft) => void
  className?: string
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === "string" && v.length > 0 ? v : undefined
}

export function TwinDraftCard({ draft, onSelect, className }: TwinDraftCardProps) {
  const t = useTranslations("mobile.twinDraft")
  const accepted = draft.status === "accepted"
  const data = draft.payload.data as Record<string, unknown>
  const displayName = readString(data, "name") ?? readString(data, "title") ?? t("untitled")
  const summary =
    readString(data, "description") ??
    readString(data, "summary") ??
    readString(data, "systemPrompt") ??
    t("noSummary")
  const qualityScore = draft.evaluation?.qualityScore ?? 0
  const kindLabel = draft.kind === "character" ? t("kindCharacter") : t("kindSkill")
  const statusLabel = t(
    draft.status === "accepted"
      ? "statusAccepted"
      : draft.status === "rejected"
        ? "statusRejected"
        : draft.status === "edited"
          ? "statusEdited"
          : "statusPending"
  )

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => onSelect?.(draft)}
      className={cn(
        "h-auto w-full items-start justify-start gap-3 rounded-md border border-border bg-card p-3 text-left font-normal",
        "active:bg-muted/50 transition-colors",
        accepted && "opacity-70",
        className
      )}
      data-testid={`twin-draft-card-${draft.id}`}
      data-accepted={accepted ? "true" : "false"}
    >
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
      >
        <FileTextIcon className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-semibold">{displayName}</h3>
          <Badge variant="outline" className="text-[10px]">
            {kindLabel}
          </Badge>
          <Badge className="text-[10px]" variant={accepted ? "secondary" : "outline"}>
            {statusLabel}
          </Badge>
        </div>
        <p className="line-clamp-2 text-xs text-muted-foreground">{summary}</p>
        <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
          <ClockIcon className="size-3" />
          {new Date(draft.createdAt).toLocaleDateString()}
          <span>· {t("qualityScore", { percent: Math.round(qualityScore * 100) })}</span>
        </p>
      </div>
    </Button>
  )
}
