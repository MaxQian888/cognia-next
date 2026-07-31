"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"
import { Keyboard, ScrollTextIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { LogPanel, useLogPanelHeader } from "@/components/logging/log-panel"

/**
 * Dedicated full-page Log Panel route.
 *
 * Users land here from:
 *   - the settings link card under Settings → Observability → Logs
 *   - the tray menu "Open Log Panel" item (emits `tray://open-logs`)
 *   - the View → Open Log Panel application menu item
 *   - the global Ctrl+Shift+L shortcut
 *
 * The page owns the chrome (breadcrumb, live count, preset dropdown, help)
 * and renders `LogPanel` underneath with `hideToolbarPresets` so preset
 * controls don't double up between the header and the inner toolbar.
 */
export default function LogsPage() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-bg-target="chat">
      <LogPanel
        showStats
        showTimeline
        includeAgentTrace={false}
        defaultAutoRefresh={false}
        refreshInterval={2000}
        hideToolbarPresets
        headerSlot={<LogsPageHeader />}
      />
    </div>
  )
}

function LogsPageHeader() {
  const t = useTranslations("logging.panel")
  const api = useLogPanelHeader()
  const liveLabel = t("pageHeader.livePill", {
    filtered: api.filteredCount,
    total: api.totalCount,
  })
  return (
    <FeaturePageHeader
      testId="logs-page-header"
      icon={<ScrollTextIcon />}
      title={t("pageHeader.breadcrumbLogs")}
      breadcrumb={
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href="/">{t("pageHeader.breadcrumbHome")}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{t("pageHeader.breadcrumbLogs")}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      }
      status={
        <Badge
          variant="secondary"
          data-testid="logs-page-header-live-pill"
          className="font-mono text-xs tabular-nums"
        >
          {liveLabel}
        </Badge>
      }
      controls={
        <Select value={api.activePresetId} onValueChange={api.handlePresetChange}>
          <SelectTrigger className="h-8 w-[200px]" data-testid="log-page-header-preset-trigger">
            <SelectValue placeholder={t("presets")} />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value={api.EMPTY_PRESET_VALUE}>{t("noPreset")}</SelectItem>
            {api.presets.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
      actions={
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2"
              data-testid="logs-page-header-help"
              aria-label={t("pageHeader.help")}
              onClick={api.onOpenShortcuts}
            >
              <Keyboard className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("pageHeader.help")}</TooltipContent>
        </Tooltip>
      }
    />
  )
}
