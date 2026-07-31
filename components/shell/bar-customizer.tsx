"use client"

/**
 * Reusable editor for one window bar's layout — the title bar (top) or the
 * status bar (bottom). Renders the shared `CustomizerLists` in its two-bucket
 * mode ("In the bar", drag-reorderable, and "Hidden") wired to `useBarLayout`.
 *
 * Shared by the standalone customize dialog (`components/desktop/bar-customize-dialog.tsx`,
 * opened from either bar's right-click menu and from the Views menu) and the
 * Settings section (`components/settings/sidebar/shell-layout-section.tsx`),
 * which hosts it on a tab beside the nav-rail customizer.
 *
 * Each row carries its zone as a badge. Zones are structural — the title bar's
 * centre is the drag region and its right edge holds the window buttons — so a
 * drag reorders within a zone and one that crosses a boundary lands at the edge
 * of the item's own zone (`resolveBarLayout` normalises it). The badge is what
 * makes that legible instead of surprising.
 */

import * as React from "react"
import { useTranslations } from "next-intl"

import { CustomizerLists, type CustomizerItem } from "./customizer-list"
import { useBarLayout } from "./use-bar-layout"
import { mergeVisibleOrder, type BarCatalogItem } from "@/lib/shell/bar-items"
import type { BarId } from "@/types/shell/bars"

export function BarCustomizer({ bar }: { bar: BarId }): React.ReactElement {
  const t = useTranslations("desktop.barCustomize")
  const { resolved, isDefault, reorder, hide, show, reset } = useBarLayout(bar)

  const toItems = (items: BarCatalogItem[]): CustomizerItem[] =>
    items.map((i) => ({
      id: i.id,
      Icon: i.Icon,
      label: t(`items.${i.i18nKey}`),
      hint: t(`zones.${i.zone}`),
    }))

  return (
    <div className="space-y-3" data-testid={`bar-customizer-${bar}`}>
      <p className="text-xs text-muted-foreground">{t("zoneHint")}</p>
      <CustomizerLists
        testIdPrefix={`bar-customizer-${bar}-list`}
        pinned={toItems(resolved.visible)}
        hidden={toItems(resolved.hidden)}
        isDefault={isDefault}
        labels={{
          restoreDefaults: t("restoreDefaults"),
          pinned: t("inBar"),
          dragHint: t("dragHint"),
          pinnedEmpty: t("inBarEmpty"),
          hidden: t("hidden"),
          hiddenEmpty: t("hiddenEmpty"),
          hideItem: t("hideItem"),
          showItem: t("showItem"),
        }}
        onReorderPinned={(nextVisibleIds) =>
          // `CustomizerLists` only reorders the visible list; the stored order
          // also carries the hidden ids. `mergeVisibleOrder` splices the two
          // back together (and is unit-tested in `lib/shell/bar-items.test.ts`,
          // since jsdom cannot run a real drag).
          void reorder(mergeVisibleOrder(resolved.order, resolved.hidden, nextVisibleIds))
        }
        onHide={(id) => void hide(id)}
        onShow={(id) => void show(id)}
        onReset={() => void reset()}
      />
    </div>
  )
}
