// Shared right-click quick menu for the in-app floating pet widget. The desktop
// overlay owns a dedicated popup window, so keeping a second, unreachable menu
// branch here only lets the two interaction surfaces drift. This is a dumb
// shadcn `ContextMenu` wrapper: every action is supplied by the caller. Labels come
// from `pet.quickMenu.*` (next-intl); the trigger is whatever `children` the
// caller passes (the pet body / overlay root) wrapped with `asChild` so the
// right-click target stays the existing element (left-click + drag are
// untouched — Radix `ContextMenu` only reacts to context-menu / right-click).

"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

export interface PetQuickMenuActions {
  onFeed(): void
  onPlay(): void
  onPet(): void
  onTalk(): void
  onSleep(): void
  onClean(): void
  onTreat(): void
  onOpenConsole?(): void
  onToggleDesktopPet?(): void
  onMinimize?(): void
  onOpenSettings?(): void
}

export interface PetQuickMenuProps {
  /** The right-click target (pet body / overlay root). */
  children: ReactNode
  actions: PetQuickMenuActions
  /** Widget: drives the toggle-desktop-pet label (show vs hide). */
  desktopPetOpen?: boolean
  /** Widget: only show the desktop-pet toggle when running under Tauri. */
  showDesktopPetItems?: boolean
  onOpenChange?(open: boolean): void
}

export function PetQuickMenu({
  children,
  actions,
  desktopPetOpen = false,
  showDesktopPetItems = false,
  onOpenChange,
}: PetQuickMenuProps) {
  const t = useTranslations("pet.quickMenu")

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      {/* Radix ContextMenu anchors at the pointer and auto-flips to remain in
          the viewport. */}
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => actions.onFeed()}>{t("feed")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onPlay()}>{t("play")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onPet()}>{t("pet")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onTalk()}>{t("talk")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onSleep()}>{t("sleep")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onClean()}>{t("clean")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onTreat()}>{t("treat")}</ContextMenuItem>
        <ContextMenuSeparator />

        <ContextMenuItem onSelect={() => actions.onOpenConsole?.()}>
          {t("openConsole")}
        </ContextMenuItem>
        {showDesktopPetItems && (
          <ContextMenuItem onSelect={() => actions.onToggleDesktopPet?.()}>
            {desktopPetOpen ? t("hideDesktopPet") : t("showDesktopPet")}
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => actions.onMinimize?.()}>{t("minimize")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onOpenSettings?.()}>
          {t("openSettings")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
