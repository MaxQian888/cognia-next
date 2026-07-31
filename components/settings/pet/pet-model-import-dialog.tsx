// Selection dialog for importing one or more Live2D models out of a multi-model
// bundle (a picked folder or a whole `.zip` like `Live2d-model-master`). The
// caller discovers + groups the models (`discoverLive2dModels`); this dialog
// only lists them, lets the user pick valid ones, and persists each via the
// shared `importModelFromEntries`. Invalid groups are shown disabled with their
// reason. Mounted fresh per session by the manager, so state needs no reset.

"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { formatBytes } from "@/lib/agent/utils"
import type { DiscoveredModel } from "@/lib/pet/live2d/discover-models"
import { importModelFromEntries } from "./pet-model-import"

export interface PetModelImportDialogProps {
  /** Discovered models from the picked bundle (valid + invalid). */
  models: DiscoveredModel[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after import with the first successfully imported id (for auto-activate). */
  onImported: (firstId?: string) => void
}

export function PetModelImportDialog({
  models,
  open,
  onOpenChange,
  onImported,
}: PetModelImportDialogProps) {
  const t = useTranslations("settings.pet.live2d.importDialog")
  const tErr = useTranslations("settings.pet.live2d.errors")

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState(0)

  const validKeys = models.filter((m) => m.valid).map((m) => m.key)
  const allSelected = validKeys.length > 0 && validKeys.every((k) => selected.has(k))

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(validKeys))
  }

  const handleImport = async () => {
    // The import button is disabled while `selected` is empty, so `chosen` is
    // always non-empty here (selection only ever holds valid keys).
    const chosen = models.filter((m) => m.valid && selected.has(m.key))
    setImporting(true)
    setProgress(0)
    let firstId: string | undefined
    let ok = 0
    const failed: string[] = []
    try {
      for (let i = 0; i < chosen.length; i++) {
        const m = chosen[i]
        const outcome = await importModelFromEntries(m.entries, { source: "import" })
        if (outcome.ok) {
          ok += 1
          if (!firstId) firstId = outcome.id
        } else {
          failed.push(`${m.name}: ${tErr(outcome.code)}`)
        }
        setProgress(Math.round(((i + 1) / chosen.length) * 100))
      }
      toast.success(t("summary", { ok, fail: failed.length }))
      if (failed.length > 0) toast.warning(failed.join("; "))
      onImported(firstId)
      onOpenChange(false)
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="pet-model-import-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description", { count: models.length })}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={allSelected}
              disabled={importing || validKeys.length === 0}
              onCheckedChange={toggleAll}
              aria-label={t("selectAll")}
            />
            {t("selectAll")}
          </label>
          <span className="text-xs text-muted-foreground">
            {t("selectedCount", { count: selected.size })}
          </span>
        </div>

        <ScrollArea className="h-64 rounded border">
          <ul className="divide-y">
            {models.map((m) => (
              <li key={m.key}>
                <label
                  className="flex items-start gap-2 px-3 py-2 hover:bg-accent has-[:disabled]:hover:bg-transparent"
                  data-testid={`pet-import-row-${m.key}`}
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={selected.has(m.key)}
                    disabled={!m.valid || importing}
                    onCheckedChange={() => toggle(m.key)}
                    aria-label={m.name}
                  />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`truncate text-sm ${m.valid ? "" : "text-muted-foreground"}`}
                      >
                        {m.name}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatBytes(m.totalBytes)}
                      </span>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{m.settingsPath}</div>
                    {!m.valid && m.errorCode && (
                      <div className="text-xs text-destructive">{tErr(m.errorCode)}</div>
                    )}
                  </div>
                </label>
              </li>
            ))}
          </ul>
        </ScrollArea>

        {importing && <Progress value={progress} aria-label={t("importing")} />}

        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={importing}
            onClick={() => onOpenChange(false)}
          >
            {t("cancel")}
          </Button>
          <Button
            size="sm"
            disabled={importing || selected.size === 0}
            onClick={() => void handleImport()}
          >
            {importing ? t("importing") : t("importButton", { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
