"use client"

/**
 * DevTools card showing the `cognia` plugin-author CLI status. Three
 * states:
 *   - Installed: green check + version + path + bridge state. Buttons to
 *     reveal the binary and open docs.
 *   - Missing: explainer + Install CTA → opens the install dialog.
 *   - Web mode: disabled hint (CLI tooling is desktop-only).
 *
 * Composes `useCogniaCliStatus` (PATH/managed-dir probe + bridge status)
 * with the install dialog.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  CheckCircle2Icon,
  CircleHelpIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  Loader2Icon,
  TerminalIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { useCogniaCliStatus } from "@/hooks/plugins/use-cognia-cli-status"
import { openPath, openUrl } from "@/lib/native/opener"
import { cn } from "@/lib/utils"
import { InstalledMarker } from "@/components/plugins/_shared/installed-marker"
import { CogniaCliInstallDialog } from "./cognia-cli-install-dialog"

const DOCS_URL = "https://github.com/MaxQian888/cognia-next/tree/master/crates/cognia-cli"

export function CogniaCliStatusCard({ className }: { className?: string }) {
  const t = useTranslations("plugins.cliStatus")
  const status = useCogniaCliStatus()
  const [dialogOpen, setDialogOpen] = useState(false)

  return (
    <Card
      className={cn(
        "gap-0 overflow-hidden border-border/70 py-0 shadow-sm transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md",
        className
      )}
      data-testid="cognia-cli-status-card"
    >
      <div className="flex h-full flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
            <TerminalIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="min-w-0 space-y-1">
            <h3 className="text-sm font-semibold tracking-tight">{t("title")}</h3>
            <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
              {t("description")}
            </p>
          </div>
        </div>

        <div className="shrink-0 sm:max-w-[52%]">
          {!status.supported ? (
            <InstalledMarker desktopOnly />
          ) : status.loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
              {t("probing")}
            </div>
          ) : status.installed ? (
            <InstalledState status={status} t={t} />
          ) : (
            <MissingState onInstall={() => setDialogOpen(true)} t={t} />
          )}
        </div>
      </div>

      <CogniaCliInstallDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onInstalled={status.refresh}
      />
    </Card>
  )
}

function InstalledState({
  status,
  t,
}: {
  status: ReturnType<typeof useCogniaCliStatus>
  t: ReturnType<typeof useTranslations>
}) {
  const bridgeRunning = status.bridge?.running ?? false
  return (
    <div className="space-y-2" data-testid="cognia-cli-installed">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="gap-1 text-xs">
          <CheckCircle2Icon className="size-3 text-emerald-600" aria-hidden="true" />
          {status.version ?? t("installedUnknownVersion")}
        </Badge>
        <Badge variant={bridgeRunning ? "outline" : "destructive"} className="text-xs">
          {bridgeRunning ? t("bridgeRunning") : t("bridgeDown")}
        </Badge>
      </div>
      {status.path && (
        <p className="text-xs text-muted-foreground font-mono break-all">{status.path}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {status.path && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void openPath(status.path!)}
            data-testid="cognia-cli-reveal"
          >
            <FolderOpenIcon className="mr-1.5 size-3.5" aria-hidden="true" />
            {t("reveal")}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void openUrl(DOCS_URL)}>
          <ExternalLinkIcon className="mr-1.5 size-3.5" aria-hidden="true" />
          {t("docs")}
        </Button>
      </div>
    </div>
  )
}

function MissingState({
  onInstall,
  t,
}: {
  onInstall: () => void
  t: ReturnType<typeof useTranslations>
}) {
  return (
    <div className="space-y-2" data-testid="cognia-cli-missing">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <CircleHelpIcon className="size-3.5 shrink-0" aria-hidden="true" />
        {t("missingHint")}
      </div>
      <Button size="sm" onClick={onInstall} data-testid="cognia-cli-install-cta">
        {t("install")}
      </Button>
    </div>
  )
}
