"use client"

/**
 * The step "Load unpacked" never had: tell the user their bundle is a foreign
 * format, show what conversion carries over, and let them decide.
 *
 * Before this, picking a Claude Code plugin directory produced a raw error
 * under the button. The converter that installs the identical bundle from
 * GitHub was right there and nothing offered it.
 *
 * A bundle whose report has blockers is shown, not hidden. Which capability
 * blocked it is the useful part, and disabling the button says the rest.
 */

import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { PluginConversionReport } from "../_shared/plugin-conversion-report"
import type { LocalPluginInspection } from "@/lib/plugin/local/convert-local-source"

export interface LoadUnpackedConversionDialogProps {
  inspection: LocalPluginInspection | null
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean
}

export function LoadUnpackedConversionDialog({
  inspection,
  onConfirm,
  onCancel,
  busy = false,
}: LoadUnpackedConversionDialogProps) {
  const t = useTranslations("plugins.loadUnpacked")
  const tReport = useTranslations("plugins.conversionReport")

  return (
    <Dialog open={inspection !== null} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="flex max-h-[85dvh] w-[95vw] flex-col gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("conversionTitle")}</DialogTitle>
          <DialogDescription>
            {t("conversionBody", {
              source: inspection ? tReport(`sources.${inspection.sourceFormat}`) : "",
            })}
          </DialogDescription>
        </DialogHeader>

        {inspection && (
          <ScrollArea className="-mx-1 min-h-0 flex-1 px-1">
            <PluginConversionReport
              sourceFormat={inspection.sourceFormat}
              report={inspection.report}
              maxIssues={false}
            />
            {!inspection.convertible && (
              <p className="mt-2 text-xs text-destructive" data-testid="conversion-blocked">
                {t("conversionBlocked")}
              </p>
            )}
          </ScrollArea>
        )}

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            onClick={onConfirm}
            disabled={busy || !inspection?.convertible}
            data-testid="convert-and-install"
          >
            {t("convertAndInstall")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
