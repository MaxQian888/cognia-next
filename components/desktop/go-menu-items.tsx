"use client"

/**
 * The Go menu's destinations, as menu items.
 *
 * Rendered twice by `TitleBar` — into the wide window's Menubar and into the
 * compact window's hamburger dropdown — by handing over the matching
 * primitives (`components/shared/menu-kit.tsx`, the kit pattern
 * `components/chat/session-row-menu-items.tsx` uses). Both read the
 * one table in `lib/desktop/go-menu.ts`, which the native menu
 * (`src-tauri/src/menu.rs`) mirrors, so the three Go menus can never offer
 * different destinations or orders.
 *
 * Labels are the rail's (`desktop.guildRail.*`) and so are the icons. No item
 * shows a shortcut: the Go menu has none (⌘1–⌘7 belong to the workbench
 * activities; pinned rail destinations have ⌥1–⌥9).
 */

import { Fragment } from "react"
import { useTranslations } from "next-intl"

import type { MenuKit } from "@/components/shared/menu-kit"
import { GO_MENU_SECTIONS, type GoMenuId } from "@/lib/desktop/go-menu"

export interface GoMenuItemsProps {
  /** `DROPDOWN_MENU_KIT` or `MENUBAR_MENU_KIT` from `components/shared/menu-kit.tsx`. */
  kit: Pick<MenuKit, "Item" | "Label" | "Separator">
  /** Distinguishes the two renders in test ids (`go-menu-<surface>-<id>`). */
  surface: "menubar" | "dropdown"
  /**
   * The select handler for one destination — `TitleBar`'s curried
   * `handleGo(id)`, which dispatches through `goAction`.
   */
  handlerFor: (id: GoMenuId) => () => void
  /**
   * Lead with a "Go" label. The dropdown needs it (it is one long menu of
   * labelled sections); the Menubar does not (its trigger already says Go).
   */
  withLabel?: boolean
}

export function GoMenuItems({ kit, surface, handlerFor, withLabel = false }: GoMenuItemsProps) {
  const tRail = useTranslations("desktop.guildRail")
  const tMenu = useTranslations("desktop.menu")
  const { Item, Label, Separator } = kit
  return (
    <>
      {withLabel ? <Label>{tMenu("go.label")}</Label> : null}
      {GO_MENU_SECTIONS.map((section, index) => (
        <Fragment key={section[0]?.id ?? index}>
          {index > 0 ? <Separator /> : null}
          {section.map(({ id, labelKey, Icon }) => (
            <Item key={id} onSelect={handlerFor(id)} data-testid={`go-menu-${surface}-${id}`}>
              <Icon aria-hidden />
              {tRail(labelKey)}
            </Item>
          ))}
        </Fragment>
      ))}
    </>
  )
}
