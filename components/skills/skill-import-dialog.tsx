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
import { loggers } from "@/lib/logging"
import { isTauri } from "@/lib/tauri"
import { useSkillSync, useSkillPanelPrefs } from "@/hooks/skills"
import { getSkill } from "@/lib/db/skills"

interface Props {
  staging: ImportStaging
  onCancel: () => void
  onComplete: (report: BulkImportResult) => void
}

export function SkillImportDialog({ staging, onCancel, onComplete }: Props) {
  const t = useTranslations("skills.import")
  const tBundle = useTranslations("skills.import.bundle")
  const [strategy, setStrategy] = useState<ImportConflictStrategy>("skip")
  const [running, setRunning] = useState(false)
  const sync = useSkillSync()
  const autoEnableNew = useSkillPanelPrefs().autoEnableNew

  const totalResources = staging.drafts.reduce((acc, d) => acc + (d.resources?.length ?? 0), 0)
  const hasResources = totalResources > 0
  const bundleFlavor = staging.flavor

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
        // Honor the "auto-enable new skills" preference: when off, imported
        // skills land disabled so the user opts them into the prompt.
        status: autoEnableNew ? undefined : "disabled",
        // Forward bundle-only fields so `bulkImportSkills` can dispatch to
        // the canonical-id upsert path and persist resources.
        canonicalId: d.canonicalId,
        resources: d.resources,
        validationErrors: d.validationErrors,
        nativeDirectory: d.nativeDirectory,
      }))
      const report = await bulkImportSkills(drafts, strategy)
      loggers.skills.info("bulk import ok", {
        strategy,
        attempted: drafts.length,
        created: report.created,
        updated: report.updated,
        skipped: report.skipped,
        errored: report.errored.length,
        flavor: bundleFlavor,
        bundleResources: totalResources,
      })

      // Auto-mirror to disk for Tauri bundle imports. Skipping for web /
      // mobile keeps the resources in Dexie as an inline bundle; the
      // mobile-sync orchestrator picks them up on the next sync to a
      // Tauri device and materialises then.
      if (isTauri() && hasResources && (report.created > 0 || report.updated > 0)) {
        const allSkills = await Promise.all(
          drafts
            .filter((d) => d.canonicalId)
            .map(async (d) => {
              if (!d.canonicalId) return undefined
              // The upsert helper keyed off canonicalId stores the row at
              // a stable id, but the import dialog doesn't see that id —
              // re-look up by canonicalId to fire the per-skill push.
              const { listSkills } = await import("@/lib/db/skills")
              const all = await listSkills()
              return all.find((s) => s.canonicalId === d.canonicalId)?.id
            })
        )
        const targetIds = allSkills.filter((id): id is string => typeof id === "string")
        for (const id of targetIds) {
          if (!(await getSkill(id))) continue
          await sync.pushOne(id)
        }
      }

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
            <div className="mb-1 flex items-center justify-between gap-2">
              <p className="text-xs font-medium">
                {t("stagedCount", { count: staging.drafts.length })}
              </p>
              <div className="flex items-center gap-1">
                {bundleFlavor && (
                  <Badge
                    variant="outline"
                    className="h-4 text-[9px]"
                    data-testid="skill-import-dialog-flavor"
                  >
                    {bundleFlavor === "codex" ? tBundle("flavorCodex") : tBundle("flavorAnthropic")}
                  </Badge>
                )}
                {hasResources && (
                  <Badge
                    variant="secondary"
                    className="h-4 text-[9px]"
                    data-testid="skill-import-dialog-resources"
                  >
                    {tBundle("resourcesCount", { count: totalResources })}
                  </Badge>
                )}
              </div>
            </div>
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
