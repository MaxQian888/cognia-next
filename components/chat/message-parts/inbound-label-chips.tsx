"use client"

/**
 * Labels plugins attached to an inbound IM message (ADR-0194) — e.g. laya's
 * observe-mode moderation scores — as small chips above the message text.
 * Known keys are translated by the host; others show the plugin's own label
 * (its i18n key when the plugin is loaded, the literal otherwise — a paired
 * companion device never loads plugins). Hidden on deleted rows.
 */

import { useTranslations } from "next-intl"
import { ShieldAlertIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { readInboundLabels } from "@/lib/connectors/inbound-labels"
import { resolvePluginLabel } from "@/lib/plugin/i18n/plugin-label"
import { cn } from "@/lib/utils"
import {
  KNOWN_INBOUND_LABEL_KEYS,
  type InboundLabel,
  type InboundLabelSeverity,
} from "@/types/connectors/inbound-label"

const SEVERITY_CLASS: Record<InboundLabelSeverity, string> = {
  info: "text-muted-foreground",
  warn: "border-amber-500/50 text-amber-700 dark:text-amber-400",
  high: "border-destructive/60 text-destructive",
}

const KNOWN: ReadonlySet<string> = new Set(KNOWN_INBOUND_LABEL_KEYS)

export function InboundLabelChips({
  metadata,
  className,
}: {
  metadata: Record<string, unknown> | undefined
  className?: string
}) {
  const t = useTranslations("inboundLabels")
  const tRoot = useTranslations()
  if (!metadata || metadata.deletedAt !== undefined) return null
  const labels = readInboundLabels(metadata.inboundLabels)
  if (!labels.length) return null

  const text = (label: InboundLabel) =>
    KNOWN.has(label.key)
      ? t(`keys.${label.key}`)
      : resolvePluginLabel(tRoot, label.source, label.labelKey, label.label)

  return (
    <div
      className={cn("flex flex-wrap items-center gap-1", className)}
      role="list"
      aria-label={t("ariaLabel")}
      data-testid="inbound-label-chips"
    >
      {labels.map((label) => (
        <Tooltip key={`${label.source}:${label.key}`}>
          <TooltipTrigger asChild>
            <Badge
              role="listitem"
              variant="outline"
              className={cn("gap-1 text-[11px] font-normal", SEVERITY_CLASS[label.severity])}
            >
              <ShieldAlertIcon className="size-3" aria-hidden />
              {text(label)} · {Math.round(label.score * 100)}%
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t("tooltip", { source: label.source, score: Math.round(label.score * 100) })}</p>
            {label.note ? <p className="text-muted-foreground">{label.note}</p> : null}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
