"use client"

/**
 * Editor for the `/discover` category navigation. Renders the shared
 * three-bucket editor (`CustomizerLists`) — Pinned (drag-reorderable), More
 * (overflow), Hidden — wired to `useDiscoverLayout`. Used by the sidebar's
 * own "Customize" dialog and the `/settings?section=discover` section.
 *
 * Mirrors `components/shell/sidebar-customizer.tsx`; only the data source
 * (discover categories vs nav rail) and i18n namespace differ.
 */

import * as React from "react"
import { useTranslations } from "next-intl"
import { CompassIcon } from "lucide-react"

import { CustomizerLists, type CustomizerItem } from "@/components/shell/customizer-list"
import { useDiscoverLayout } from "@/hooks/discover/use-discover-layout"
import { DEFAULT_DISCOVER_LAYOUT, type DiscoverCategory } from "@/lib/discover/categories"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"

export function DiscoverCustomizer(): React.ReactElement {
  const t = useTranslations("discover")
  const { resolved, pin, unpin, hide, show, reorderPinned, reset } = useDiscoverLayout()

  const toItems = (items: DiscoverCategory[]): CustomizerItem[] =>
    items.map((c) => ({
      id: c.id,
      Icon: resolveIcon(c.iconName) ?? CompassIcon,
      label: t(`categories.${c.id}`),
    }))

  const isDefault =
    JSON.stringify({
      pinned: resolved.pinned.map((c) => c.id),
      hidden: resolved.hidden.map((c) => c.id),
    }) === JSON.stringify(DEFAULT_DISCOVER_LAYOUT)

  return (
    <CustomizerLists
      testIdPrefix="discover-customizer"
      pinned={toItems(resolved.pinned)}
      overflow={toItems(resolved.overflow)}
      hidden={toItems(resolved.hidden)}
      isDefault={isDefault}
      labels={{
        restoreDefaults: t("customize.restoreDefaults"),
        pinned: t("customize.pinned"),
        dragHint: t("customize.dragHint"),
        pinnedEmpty: t("customize.pinnedEmpty"),
        more: t("customize.more"),
        moreEmpty: t("customize.moreEmpty"),
        hidden: t("customize.hidden"),
        hiddenEmpty: t("customize.hiddenEmpty"),
        moveToMore: t("customize.moveToMore"),
        hideItem: t("customize.hideItem"),
        pin: t("customize.pin"),
        showItem: t("customize.showItem"),
      }}
      onReorderPinned={(ids) => void reorderPinned(ids)}
      onPin={(id) => void pin(id)}
      onUnpin={(id) => void unpin(id)}
      onHide={(id) => void hide(id)}
      onShow={(id) => void show(id)}
      onReset={() => void reset()}
    />
  )
}
