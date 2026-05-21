"use client"

// Empty state for the detail pane — what the user sees when no plugin is
// selected. Shows a high-level summary (totals / enabled / updates /
// errored) so the pane still earns its screen real estate when idle.
// Reuses `components/ui/empty.tsx` for visual consistency with the rest
// of the app's empty states.

import { useTranslations } from "next-intl"
import { BoxesIcon } from "lucide-react"
import { usePlugins } from "@/hooks/plugins"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Badge } from "@/components/ui/badge"

export function PluginDetailEmpty() {
  const t = useTranslations("plugins.detail")
  const { totals } = usePlugins()

  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BoxesIcon />
        </EmptyMedia>
        <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
        <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex flex-wrap items-center justify-center gap-2 text-xs">
          <Badge variant="outline">{t("summaryTotal", { count: totals.total })}</Badge>
          <Badge variant="secondary">{t("summaryEnabled", { count: totals.enabled })}</Badge>
          {totals.updateAvailable > 0 && (
            <Badge variant="outline">
              {t("summaryUpdates", { count: totals.updateAvailable })}
            </Badge>
          )}
          {totals.errored > 0 && (
            <Badge variant="destructive">{t("summaryErrored", { count: totals.errored })}</Badge>
          )}
        </div>
      </EmptyContent>
    </Empty>
  )
}
