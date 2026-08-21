"use client"

/**
 * The Traces-channel toolbar: variable filter bar, time-range picker,
 * auto-refresh cadence + manual refresh, export/import menu, settings, and the
 * edit/lock + reset-layout controls.
 *
 * Everything except the last pair applies to BOTH sub-views — narrowing to one
 * model or widening the range means the same thing whether you are reading the
 * trace list or the panel grid, because they are folds of the same read. Layout
 * editing is grid-only, hence `showLayoutControls`.
 *
 * `compact` is the narrow-container layout, not a viewport breakpoint: expanded,
 * the row needs ~1150px (7 filter dropdowns alone are ~480), which a desktop
 * window only has once the shell rail and the channel list are subtracted from
 * something near 1440. Compact folds the filters behind one trigger, drops the
 * export / edit labels and the "updated Ns ago" readout, and tightens the range
 * + cadence controls — measured, that is 68px of wrapped toolbar down to a
 * single 32px row, and it holds as one row down to ~600px of channel.
 *
 * `dense` is the last step, for a phone: the auto-refresh cadence select is the
 * one control here that already has a second, identical home (Settings →
 * Defaults → refresh, the gear two buttons along), and dropping it is what takes
 * the row count from three to two at 390px. Nothing else is ever hidden — every
 * other control stays on screen at every width, wrapping rather than vanishing.
 *
 * The caller measures; see `TraceWorkspace`.
 */

import { useTranslations } from "next-intl"
import { LockIcon, PencilIcon, RotateCcwIcon, Settings2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { TimeRangePicker } from "./time-range-picker"
import { RefreshSelect } from "./refresh-select"
import { RefreshStatus } from "./refresh-status"
import { ExportMenu } from "./export-menu"
import { VariableFilterBar } from "./variable-filter-bar"
import { DroppedSpansBadge } from "./dropped-spans-badge"
import type { RangePreset } from "@/lib/observability/time-range"
import type { TraceFilters } from "@/lib/observability/filters"
import type { RefreshMs } from "@/stores/observability/observability-store"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import type { TraceRollupRow } from "@/lib/observability/trace-rollup"
import type { DashboardConfig } from "@/lib/observability/dashboard-config"

export interface ObservabilityToolbarProps {
  preset: RangePreset | "custom"
  customSince: number | null
  customUntil: number | null
  refreshMs: RefreshMs
  filters: TraceFilters
  editMode: boolean
  windowSpans: AgentTraceSpan[]
  lastUpdated: number | null
  traces: TraceRollupRow[]
  onPreset: (p: RangePreset) => void
  onCustom: (since: number, until: number) => void
  onRefreshMs: (ms: RefreshMs) => void
  onRefresh: () => void
  onFilters: (f: TraceFilters) => void
  onToggleEdit: () => void
  onResetLayout: () => void
  onOpenSettings: () => void
  buildConfig: () => DashboardConfig
  onImportConfig: (cfg: DashboardConfig) => void
  /** Show edit/lock + reset-layout. Only meaningful on the Dashboard sub-view. */
  showLayoutControls?: boolean
  /** Narrow-container layout — see the file header. */
  compact?: boolean
  /** Phone-width step on top of `compact`: the cadence select folds into the
   * settings sheet, which carries the same control. */
  dense?: boolean
}

export function ObservabilityToolbar(props: ObservabilityToolbarProps) {
  const t = useTranslations("observability.toolbar")
  const dense = props.dense ?? false
  const compact = dense || (props.compact ?? false)
  return (
    <div
      className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
      data-testid="observability-toolbar"
      data-compact={compact ? "true" : "false"}
      data-dense={dense ? "true" : "false"}
    >
      <VariableFilterBar
        windowSpans={props.windowSpans}
        filters={props.filters}
        onChange={props.onFilters}
        collapsed={compact}
      />
      {/* `ml-auto` + `flex-wrap` rather than a `lg:` viewport breakpoint: the
          row's own width is what decides whether these fit beside the filters,
          and the shell rail means the viewport is routinely 300px wider than
          this row. The old `w-full lg:w-auto` forced a second line at EVERY
          container width whenever the viewport was under 1024. */}
      <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
        <DroppedSpansBadge refreshKey={props.lastUpdated} />
        <RefreshStatus
          lastUpdated={props.lastUpdated}
          onRefresh={props.onRefresh}
          compact={compact}
        />
        <TimeRangePicker
          preset={props.preset}
          customSince={props.customSince}
          customUntil={props.customUntil}
          onPreset={props.onPreset}
          onCustom={props.onCustom}
          compact={compact}
        />
        {/* Dense drops it — Settings → Defaults → refresh is the same control. */}
        {!dense && (
          <RefreshSelect value={props.refreshMs} onChange={props.onRefreshMs} compact={compact} />
        )}
        {!compact && <Separator orientation="vertical" className="h-6" />}
        <ExportMenu
          traces={props.traces}
          buildConfig={props.buildConfig}
          onImportConfig={props.onImportConfig}
          compact={compact}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={props.onOpenSettings}
          className="px-2"
          data-testid="open-settings"
          aria-label={t("settings")}
          title={t("settings")}
        >
          <Settings2Icon className="size-3.5" />
        </Button>
        {props.showLayoutControls !== false && (
          <>
            <Button
              variant={props.editMode ? "default" : "outline"}
              size="sm"
              onClick={props.onToggleEdit}
              className={compact ? "px-2" : "gap-1.5"}
              data-testid="toggle-edit"
              aria-pressed={props.editMode}
              aria-label={props.editMode ? t("lock") : t("edit")}
              title={compact ? (props.editMode ? t("lock") : t("edit")) : undefined}
            >
              {props.editMode ? (
                <LockIcon className="size-3.5" />
              ) : (
                <PencilIcon className="size-3.5" />
              )}
              {!compact && (props.editMode ? t("lock") : t("edit"))}
            </Button>
            {props.editMode && (
              <Button
                variant="ghost"
                size="sm"
                onClick={props.onResetLayout}
                className={compact ? "px-2" : "gap-1.5"}
                data-testid="reset-layout"
                aria-label={t("resetLayout")}
                title={compact ? t("resetLayout") : undefined}
              >
                <RotateCcwIcon className="size-3.5" />
                {!compact && t("resetLayout")}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
