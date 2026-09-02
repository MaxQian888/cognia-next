"use client"

// The report a backup owner sees before a share link is created from a
// plaintext package that still carries recognised personal information. The
// gate (`lib/share/backup-share-gate.ts`) never redacts a backup, so the only
// two ways out of this dialog are cancel, or tick the confirmation and go on.
// A clean or encrypted result never opens it: those are one-line notes inside
// the share dialog itself.

import { useId, useState } from "react"
import { useTranslations } from "next-intl"
import { ShieldAlertIcon } from "lucide-react"

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
import { Badge } from "@/components/ui/badge"
import type { BackupShareDomainHits } from "@/lib/share/backup-share-gate"

export interface BackupShareScanDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Domains with hits, most hits first. */
  domains: BackupShareDomainHits[]
  total: number
  /** Called once the owner has ticked the confirmation and pressed continue. */
  onConfirm: () => void
}

export function BackupShareScanDialog({
  open,
  onOpenChange,
  domains,
  total,
  onConfirm,
}: BackupShareScanDialogProps) {
  const t = useTranslations("settings.data.backup.shareScan")
  const [confirmed, setConfirmed] = useState(false)
  const checkboxId = useId()

  // Every opening starts unticked. A confirmation given for one report must
  // not carry over to the next package the owner prepares.
  const handleOpenChange = (next: boolean) => {
    if (!next) setConfirmed(false)
    onOpenChange(next)
  }
  const handleConfirm = () => {
    setConfirmed(false)
    onConfirm()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="backup-share-scan-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlertIcon className="size-4 text-destructive" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("body")}</DialogDescription>
        </DialogHeader>

        <p
          className="text-xs font-medium text-muted-foreground"
          data-testid="backup-share-scan-total"
        >
          {t("total", { total, domains: domains.length })}
        </p>
        <ul className="max-h-64 space-y-2 overflow-y-auto text-sm">
          {domains.map((entry) => (
            <li
              key={entry.domain}
              className="rounded-md border border-border/60 px-3 py-2"
              data-testid={`backup-share-scan-domain-${entry.domain}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{t(`domains.${entry.domain}`)}</span>
                <span className="text-xs text-muted-foreground">
                  {t("domainRow", { hits: entry.hits })}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {Object.entries(entry.byKind).map(([kind, count]) => (
                  <Badge key={kind} variant="secondary" className="text-[11px]">
                    {t("kindCount", { kind: t(`kinds.${kind}`), count })}
                  </Badge>
                ))}
              </div>
            </li>
          ))}
        </ul>

        <label htmlFor={checkboxId} className="flex items-start gap-2 text-sm">
          <Checkbox
            id={checkboxId}
            checked={confirmed}
            onCheckedChange={(next) => setConfirmed(next === true)}
            data-testid="backup-share-scan-confirm"
          />
          <span>{t("confirm")}</span>
        </label>

        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            data-testid="backup-share-scan-cancel"
          >
            {t("cancel")}
          </Button>
          <Button
            disabled={!confirmed}
            onClick={handleConfirm}
            data-testid="backup-share-scan-continue"
          >
            {t("continue")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
