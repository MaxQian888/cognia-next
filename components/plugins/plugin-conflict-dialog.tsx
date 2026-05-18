"use client"

// Surfaces the conflict-detector output before completing an install.
// Severity buckets the rows so the user knows what to triage; Continue
// proceeds with the install (caller wires the install dispatch), Abort
// closes without changes.

import { useTranslations } from "next-intl"
import { AlertTriangleIcon, AlertCircleIcon, InfoIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { usePluginsStore } from "@/stores/plugins"

interface Props {
  /** Optional callback fired when the user chooses to continue despite
   * conflicts. The store target is cleared in either branch. */
  onContinue?: (pluginId: string) => void
}

export function PluginConflictDialog({ onContinue }: Props = {}) {
  const t = useTranslations("plugins.conflict")
  const target = usePluginsStore((s) => s.conflictDialogTarget)
  const setTarget = usePluginsStore((s) => s.setConflictDialogTarget)
  const open = target !== null

  if (!target) {
    return (
      <Dialog open={false} onOpenChange={() => setTarget(null)}>
        <DialogContent>{null}</DialogContent>
      </Dialog>
    )
  }

  const { pluginId, conflicts } = target
  const high = conflicts.filter((c) => c.severity === "high")
  const medium = conflicts.filter((c) => c.severity === "medium")
  const low = conflicts.filter((c) => c.severity === "low")

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setTarget(null)}>
      <DialogContent className="w-[95vw] max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("title", { id: pluginId })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-1.5">
          {high.length > 0 && (
            <Badge variant="destructive" className="text-xs">
              {t("highCount", { count: high.length })}
            </Badge>
          )}
          {medium.length > 0 && (
            <Badge variant="secondary" className="text-xs">
              {t("mediumCount", { count: medium.length })}
            </Badge>
          )}
          {low.length > 0 && (
            <Badge variant="outline" className="text-xs">
              {t("lowCount", { count: low.length })}
            </Badge>
          )}
        </div>

        <Card className="p-0">
          <ScrollArea className="max-h-[40vh]">
            <ul className="divide-y">
              {conflicts.map((c, idx) => (
                <li key={idx} className="flex items-start gap-2 px-3 py-2">
                  {c.severity === "high" ? (
                    <AlertTriangleIcon className="size-4 text-destructive mt-0.5 shrink-0" />
                  ) : c.severity === "medium" ? (
                    <AlertCircleIcon className="size-4 text-orange-500 mt-0.5 shrink-0" />
                  ) : (
                    <InfoIcon className="size-4 text-muted-foreground mt-0.5 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="text-sm">{c.message}</div>
                    {c.relatedPluginId && (
                      <div className="text-xs text-muted-foreground">
                        {t("relatedPlugin")} <code className="font-mono">{c.relatedPluginId}</code>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </ScrollArea>
        </Card>

        <DialogFooter>
          <Button variant="outline" onClick={() => setTarget(null)}>
            {t("abort")}
          </Button>
          <Button
            variant={high.length > 0 ? "destructive" : "default"}
            onClick={() => {
              setTarget(null)
              onContinue?.(pluginId)
            }}
          >
            {t("continue")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
