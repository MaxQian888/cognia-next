"use client"

/**
 * Reusable editor for the desktop left-rail (`GuildRail`) layout. Renders the
 * shared three-bucket editor (`CustomizerLists`) — Pinned (drag-reorderable),
 * More (overflow), Hidden — wired to `useSidebarLayout`. Shared by the
 * standalone customize dialog (`sidebar-customize-dialog.tsx`) and the Settings
 * section (`components/settings/sidebar/sidebar-section.tsx`).
 *
 * The dnd/row plumbing lives in `components/shell/customizer-list.tsx` so the
 * discover category customizer can reuse it verbatim.
 */

import * as React from "react"
import { useTranslations } from "next-intl"

import { CustomizerLists, type CustomizerItem } from "./customizer-list"
import { useSidebarLayout } from "./use-sidebar-layout"
import { DEFAULT_SIDEBAR_LAYOUT } from "@/types/shell/sidebar"

export function SidebarCustomizer(): React.ReactElement {
  const t = useTranslations("desktop.guildRail")
  const { resolved, pin, unpin, hide, show, reorderPinned, reset } = useSidebarLayout()

  const toItems = (items: typeof resolved.pinned): CustomizerItem[] =>
    items.map((i) => ({ id: i.id, Icon: i.Icon, label: t(i.i18nKey) }))

  // "Restore defaults" is a no-op when the live layout already matches the
  // factory default. On mobile the desktop-only items are absent from the
  // catalog but may linger in the stored arrays, so compare the resolved
  // pinned ids instead of raw arrays.
  const isDefault =
    JSON.stringify({
      pinned: resolved.pinned.map((i) => i.id),
      hidden: resolved.hidden.map((i) => i.id),
    }) === JSON.stringify(DEFAULT_SIDEBAR_LAYOUT)

  return (
    <CustomizerLists
      testIdPrefix="sidebar-customizer"
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
