"use client"

/**
 * One updatable asset.
 *
 * The row always says who installs it. A Chrome extension row and a desktop
 * row look similar and behave completely differently, and hiding that behind
 * one "Update" button is how a user ends up believing Cognia failed at
 * something it never claimed to do.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  AlertTriangleIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  ShieldAlertIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import type { UpdateItem } from "@/lib/updates/adapter"
import { cn } from "@/lib/utils"

export interface UpdateRowProps {
  item: UpdateItem
  onApply: (key: string) => void
  onSkip: (key: string) => void
  onDefer: (key: string) => void
  onClearHold: (key: string) => void
  busy?: boolean
  highlighted?: boolean
}

const BUSY_STATES = new Set(["checking", "downloading", "installing"])

export function UpdateRow({
  item,
  onApply,
  onSkip,
  onDefer,
  onClearHold,
  busy,
  highlighted,
}: UpdateRowProps) {
  const t = useTranslations("updates")
  const [copied, setCopied] = useState(false)
  const candidate = item.candidate
  const critical = candidate?.criticality === "critical"
  const working = busy || BUSY_STATES.has(item.state)

  const name = item.displayName ?? t(`kind.${item.kind}`)
  const percent =
    item.progress?.total && item.progress.total > 0
      ? Math.min(100, Math.round((item.progress.downloaded / item.progress.total) * 100))
      : null

  const copyCommand = async () => {
    if (!item.command) return
    try {
      await navigator.clipboard.writeText(item.command)
      setCopied(true)
      toast.success(t("commandCopied"))
    } catch {
      setCopied(false)
    }
  }

  return (
    <div
      data-testid={`update-row-${item.key}`}
      data-state={item.state}
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3",
        highlighted && "ring-2 ring-primary",
        critical && item.state === "available" && "border-destructive/50"
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 shrink truncate text-sm font-medium">{name}</span>
        <Badge variant="outline" className="shrink-0 text-[11px]">
          {t(`state.${item.state}`)}
        </Badge>
        {critical && (
          <Badge variant="destructive" className="shrink-0 text-[11px]">
            {t("criticality.critical")}
          </Badge>
        )}
        <span className="ms-auto shrink-0 text-xs text-muted-foreground">
          {t(`installedBy.${item.executor}`)}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        {candidate && item.currentVersion
          ? t("versionChange", { from: item.currentVersion, to: candidate.targetVersion })
          : candidate
            ? t("notInstalledLocally", { version: candidate.targetVersion })
            : item.currentVersion
              ? t("newVersion", { version: item.currentVersion })
              : t("connectHint")}
      </p>

      {candidate?.provenance === "unsigned" && (
        <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-500">
          <ShieldAlertIcon className="size-3.5 shrink-0" />
          {t("unsigned")}
        </p>
      )}
      {candidate?.permissionsExpanded && (
        <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-500">
          <AlertTriangleIcon className="size-3.5 shrink-0" />
          {t("permissionsExpanded")}
        </p>
      )}
      {candidate?.compatibility?.breaking && (
        <p className="text-xs text-muted-foreground">{t("breaking")}</p>
      )}
      {critical && item.state !== "current" && (
        <p className="text-xs text-muted-foreground">{t("criticalNotice")}</p>
      )}
      {item.failure && (
        <p className="text-xs text-destructive" data-testid={`update-error-${item.key}`}>
          {t(`error.${item.failure.kind}`)}
        </p>
      )}
      {item.state === "failed" && item.failure?.code === "install_interrupted" && (
        <p className="text-xs text-muted-foreground">{t("interrupted")}</p>
      )}

      {candidate?.releaseNotes && (
        <p className="max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">
          {candidate.releaseNotes}
        </p>
      )}

      {(item.state === "downloading" || item.state === "installing") && (
        <div className="space-y-1">
          <Progress value={percent ?? 0} aria-label={t("downloadingLabel")} />
          {percent !== null && (
            <p className="text-xs text-muted-foreground">{t("progressPercent", { percent })}</p>
          )}
        </div>
      )}

      {item.command && (
        <div className="flex items-center gap-2 rounded-md bg-muted/50 p-2">
          <code className="min-w-0 shrink grow truncate font-mono text-xs">{item.command}</code>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void copyCommand()}
            aria-label={t("copyCommand")}
            data-testid={`copy-command-${item.key}`}
          >
            {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
          </Button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {item.action && candidate && (
          <Button
            size="sm"
            disabled={working}
            onClick={() => onApply(item.key)}
            data-testid={`update-apply-${item.key}`}
          >
            {working ? (
              <LoaderCircleIcon className="me-1.5 size-4 animate-spin" />
            ) : item.externallyInstalled ? (
              <ExternalLinkIcon className="me-1.5 size-4" />
            ) : null}
            {t(`action.${item.action}`)}
          </Button>
        )}
        {candidate && item.state !== "deferred" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={working}
            onClick={() => onDefer(item.key)}
            data-testid={`update-defer-${item.key}`}
          >
            <ClockIcon className="me-1.5 size-4" />
            {t("defer")}
          </Button>
        )}
        {candidate && !critical && (
          <Button
            size="sm"
            variant="ghost"
            disabled={working}
            onClick={() => onSkip(item.key)}
            data-testid={`update-skip-${item.key}`}
          >
            {t("skip")}
          </Button>
        )}
        {(item.skippedVersion || item.state === "deferred") && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onClearHold(item.key)}
            data-testid={`update-clear-hold-${item.key}`}
          >
            {t("clearHold")}
          </Button>
        )}
      </div>
    </div>
  )
}
