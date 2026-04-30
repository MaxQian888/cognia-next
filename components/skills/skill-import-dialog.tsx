"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Card } from "@/components/ui/card"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import {
  bulkImportSkills,
  type BulkImportResult,
  type ImportConflictStrategy,
  type SkillDraft,
} from "@/lib/db/skills"
import type { ImportStaging } from "@/stores/skills"
import { loggers } from "@/lib/logger"

interface Props {
  staging: ImportStaging
  onCancel: () => void
  onComplete: (report: BulkImportResult) => void
}

export function SkillImportDialog({ staging, onCancel, onComplete }: Props) {
  const t = useTranslations("skills.import")
  const [strategy, setStrategy] = useState<ImportConflictStrategy>("skip")
  const [running, setRunning] = useState(false)

  const apply = async () => {
    setRunning(true)
    try {
      const drafts: SkillDraft[] = staging.drafts.map((d) => ({
        name: d.name,
        description: d.description,
        content: d.content,
        tags: d.tags,
        allowedTools: d.allowedTools,
        category: d.category,
        source: "imported",
      }))
      const report = await bulkImportSkills(drafts, strategy)
      loggers.skills.info("bulk import ok", {
        strategy,
        attempted: drafts.length,
        created: report.created,
        updated: report.updated,
        skipped: report.skipped,
        errored: report.errored.length,
      })
      onComplete(report)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("bulk import failed", err, {
        strategy,
        attempted: staging.drafts.length,
      })
    } finally {
      setRunning(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{staging.sourceLabel}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Card className="p-3">
            <p className="mb-1 text-xs font-medium">
              {t("stagedCount", { count: staging.drafts.length })}
            </p>
            <ScrollArea className="h-40">
              <div className="space-y-1.5">
                {staging.drafts.map((d, i) => (
                  <div
                    key={`${d.name}-${i}`}
                    className="flex items-center justify-between gap-2 rounded-sm bg-muted/30 px-2 py-1 text-xs"
                  >
                    <span className="truncate">{d.name}</span>
                    {d.tags && d.tags.length > 0 && (
                      <span className="flex gap-1 shrink-0">
                        {d.tags.slice(0, 2).map((tag) => (
                          <Badge key={tag} variant="outline" className="h-4 text-[9px]">
                            {tag}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
            {staging.parseErrors.length > 0 && (
              <p className="mt-2 text-[11px] text-destructive">
                {t("parseErrorsLine", {
                  count: staging.parseErrors.length,
                  first: staging.parseErrors[0]?.error ?? "",
                })}
              </p>
            )}
          </Card>

          <div className="space-y-1.5">
            <Label className="text-xs">{t("strategyLabel")}</Label>
            <RadioGroup
              value={strategy}
              onValueChange={(v) => setStrategy(v as ImportConflictStrategy)}
              className="gap-1"
            >
              <RadioRow value="skip" label={t("strategySkip")} />
              <RadioRow value="duplicate" label={t("strategyDuplicate")} />
              <RadioRow value="overwrite" label={t("strategyOverwrite")} />
            </RadioGroup>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={running}>
            {t("cancel")}
          </Button>
          <Button size="sm" onClick={apply} disabled={running}>
            {running && <Spinner className="mr-1.5 size-3" />}
            {running ? t("applying") : t("apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RadioRow({ value, label }: { value: string; label: string }) {
  return (
    <Label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-xs hover:bg-accent">
      <RadioGroupItem value={value} />
      {label}
    </Label>
  )
}
