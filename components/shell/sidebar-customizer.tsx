"use client"

/**
 * Reusable editor for the desktop navigation rail (`GuildRail`) layout: which
 * window edge it takes, plus the shared three-bucket editor (`CustomizerLists`)
 * — Pinned (drag-reorderable), More (overflow), Hidden — wired to
 * `useSidebarLayout`. This is the only UI entry point for the rail's side.
 * Mounted on the
 * "Sidebar" tab of `shell-layout-customizer.tsx`, which the standalone dialog
 * (`shell-layout-dialog.tsx`) and the Settings section
 * (`components/settings/sidebar/shell-layout-section.tsx`) both host.
 *
 * The dnd/row plumbing lives in `components/shell/customizer-list.tsx` so the
 * discover category customizer can reuse it verbatim.
 */

import * as React from "react"
import { useTranslations } from "next-intl"
import { PanelLeftIcon, PanelRightIcon } from "lucide-react"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { usePlatform } from "@/hooks/use-platform"
import { CustomizerLists, type CustomizerItem } from "./customizer-list"
import { useSidebarLayout } from "./use-sidebar-layout"
import { DEFAULT_SIDEBAR_LAYOUT, type SidebarSide } from "@/types/shell/sidebar"

export function SidebarCustomizer(): React.ReactElement {
  const t = useTranslations("desktop.guildRail")
  const platform = usePlatform()
  const { resolved, pin, unpin, hide, show, reorderPinned, reset, side, setSide } =
    useSidebarLayout()

  const toItems = (items: typeof resolved.pinned): CustomizerItem[] =>
    items.map((i) => ({ id: i.id, Icon: i.Icon, label: t(i.i18nKey) }))

  // "Restore defaults" is a no-op when the live layout already matches the
  // factory default. Off the desktop shell the desktop-only items are absent
  // from the catalog (but may linger in the stored arrays), so project the
  // factory default onto the visible catalog before comparing.
  const catalogIds = new Set(
    [...resolved.pinned, ...resolved.overflow, ...resolved.hidden].map((i) => i.id)
  )
  const isDefault =
    JSON.stringify({
      pinned: resolved.pinned.map((i) => i.id),
      hidden: resolved.hidden.map((i) => i.id),
    }) ===
    JSON.stringify({
      pinned: DEFAULT_SIDEBAR_LAYOUT.pinned.filter((id) => catalogIds.has(id)),
      hidden: DEFAULT_SIDEBAR_LAYOUT.hidden,
    })

  return (
    <div className="space-y-4">
      {/* Everywhere the rail is a window edge — which is everywhere but the
          mobile shell, where it is the nav drawer's leading column and there is
          no side to choose. Gating this on `tauri` alone was narrower than
          `desktop-app-shell.tsx`, which honours `sidebarSide` for every
          non-mobile platform: the browser build took the new right-edge default
          with no editor to move it back and nothing saying why. */}
      {platform !== "mobile" ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("customize.side")}</p>
          <ToggleGroup
            type="single"
            variant="outline"
            value={side}
            // Radix emits "" when the pressed item is toggled off. The rail has
            // to be somewhere, so treat that as "keep the current edge".
            onValueChange={(next) => {
              if (next) void setSide(next as SidebarSide)
            }}
            data-testid="sidebar-customizer-side"
          >
            <ToggleGroupItem value="left" aria-label={t("customize.sideLeft")}>
              <PanelLeftIcon className="size-4" />
              {t("customize.sideLeft")}
            </ToggleGroupItem>
            <ToggleGroupItem value="right" aria-label={t("customize.sideRight")}>
              <PanelRightIcon className="size-4" />
              {t("customize.sideRight")}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      ) : null}
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
    </div>
  )
}
