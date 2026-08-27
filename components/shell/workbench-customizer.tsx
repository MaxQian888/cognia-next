"use client"

/**
 * Reusable editor for the Context Workbench activity rail — the icon column
 * inside the right-hand workbench. Renders the shared `CustomizerLists` in its
 * two-bucket mode ("On the rail", drag-reorderable, and "Hidden") wired to
 * `useWorkbenchRailLayout`.
 *
 * Mounted on the "Workbench" tab of `shell-layout-customizer.tsx`, which the
 * standalone dialog (`shell-layout-dialog.tsx`) and the Settings section
 * (`components/settings/sidebar/shell-layout-section.tsx`) both host — the same
 * two entry points as the nav-rail and window-bar customizers.
 *
 * It exists because the two icon columns now sit side by side on the right
 * edge, and one of them being reorderable while the other was a hardcoded
 * constant read as a bug rather than a design.
 *
 * Two further customizations are modelled and persisted but have no reader yet
 * — `WorkbenchRailLayout.groups` and `AppSettings.workbenchRailPerProject`. Both
 * are surfaced here as disabled rows carrying a "planned" badge and a reason,
 * following `components/settings/external-bridge/panels/scopes-panel.tsx`:
 * documenting dormancy at the type while the UI stays silent is exactly the
 * shape Working Rule 7 exists to prevent. Pinned by the test beside this file.
 */

import * as React from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { CustomizerLists, type CustomizerItem } from "./customizer-list"
import { useWorkbenchRailLayout, useWorkbenchRailPersistent } from "./use-workbench-rail-layout"
import { mergeVisibleOrder } from "@/lib/shell/bar-items"
import type { WorkbenchRailCatalogItem } from "@/lib/shell/workbench-rail"
import { resolvePluginWorkbenchLabel } from "@/lib/context-workbench/panel-label"

/** A modelled-but-unbuilt customization: disabled control, badge, and a reason. */
function PlannedRow({
  id,
  label,
  reason,
  badge,
}: {
  id: string
  label: string
  reason: string
  badge: string
}): React.ReactElement {
  return (
    <div
      className="flex items-start justify-between gap-3 rounded-md border border-dashed bg-muted/30 p-3"
      data-testid={`workbench-planned-${id}`}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Label className="text-sm">{label}</Label>
          <Badge variant="outline" className="text-[10px]">
            {badge}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{reason}</p>
      </div>
      <Switch checked={false} disabled aria-label={label} />
    </div>
  )
}

export function WorkbenchCustomizer(): React.ReactElement {
  const t = useTranslations("contextWorkbench.customize")
  const activityT = useTranslations("contextWorkbench.activities")
  const panelT = useTranslations()
  const { resolved, isDefault, reorder, hide, show, reset } = useWorkbenchRailLayout()
  const persistentRail = useWorkbenchRailPersistent()
  const save = useSettingsStore((s) => s.save)

  /**
   * Label one catalog row.
   *
   * Canonical activities translate from their id. A plugin-contributed one has
   * no `contextWorkbench.activities.*` key at all, so it goes through the shared
   * resolver in `lib/context-workbench/panel-label.ts` — plugin overlay key
   * first, then the literal label the plugin registered.
   */
  const labelOf = (item: WorkbenchRailCatalogItem): string =>
    item.pluginId
      ? resolvePluginWorkbenchLabel(panelT, item, String(item.id))
      : activityT(item.id as never)

  const toItems = (items: WorkbenchRailCatalogItem[]): CustomizerItem[] =>
    items.map((i) => ({ id: i.id, Icon: i.Icon, label: labelOf(i) }))

  return (
    <div className="space-y-3" data-testid="workbench-customizer">
      {/* Sits above the order editor because it decides whether that rail is on
          screen at all when the workbench is shut. */}
      <div className="flex items-start justify-between gap-3 rounded-md border p-3">
        <div className="space-y-1">
          <Label htmlFor="workbench-persistent-rail" className="text-sm">
            {t("persistentRail")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("persistentRailHint")}</p>
        </div>
        <Switch
          id="workbench-persistent-rail"
          data-testid="workbench-persistent-rail"
          checked={persistentRail}
          onCheckedChange={(checked) => void save({ workbenchRailPersistent: checked })}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t("hint")}</p>
      <CustomizerLists
        testIdPrefix="workbench-customizer-list"
        pinned={toItems(resolved.visible)}
        hidden={toItems(resolved.hidden)}
        isDefault={isDefault}
        labels={{
          restoreDefaults: t("restoreDefaults"),
          pinned: t("onRail"),
          dragHint: t("dragHint"),
          pinnedEmpty: t("onRailEmpty"),
          hidden: t("hidden"),
          hiddenEmpty: t("hiddenEmpty"),
          hideItem: t("hideItem"),
          showItem: t("showItem"),
        }}
        onReorderPinned={(nextVisibleIds) =>
          // `CustomizerLists` only reorders the visible list; the stored order
          // also carries the hidden ids. `mergeVisibleOrder` splices the two
          // back together — shared with the window bars, and unit-tested in
          // `lib/shell/bar-items.test.ts` since jsdom cannot run a real drag.
          void reorder(mergeVisibleOrder(resolved.order, resolved.hidden, nextVisibleIds))
        }
        onHide={(id) => void hide(id)}
        onShow={(id) => void show(id)}
        onReset={() => void reset()}
      />
      {/* Below the editor, not above it: these are not settings the user can
          act on, and putting them first would push the working control off the
          first screen of a 60vh dialog. */}
      <PlannedRow
        id="groups"
        label={t("groups")}
        reason={t("groupsPlannedReason")}
        badge={t("plannedBadge")}
      />
      <PlannedRow
        id="per-project"
        label={t("perProject")}
        reason={t("perProjectPlannedReason")}
        badge={t("plannedBadge")}
      />
    </div>
  )
}
