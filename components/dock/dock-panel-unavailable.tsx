"use client"

/**
 * What a dock tab shows when the thing behind it is gone.
 *
 * Deliberately a placeholder rather than a removal. A plugin being disabled, or
 * a permission being revoked, is usually temporary — and silently deleting the
 * user's tab means that when the plugin comes back its position, its group and
 * its neighbours are gone too. Keeping the tab makes the layout survive the
 * outage, which is the whole reason the instance table is separate from the
 * grid.
 */

import { useTranslations } from "next-intl"
import { AlertTriangleIcon, PlugZapIcon, ShieldOffIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

export type DockPanelUnavailableReason = "plugin" | "permission" | "crashed"

interface Props {
  /** Human-readable panel name; falls back to the panel id at the call site. */
  name: string
  reason: DockPanelUnavailableReason
  /** Offered only for a crash — a disabled plugin cannot be retried from here. */
  onRetry?: () => void
}

const ICONS = {
  plugin: PlugZapIcon,
  permission: ShieldOffIcon,
  crashed: AlertTriangleIcon,
} as const

export function DockPanelUnavailable({ name, reason, onRetry }: Props) {
  const t = useTranslations("dock.errors")
  const Icon = ICONS[reason]
  const message =
    reason === "plugin"
      ? t("pluginUnavailable", { name })
      : reason === "permission"
        ? t("permissionRevoked", { name })
        : t("panelCrashed", { name })

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
      data-testid="dock-panel-unavailable"
      data-reason={reason}
    >
      <Icon className="size-5 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">{message}</p>
      {reason === "plugin" ? (
        <p className="text-xs text-muted-foreground">{t("pluginUnavailableHint")}</p>
      ) : null}
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("panelCrashedRetry")}
        </Button>
      ) : null}
    </div>
  )
}
