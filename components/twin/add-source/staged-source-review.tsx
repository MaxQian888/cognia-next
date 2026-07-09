"use client"

/**
 * Review/confirm step of the add-source flow.
 *
 * Shows every staged (extracted but uncommitted) source with an include
 * checkbox — the safety valve for fan-out imports (an .mbox or git walk can
 * stage hundreds of items) — plus an expandable inline preview rendered by
 * the same `SourceContentPreview` the post-add dialog uses. Nothing touches
 * Dexie until the confirm button hands the ticked subset back to the flow.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, ChevronRightIcon, Loader2Icon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SourceContentPreview } from "../source-content-preview"
import type { IngestError, StagedSource } from "@/lib/twin/ingest/stage"
import type { FileNotice } from "./source-inputs"

export interface StagedSourceReviewProps {
  staged: StagedSource[]
  /** Per-file diagnostics from the file input (skipped files, etc.). */
  notices?: FileNotice[]
  committing: boolean
  onConfirm: (selected: StagedSource[]) => void
  onBack: () => void
  /** Localizes an IngestError against twin.sourceUploader.errors. */
  renderError: (error: IngestError) => string
}

export function StagedSourceReview({
  staged,
  notices,
  committing,
  onConfirm,
  onBack,
  renderError,
}: StagedSourceReviewProps) {
  const t = useTranslations("twin.addSource")
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(new Set())
  const [expanded, setExpanded] = useState<number | null>(null)

  const selected = useMemo(
    () => staged.filter((_, index) => !excluded.has(index)),
    [staged, excluded]
  )

  const toggle = (index: number, include: boolean) => {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (include) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const failedNotices = (notices ?? []).filter((n) => n.error)

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid="twin-add-source-review">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{t("reviewTitle")}</p>
        <p className="text-muted-foreground text-xs">
          {t("selectedCount", { selected: selected.length, count: staged.length })}
        </p>
      </div>

      {failedNotices.length > 0 ? (
        <div className="text-xs" data-testid="twin-add-source-review-notices">
          <p className="font-medium">{t("skippedFiles")}</p>
          <ul className="mt-1 list-disc pl-5">
            {failedNotices.map((notice) => (
              <li key={notice.filename}>
                <span className="font-mono">{notice.filename}</span>
                {notice.error ? (
                  <span className="text-destructive"> ({renderError(notice.error)})</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ScrollArea className="max-h-80 min-h-0 rounded-md border">
        <ul className="divide-y">
          {staged.map((item, index) => {
            const included = !excluded.has(index)
            const isExpanded = expanded === index
            return (
              <li key={index} className="flex flex-col gap-2 p-2.5">
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={included}
                    onCheckedChange={(checked) => toggle(index, checked === true)}
                    aria-label={t("includeAria", { title: item.title })}
                    data-testid={`twin-add-source-include-${index}`}
                  />
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    onClick={() => setExpanded(isExpanded ? null : index)}
                    aria-expanded={isExpanded}
                    data-testid={`twin-add-source-expand-${index}`}
                  >
                    {isExpanded ? (
                      <ChevronDownIcon className="size-3.5 shrink-0" aria-hidden />
                    ) : (
                      <ChevronRightIcon className="size-3.5 shrink-0" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                  </button>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {item.format}
                  </Badge>
                  <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
                    {t("charCount", { count: item.text.length })}
                  </span>
                </div>
                {isExpanded ? (
                  <div className="flex flex-col gap-3 pl-6">
                    <SourceContentPreview
                      text={item.text}
                      active={isExpanded}
                      bodyHeightClassName="h-40"
                    />
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      </ScrollArea>

      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" onClick={onBack} disabled={committing}>
          {t("back")}
        </Button>
        <Button
          onClick={() => onConfirm(selected)}
          disabled={committing || selected.length === 0}
          data-testid="twin-add-source-confirm"
        >
          {committing ? (
            <>
              <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
              {t("adding")}
            </>
          ) : (
            t("confirmAdd", { count: selected.length })
          )}
        </Button>
      </div>
    </div>
  )
}
