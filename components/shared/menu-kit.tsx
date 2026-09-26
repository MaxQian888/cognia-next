"use client"

/**
 * One item list, any menu: the primitives an items component renders into.
 *
 * The same actions show up in several menus — a row's "⋯" dropdown and its
 * right-click menu, the title bar's Menubar and its compact dropdown, a nav
 * item's context menu, the mobile action sheet. Each of those surfaces is a
 * different primitive family (Radix DropdownMenu / ContextMenu / Menubar, or a
 * sheet of buttons), but an item list only needs Item, Label, Separator, a
 * submenu and a trailing shortcut. An items component takes a `MenuKit` and
 * renders through it, so every surface offers the same things in the same
 * order from one list:
 *
 * - `components/chat/session-row-menu-items.tsx` — a conversation row
 * - `components/desktop/go-menu-items.tsx` — the Go menu
 * - `components/shell/nav-item-menu.tsx` — a navigation item
 *
 * The mobile sheet kit lives with the sheet
 * (`components/mobile/shell/session-row-sheet-kit.tsx`).
 */

import type { ComponentType, MouseEvent as ReactMouseEvent, ReactNode } from "react"

import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import {
  MenubarItem,
  MenubarLabel,
  MenubarSeparator,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
} from "@/components/ui/menubar"

export interface MenuKitItemProps {
  children?: ReactNode
  disabled?: boolean
  className?: string
  title?: string
  onSelect?: (event: Event) => void
  onClick?: (event: ReactMouseEvent) => void
  /** The current choice in a list (the conversation's folder, its workspace). */
  "aria-current"?: "true"
  "data-testid"?: string
}

export interface MenuKit {
  Item: ComponentType<MenuKitItemProps>
  Label: ComponentType<{ children?: ReactNode; className?: string }>
  Separator: ComponentType
  Sub: ComponentType<{ children?: ReactNode }>
  SubTrigger: ComponentType<{
    children?: ReactNode
    disabled?: boolean
    "data-testid"?: string
  }>
  SubContent: ComponentType<{ children?: ReactNode; className?: string }>
  /** A trailing key hint; a surface without keyboard shortcuts renders nothing. */
  Shortcut: ComponentType<{ children?: ReactNode }>
}

/** Trailing key hint, drawn the way the Radix menus' own `*Shortcut` parts draw it. */
export function MenuShortcut({ children }: { children?: ReactNode }) {
  return (
    <span className="ml-auto pl-4 text-xs tracking-widest text-muted-foreground" aria-hidden>
      {children}
    </span>
  )
}

export const DROPDOWN_MENU_KIT: MenuKit = {
  Item: DropdownMenuItem as ComponentType<MenuKitItemProps>,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  Shortcut: MenuShortcut,
}

export const CONTEXT_MENU_KIT: MenuKit = {
  Item: ContextMenuItem as ComponentType<MenuKitItemProps>,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  Shortcut: MenuShortcut,
}

export const MENUBAR_MENU_KIT: MenuKit = {
  Item: MenubarItem as ComponentType<MenuKitItemProps>,
  Label: MenubarLabel,
  Separator: MenubarSeparator,
  Sub: MenubarSub,
  SubTrigger: MenubarSubTrigger,
  SubContent: MenubarSubContent,
  Shortcut: MenuShortcut,
}
