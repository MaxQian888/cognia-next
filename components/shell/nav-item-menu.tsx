"use client"

/**
 * One shell nav item's right-click menu — a pinned feature or a workspace
 * mode (Canvas, a plugin view container).
 *
 * The icon rail (`guild-rail.tsx`) and the expanded sidebar's hosted rows
 * (`sidebar-nav-section.tsx`) draw the same destinations, so they offer the
 * same menu: one item list (`NavItemMenuItems`) rendered through a menu kit
 * (`components/shared/menu-kit.tsx`), and one trigger
 * (`NavItemContextMenu`) that doubles as the drag handle. The actions arrive
 * already bound to the item from `useShellNavModel` (`modeMenu` /
 * `pinnedMenu`), so neither surface wires a handler of its own:
 *
 *   Move up · Move down        ← the keyboard path for a drag; ends disabled
 *   ─────
 *   Move to More (pins only) · Hide
 *   ─────
 *   Customize navigation
 */

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EyeOffIcon,
  PinOffIcon,
  SlidersHorizontalIcon,
} from "lucide-react"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu"
import { CONTEXT_MENU_KIT, type MenuKit } from "@/components/shared/menu-kit"
import { cn } from "@/lib/utils"
import type { NavDragBinding } from "./nav-sortable"
import type { ShellNavItemMenu } from "./use-shell-nav"

export interface NavItemMenuItemsProps extends ShellNavItemMenu {
  /** The Radix primitives to render into (`CONTEXT_MENU_KIT`, `DROPDOWN_MENU_KIT`, …). */
  kit: Pick<MenuKit, "Item" | "Separator">
  /** Each item's test id is `${testIdPrefix}-<action>`. */
  testIdPrefix: string
}

export function NavItemMenuItems({
  kit: { Item, Separator },
  testIdPrefix,
  canMoveUp,
  canMoveDown,
  onMove,
  onMoveToMore,
  onHide,
  onCustomize,
}: NavItemMenuItemsProps) {
  const t = useTranslations("desktop.guildRail")
  return (
    <>
      <Item
        disabled={!canMoveUp}
        onSelect={() => onMove(-1)}
        data-testid={`${testIdPrefix}-move-up`}
      >
        <ArrowUpIcon className="size-4" />
        {t("moveTeamUp")}
      </Item>
      <Item
        disabled={!canMoveDown}
        onSelect={() => onMove(1)}
        data-testid={`${testIdPrefix}-move-down`}
      >
        <ArrowDownIcon className="size-4" />
        {t("moveTeamDown")}
      </Item>
      <Separator />
      {onMoveToMore ? (
        <Item onSelect={onMoveToMore} data-testid={`${testIdPrefix}-unpin`}>
          <PinOffIcon className="size-4" />
          {t("customize.moveToMore")}
        </Item>
      ) : null}
      <Item onSelect={onHide} data-testid={`${testIdPrefix}-hide`}>
        <EyeOffIcon className="size-4" />
        {t("customize.hideItem")}
      </Item>
      <Separator />
      <Item onSelect={onCustomize} data-testid={`${testIdPrefix}-customize`}>
        <SlidersHorizontalIcon className="size-4" />
        {t("customize.title")}
      </Item>
    </>
  )
}

export interface NavItemContextMenuProps extends ShellNavItemMenu {
  drag: NavDragBinding
  /** The menu's own test id; its items append `-<action>`. */
  menuTestId: string
  children: ReactNode
}

/**
 * Context menu + drag handle around one nav item. The `div` is both the
 * `ContextMenuTrigger`'s single ref-forwarding child and the element dnd-kit
 * moves, so the item inside (a rail button, a sidebar row) stays a plain
 * button.
 */
export function NavItemContextMenu({
  drag: { setNodeRef, style, dragging, handleProps },
  menuTestId,
  children,
  ...actions
}: NavItemContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={style}
          {...handleProps}
          className={cn(dragging && "relative z-10 opacity-50")}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent data-testid={menuTestId}>
        <NavItemMenuItems kit={CONTEXT_MENU_KIT} testIdPrefix={menuTestId} {...actions} />
      </ContextMenuContent>
    </ContextMenu>
  )
}
