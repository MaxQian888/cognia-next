"use client"

/**
 * The tray panel's in-place edit mode (ADR-0225 §12): what replaces the glance
 * stack while the user edits. The module list (order, size, visibility, add)
 * is the shared `GlanceLayoutEditor`; around it sit the two panel-only
 * choices that change what the panel looks like right now: whether the
 * delegate bar shows, and the width step. The preset switch stays in the
 * footer, where it lives outside edit mode too.
 *
 * Max height is set by the grip under the card, edit mode or not; the full
 * set of options (scope default, autofocus, the action catalogue) is in
 * Settings › Desktop.
 */

import { useId } from "react"
import { useTranslations } from "next-intl"

import { GlanceLayoutEditor } from "@/components/glance/glance-layout-editor"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { glanceModulesFor } from "@/lib/glance/registry"
import {
  GLANCE_WIDTH_PX,
  GLANCE_WIDTH_STEPS,
  type GlanceLayoutEntry,
  type GlancePanelSettings,
  type GlanceWidthStep,
} from "@/types/glance/layout"

const DESKTOP_MODULES = glanceModulesFor("desktop")

export interface TrayPanelEditModeProps {
  config: GlancePanelSettings
  onEntries: (entries: GlanceLayoutEntry[]) => void
  onDelegateVisible: (visible: boolean) => void
  onWidth: (width: GlanceWidthStep) => void
}

export function TrayPanelEditMode({
  config,
  onEntries,
  onDelegateVisible,
  onWidth,
}: TrayPanelEditModeProps) {
  const t = useTranslations("trayPanel.edit")
  const delegateId = useId()

  return (
    <div className="space-y-3 px-3.5 py-2.5" data-testid="tray-panel-edit-mode">
      <p className="text-[11.5px] text-muted-foreground">{t("hint")}</p>
      <GlanceLayoutEditor
        entries={config.entries}
        onChange={onEntries}
        available={DESKTOP_MODULES}
        density="compact"
      />
      <div className="space-y-2 border-t pt-2.5">
        <div className="flex items-center gap-2">
          <label htmlFor={delegateId} className="min-w-0 flex-1 text-[12.5px]">
            {t("delegate")}
          </label>
          <Switch
            id={delegateId}
            checked={config.showDelegate}
            onCheckedChange={onDelegateVisible}
          />
        </div>
        <div className="flex items-center gap-2">
          <span id={`${delegateId}-width`} className="min-w-0 flex-1 text-[12.5px]">
            {t("width")}
          </span>
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={config.width}
            aria-labelledby={`${delegateId}-width`}
            onValueChange={(value) => {
              if (value) onWidth(value as GlanceWidthStep)
            }}
          >
            {GLANCE_WIDTH_STEPS.map((step) => (
              <ToggleGroupItem
                key={step}
                value={step}
                title={t(`widths.${step}`, { px: GLANCE_WIDTH_PX[step] })}
                aria-label={t(`widths.${step}`, { px: GLANCE_WIDTH_PX[step] })}
                className="h-6 px-2 text-[11px]"
              >
                {t(`widthsShort.${step}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>
    </div>
  )
}
