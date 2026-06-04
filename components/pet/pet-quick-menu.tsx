// Shared right-click quick menu for the pet, used by both the in-app floating
// widget (`context="widget"`) and the transparent desktop-pet overlay window
// (`context="overlay"`). It is a dumb shadcn `ContextMenu` wrapper: every action
// is supplied by the caller, so this component owns no pet state. Labels come
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
  // widget-only
  onOpenConsole?(): void
  onToggleDesktopPet?(): void
  onMinimize?(): void
  onOpenSettings?(): void
  // overlay-only
  onClickThrough?(): void
  onHideDesktopPet?(): void
  onShowMainWindow?(): void
}

export interface PetQuickMenuProps {
  context: "widget" | "overlay"
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
  context,
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
      {/* Radix ContextMenu anchors at the pointer and has no `side` prop (unlike
          DropdownMenu); it auto-flips to stay in the viewport. The overlay
          window grows on open (see PetOverlayView.handleMenuOpenChange) to give
          the menu room rather than relying on a fixed side. */}
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => actions.onFeed()}>{t("feed")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onPlay()}>{t("play")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onPet()}>{t("pet")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onTalk()}>{t("talk")}</ContextMenuItem>
        <ContextMenuSeparator />

        {context === "widget" ? (
          <>
            <ContextMenuItem onSelect={() => actions.onOpenConsole?.()}>
              {t("openConsole")}
            </ContextMenuItem>
            {showDesktopPetItems && (
              <ContextMenuItem onSelect={() => actions.onToggleDesktopPet?.()}>
                {desktopPetOpen ? t("hideDesktopPet") : t("showDesktopPet")}
              </ContextMenuItem>
            )}
            <ContextMenuItem onSelect={() => actions.onMinimize?.()}>
              {t("minimize")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => actions.onOpenSettings?.()}>
              {t("openSettings")}
            </ContextMenuItem>
          </>
        ) : (
          <>
            <ContextMenuItem onSelect={() => actions.onClickThrough?.()}>
              {t("clickThrough")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => actions.onHideDesktopPet?.()}>
              {t("hideDesktopPet")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => actions.onShowMainWindow?.()}>
              {t("showMainWindow")}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
