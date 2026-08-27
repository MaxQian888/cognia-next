"use client"

/**
 * Editor for the Context Workbench's *panel tabs* — the strip inside an
 * activity, one level below the icon column `workbench-customizer.tsx` edits.
 *
 * Rendered under the rail editor on the "Workbench" tab of
 * `shell-layout-customizer.tsx`, so both levels of the same surface are edited
 * in one place rather than behind two entry points the user has to know apart.
 *
 * **One `CustomizerLists` per activity, not one flat list.** A panel's order
 * only means anything relative to its own group — the rail decides which group
 * is in front — so a single list would invite drags that cannot express
 * anything ("move Memory above Preview" is not a thing the UI can honour). The
 * per-activity lists make the unit of ordering visible, and each still commits
 * into the one flat stored order that `resolveOrderedLayout` reads.
 *
 * Hiding removes the *tab*, never the panel: it stays in the workbench's
 * resolved set and the command palette, `Ctrl+Shift+E` and `Ctrl+1..7` still
 * reach it. That fallback is what makes hiding safe to offer.
 */

import * as React from "react"
import { useTranslations } from "next-intl"

import { CustomizerLists, type CustomizerItem } from "./customizer-list"
import { useWorkbenchPanelLayout } from "./use-workbench-panel-layout"
import { WORKBENCH_ACTIVITY_ICONS } from "@/lib/shell/workbench-rail"
import type { WorkbenchPanelCatalogItem } from "@/lib/shell/workbench-panels"
import type { CanonicalContextActivity } from "@/types/context-workbench"
import {
  CANONICAL_CONTEXT_ACTIVITIES,
  CONTEXT_ACTIVITY_RAIL_ORDER,
} from "@/types/context-workbench"
import { resolveWorkbenchPanelLabel } from "@/lib/context-workbench/panel-label"
import { PlugIcon } from "lucide-react"

/** Activity order for the sections, matching the rail's own default order. */
function activitySortIndex(activity: string): number {
  const index = CONTEXT_ACTIVITY_RAIL_ORDER.indexOf(activity)
  return index === -1 ? CONTEXT_ACTIVITY_RAIL_ORDER.length : index
}

export function WorkbenchPanelCustomizer(): React.ReactElement {
  const t = useTranslations("contextWorkbench.customize")
  const activityT = useTranslations("contextWorkbench.activities")
  const panelT = useTranslations()
  const { resolved, isDefault, reorder, hide, show, reset } = useWorkbenchPanelLayout()

  /**
   * A panel's own label key, resolved the same way the workbench resolves it —
   * plugin panels namespace under `plugin.<id>.` and fall back to their literal
   * label when they ship no translation.
   */
  const labelOf = React.useCallback(
    (item: WorkbenchPanelCatalogItem): string => resolveWorkbenchPanelLabel(panelT, item, item.id),
    [panelT]
  )

  /**
   * Heading for one section.
   *
   * Only the host's own activities have a `contextWorkbench.activities.*` key.
   * A plugin invents its activity id at runtime, so that lookup throws
   * MISSING_MESSAGE and takes the whole customizer down — the section is named
   * after the panel that created it instead, matching the rail button.
   */
  const activityHeading = React.useCallback(
    (activity: string, items: WorkbenchPanelCatalogItem[]): string =>
      (CANONICAL_CONTEXT_ACTIVITIES as readonly string[]).includes(activity)
        ? activityT(activity as never)
        : items[0]
          ? labelOf(items[0])
          : activity,
    [activityT, labelOf]
  )

  const toItems = (items: WorkbenchPanelCatalogItem[]): CustomizerItem[] =>
    items.map((item) => ({
      id: item.id,
      Icon: WORKBENCH_ACTIVITY_ICONS[item.activity as CanonicalContextActivity] ?? PlugIcon,
      label: labelOf(item),
    }))

  // Group by activity, then order the sections the way the rail orders its
  // icons — so the customizer reads top-to-bottom in the same sequence the user
  // sees on the rail itself.
  const sections = React.useMemo(() => {
    const byActivity = new Map<
      string,
      { visible: WorkbenchPanelCatalogItem[]; hidden: WorkbenchPanelCatalogItem[] }
    >()
    const bucket = (activity: string) => {
      const existing = byActivity.get(activity)
      if (existing) return existing
      const created = { visible: [], hidden: [] }
      byActivity.set(activity, created)
      return created
    }
    for (const item of resolved.visible) bucket(item.activity).visible.push(item)
    for (const item of resolved.hidden) bucket(item.activity).hidden.push(item)
    return [...byActivity.entries()].sort(
      ([left], [right]) => activitySortIndex(left) - activitySortIndex(right)
    )
  }, [resolved])

  return (
    <div className="space-y-4" data-testid="workbench-panel-customizer">
      <p className="text-xs text-muted-foreground">{t("panelsHint")}</p>
      {sections.map(([activity, group]) => (
        <div key={activity} className="space-y-2" data-testid={`workbench-panels-${activity}`}>
          <p className="text-xs font-medium">
            {activityHeading(activity, [...group.visible, ...group.hidden])}
          </p>
          <CustomizerLists
            testIdPrefix={`workbench-panel-list-${activity}`}
            pinned={toItems(group.visible)}
            hidden={toItems(group.hidden)}
            // One stored layout backs every section, so "restore defaults" is a
            // property of the whole thing rather than of one group — showing it
            // as already-default in a section the user has not touched would be
            // a lie about what the button does.
            isDefault={isDefault}
            labels={{
              restoreDefaults: t("restoreDefaults"),
              pinned: t("panelsShown"),
              dragHint: t("dragHint"),
              pinnedEmpty: t("panelsShownEmpty"),
              hidden: t("hidden"),
              hiddenEmpty: t("hiddenEmpty"),
              hideItem: t("hideItem"),
              showItem: t("showItem"),
            }}
            onReorderPinned={(nextVisibleIds) => {
              // Splice this group's new order back into the single flat list:
              // every other group's ids keep their slots, so reordering
              // "Inspect" cannot disturb "Review".
              const groupIds = new Set([
                ...group.visible.map((item) => item.id),
                ...group.hidden.map((item) => item.id),
              ])
              const untouched = resolved.order
                .map((item) => item.id)
                .filter((id) => !groupIds.has(id))
              const hiddenTail = group.hidden
                .map((item) => item.id)
                .filter((id) => !nextVisibleIds.includes(id))
              void reorder([...untouched, ...nextVisibleIds, ...hiddenTail])
            }}
            onHide={(id) => void hide(id)}
            onShow={(id) => void show(id)}
            onReset={() => void reset()}
          />
        </div>
      ))}
    </div>
  )
}
