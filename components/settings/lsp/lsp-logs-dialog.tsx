"use client"

/**
 * Viewer over the sidecar LSP log ring buffer (`lsp:logs`) — server stderr
 * plus lifecycle lines (started / crashed / restart scheduled / broken).
 * Loads on open and on demand via the refresh button. Read-only.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { RotateCcw } from "lucide-react"
import { useLspStatusStore } from "@/lib/lsp/lsp-status-store"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

export interface LspLogsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const LEVEL_CLASS: Record<string, string> = {
  info: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
}

export function LspLogsDialog({ open, onOpenChange }: LspLogsDialogProps) {
  const t = useTranslations("settings.lspServers.logs")
  const logs = useLspStatusStore((s) => s.logs)
  const loadLogs = useLspStatusStore((s) => s.loadLogs)
  const [loadedOnce, setLoadedOnce] = useState(false)

  // Load on first open (render-time adjustment, not an effect).
  if (open && !loadedOnce) {
    setLoadedOnce(true)
    void loadLogs()
  }
  if (!open && loadedOnce) {
    setLoadedOnce(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="lsp-logs-dialog">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2">
            <DialogTitle>{t("title")}</DialogTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void loadLogs()}
              aria-label={t("refreshAriaLabel")}
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {logs.length === 0 ? (
          <div className="rounded-md border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
            {t("empty")}
          </div>
        ) : (
          <ScrollArea className="max-h-[50vh]">
            <ol className="space-y-0.5 font-mono text-xs" data-testid="lsp-logs-list">
              {logs.map((entry, i) => (
                <li key={`${entry.ts}-${i}`} className="flex gap-2">
                  <span className="shrink-0 text-muted-foreground/70">
                    {new Date(entry.ts).toLocaleTimeString()}
                  </span>
                  <span className="shrink-0 font-medium">{entry.serverId}</span>
                  <span className={cn("break-all", LEVEL_CLASS[entry.level])}>{entry.message}</span>
                </li>
              ))}
            </ol>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  )
}
