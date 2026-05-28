"use client"

/**
 * Compact CLI status chip for the plugin panel toolbar. At a glance:
 *   - green dot  → cognia CLI installed AND the dev bridge is listening
 *   - amber dot  → CLI installed but the bridge is offline
 *   - outline    → CLI not found
 *
 * Clicking opens the install dialog when the CLI is missing; when it's
 * installed the chip is a passive status indicator with a tooltip. Hidden
 * entirely on web / Capacitor (the hook reports unsupported).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { TerminalIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useCogniaCliStatus } from "@/hooks/plugins/use-cognia-cli-status"
import { CogniaCliInstallDialog } from "@/components/plugins/devtools/cognia-cli-install-dialog"

export function CliStatusChip({ className }: { className?: string }) {
  const t = useTranslations("plugins.cliStatus")
  const status = useCogniaCliStatus()
  const [dialogOpen, setDialogOpen] = useState(false)

  if (!status.supported || status.loading) return null

  const bridgeRunning = status.bridge?.running ?? false
  const tone = !status.installed ? "missing" : bridgeRunning ? "ready" : "degraded"

  const dotClass =
    tone === "ready"
      ? "bg-emerald-500"
      : tone === "degraded"
        ? "bg-amber-500"
        : "bg-muted-foreground/40"

  const label =
    tone === "missing"
      ? t("chipMissing")
      : tone === "degraded"
        ? t("chipBridgeDown")
        : t("chipReady")

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className={cn("gap-1.5 h-8 px-2", className)}
            onClick={() => {
              if (!status.installed) setDialogOpen(true)
            }}
            aria-label={label}
            data-testid="cli-status-chip"
            data-tone={tone}
          >
            <span className={cn("size-2 rounded-full", dotClass)} aria-hidden="true" />
            <TerminalIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {label}
          {status.version ? ` · ${status.version}` : ""}
        </TooltipContent>
      </Tooltip>

      <CogniaCliInstallDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onInstalled={status.refresh}
      />
    </>
  )
}
