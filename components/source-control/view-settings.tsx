"use client"

/**
 * Quick view knobs for the Source Control panel, shown in the header gear
 * popover — mirrors the Execution Monitor's `MonitorControls`. These are the
 * fast, presentation-level toggles; the full configuration (guardrails, commit
 * automation, auto-fetch, …) lives in Settings → Source Control.
 */

import { useTranslations } from "next-intl"
import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useSourceControlPrefs } from "@/hooks/git/use-source-control-prefs"
import type { BranchSortMode, DiffViewMode, TimelineDefaultView } from "@/lib/git/panel-prefs"

export function SourceControlViewSettings() {
  const t = useTranslations("sourceControl")
  const {
    prefs,
    setDiffView,
    setIgnoreWhitespace,
    setBranchSort,
    setDefaultTimelineView,
    isDefault,
    reset,
  } = useSourceControlPrefs()

  return (
    <div className="space-y-4" data-testid="sc-view-settings">
      <div className="space-y-2">
        <p className="text-xs font-medium">{t("viewSettings.diffView")}</p>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={prefs.diffView}
          onValueChange={(value) => {
            if (value) void setDiffView(value as DiffViewMode)
          }}
          className="w-full"
        >
          <ToggleGroupItem value="sideBySide" className="flex-1 text-[11px]">
            {t("viewSettings.diffMode.sideBySide")}
          </ToggleGroupItem>
          <ToggleGroupItem value="inline" className="flex-1 text-[11px]">
            {t("viewSettings.diffMode.inline")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="sc-ignore-whitespace" className="text-xs font-normal">
          {t("viewSettings.ignoreWhitespace")}
        </Label>
        <Switch
          id="sc-ignore-whitespace"
          checked={prefs.ignoreWhitespace}
          onCheckedChange={(checked) => void setIgnoreWhitespace(checked)}
        />
      </div>

      <Separator />

      <div className="space-y-2">
        <p className="text-xs font-medium">{t("viewSettings.branchSort")}</p>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={prefs.branchSort}
          onValueChange={(value) => {
            if (value) void setBranchSort(value as BranchSortMode)
          }}
          className="w-full"
        >
          <ToggleGroupItem value="default" className="flex-1 text-[11px]">
            {t("viewSettings.branchSortMode.default")}
          </ToggleGroupItem>
          <ToggleGroupItem value="name" className="flex-1 text-[11px]">
            {t("viewSettings.branchSortMode.name")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium">{t("viewSettings.timelineView")}</p>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={prefs.defaultTimelineView}
          onValueChange={(value) => {
            if (value) void setDefaultTimelineView(value as TimelineDefaultView)
          }}
          className="w-full"
        >
          <ToggleGroupItem value="list" className="flex-1 text-[11px]">
            {t("viewSettings.timelineMode.list")}
          </ToggleGroupItem>
          <ToggleGroupItem value="graph" className="flex-1 text-[11px]">
            {t("viewSettings.timelineMode.graph")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <Separator />

      <Button
        size="sm"
        variant="ghost"
        className="h-7 w-full justify-center text-xs"
        disabled={isDefault}
        onClick={() => void reset()}
        data-testid="sc-view-settings-reset"
      >
        <RotateCcw className="mr-1 h-3 w-3" aria-hidden="true" />
        {t("viewSettings.reset")}
      </Button>
    </div>
  )
}
