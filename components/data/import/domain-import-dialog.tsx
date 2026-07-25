"use client"

// Per-domain import: pick a JSON file produced by `buildDomainExport`, review
// what it will write, confirm the merge strategy, apply.
//
// The review step matters: this used to commit on nothing more than the domain
// name and an export timestamp, while its sibling full-restore dialog showed a
// per-table row count. `PayloadRowCounts` is that same read-out — a
// `DomainExportFile.payload` is a `BackupPayloadV3`, so the counts are computed
// by one shared loop rather than two that can drift.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { pickAndReadFiles } from "@/lib/files/file-bridge"
import { createLogger } from "@cognia/logging"
import {
  applyDomainImport,
  detectDomainFile,
  getDomain,
  type DomainExportFile,
  type DomainKey,
} from "@/lib/data/domain"
import type { ImportMergeStrategy, ImportSummary } from "@/lib/data/types"
import { ImportSummary as ImportSummaryView } from "./import-summary"
import { PayloadRowCounts } from "./import-preview"
import { toast } from "sonner"

const log = createLogger("data-import")

interface Props {
  domain: DomainKey
  labelKey: string
  trigger: React.ReactNode
}

export function DomainImportDialog({ domain, labelKey, trigger }: Props) {
  const t = useTranslations("settings.data")
  const tImport = useTranslations("import")
  const [open, setOpen] = useState(false)
  const [strategy, setStrategy] = useState<ImportMergeStrategy>(
    getDomain(domain)?.defaultStrategy ?? "skip"
  )
  const [pending, setPending] = useState<DomainExportFile | null>(null)
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [busy, setBusy] = useState(false)

  const reset = () => {
    setPending(null)
    setSummary(null)
  }

  const pick = async () => {
    setBusy(true)
    try {
      const picked = await pickAndReadFiles({
        filters: [{ name: "Cognia domain", extensions: ["json"] }],
      })
      const raw = picked[0]?.content
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (!detectDomainFile(parsed)) {
        toast.error(t("domain.importNotADomainFile"))
        return
      }
      if (parsed.domain !== domain) {
        toast.error(t("domain.importDomainMismatch", { expected: domain, actual: parsed.domain }))
        return
      }
      setPending(parsed)
    } catch (err) {
      log.error("domain-import-pick-failed", { domain, error: err })
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const commit = async () => {
    if (!pending) return
    setBusy(true)
    try {
      const result = await applyDomainImport(pending, strategy)
      setSummary(result)
      toast.success(t("importSuccess"))
    } catch (err) {
      log.error("domain-import-apply-failed", { domain, strategy, error: err })
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) reset()
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(`domain.${labelKey}.importTitle` as never)}</DialogTitle>
          <DialogDescription>{t(`domain.${labelKey}.importBody` as never)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs">{t("mergeStrategyLabel")}</Label>
            <Select value={strategy} onValueChange={(v) => setStrategy(v as ImportMergeStrategy)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="skip">{t("strategySkip")}</SelectItem>
                <SelectItem value="overwrite">{t("strategyOverwrite")}</SelectItem>
                <SelectItem value="duplicate">{t("strategyDuplicate")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {!pending && (
            <Button onClick={() => void pick()} disabled={busy}>
              {busy && <Loader2Icon className="mr-2 size-4 animate-spin" aria-hidden />}
              {busy ? t("loading") : tImport("dialog.pickButton")}
            </Button>
          )}

          {pending && (
            <div
              className="space-y-2 rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground"
              data-testid="domain-import-preview"
            >
              <p>
                {t("domain.importLoaded", {
                  domain: pending.domain,
                  exportedAt: new Date(pending.exportedAt).toLocaleString(),
                })}
              </p>
              <PayloadRowCounts payload={pending.payload} />
            </div>
          )}

          {summary && <ImportSummaryView summary={summary} />}
        </div>

        <DialogFooter>
          {pending && !summary && (
            <Button onClick={() => void commit()} disabled={busy}>
              {busy ? t("applying") : t("apply")}
            </Button>
          )}
          {summary && (
            <Button variant="outline" onClick={() => setOpen(false)}>
              {tImport("dialog.done")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
