// The desktop-pet click popup window's root view. Rendered by
// `app/pet-popup/page.tsx` inside the frameless always-on-top "pet-popup" Tauri
// window (window role "popup"), opened when the user right-clicks the sprite.
//
// This is a thin shell over the existing `PetInteractionPanel` (the same panel
// the in-app widget shows when expanded) plus a small row of overlay-only window
// actions. It owns no pet controller: profile/view flow in via Dexie
// `useLiveQuery` (cross-window reactive), and interactions are posted back to the
// main window over the cross-window bridge, which awards XP exactly once.
//
// Why its own window: the sprite window no longer grows/shifts to make room for
// a menu (that resize raced the menu anchor and the wander/throw position
// writes). The popup renders at its natural size in a dedicated OS window —
// never clipped — and dismisses on blur (handled in Rust) or Esc.

"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_PET_DESKTOP_OVERLAY, DEFAULT_PET_SETTINGS } from "@/types/pet"
import { usePet } from "@/hooks/pet/use-pet"
import { startOverlayPetBridge, type OverlayPetBridge } from "@/lib/pet/events/cross-window-bridge"
import {
  closePetPopup,
  closePetWindow,
  resizePetPopup,
  setPetClickThrough,
  showMainWindow,
} from "@/lib/tauri/pet-window"
import { PetInteractionPanel } from "./pet-interaction-panel"

/** Extra px around the measured card so its drop-shadow isn't clipped by the
 * window edge (the wrapper centers the card with this much breathing room). */
const SHADOW_MARGIN = 16

export function PetPopupView() {
  const t = useTranslations("pet.quickMenu")
  const { profile, view } = usePet(undefined)
  const pet = useSettingsStore((s) => s.settings?.petSettings) ?? DEFAULT_PET_SETTINGS
  const save = useSettingsStore((s) => s.save)
  const cardRef = useRef<HTMLDivElement>(null)

  // Paint through to the desktop while mounted (transparent page background).
  useEffect(() => {
    const root = document.documentElement
    root.dataset.petOverlay = "1"
    return () => {
      delete root.dataset.petOverlay
    }
  }, [])

  // Cross-window bridge: post interactions back to the main window. Held in a
  // ref so the panel callbacks don't re-bind every render.
  const bridgeRef = useRef<OverlayPetBridge | null>(null)
  useEffect(() => {
    const bridge = startOverlayPetBridge()
    bridgeRef.current = bridge
    return () => {
      bridge.dispose()
      bridgeRef.current = null
    }
  }, [])
  const send = (kind: "fed" | "played" | "petted" | "talked", text?: string) =>
    bridgeRef.current?.sendInteraction(kind, text)

  // Esc dismisses the popup (blur dismissal is handled natively in Rust).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void closePetPopup()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Fit the window to the card's natural size — SIZE ONLY, never reposition, so
  // the popup stays put (the whole reason for the separate window). The talk
  // composer toggling open/closed changes the card height; the observer grows
  // the window from its fixed top-left. A pure size write can't race a position.
  const lastSize = useRef<{ w: number; h: number } | null>(null)
  useEffect(() => {
    const el = cardRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const fit = () => {
      const w = Math.ceil(el.offsetWidth) + SHADOW_MARGIN
      const h = Math.ceil(el.offsetHeight) + SHADOW_MARGIN
      if (w <= SHADOW_MARGIN || h <= SHADOW_MARGIN) return
      const prev = lastSize.current
      if (prev && prev.w === w && prev.h === h) return
      lastSize.current = { w, h }
      void resizePetPopup(w, h)
    }
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    fit()
    return () => ro.disconnect()
  }, [])

  // Overlay-only window actions (mirror the overlay quick menu). Each closes the
  // popup afterwards so the action feels like selecting a menu item.
  const onClickThrough = () => {
    void setPetClickThrough(true)
    const desktop = pet.desktopPet ?? DEFAULT_PET_DESKTOP_OVERLAY
    void save({ petSettings: { ...pet, desktopPet: { ...desktop, clickThrough: true } } })
    void closePetPopup()
  }
  // Hiding the sprite window also hides this popup (handled in Rust), so no
  // explicit close call is needed here.
  const onHideDesktopPet = () => void closePetWindow()
  const onShowMainWindow = () => {
    void showMainWindow()
    void closePetPopup()
  }

  return (
    <div className="flex min-h-screen w-screen items-center justify-center bg-transparent p-2">
      <div
        ref={cardRef}
        data-testid="pet-popup-card"
        className="w-max rounded-xl border bg-popover p-3 shadow-lg"
      >
        {profile && view ? (
          <PetInteractionPanel
            profile={profile}
            view={view}
            onFeed={() => send("fed")}
            onPlay={() => send("played")}
            onPet={() => send("petted")}
            onTalk={(text) => send("talked", text)}
          />
        ) : null}
        <div className="mt-3 flex flex-col gap-1 border-t pt-3">
          <Button size="sm" variant="ghost" className="justify-start" onClick={onClickThrough}>
            {t("clickThrough")}
          </Button>
          <Button size="sm" variant="ghost" className="justify-start" onClick={onHideDesktopPet}>
            {t("hideDesktopPet")}
          </Button>
          <Button size="sm" variant="ghost" className="justify-start" onClick={onShowMainWindow}>
            {t("showMainWindow")}
          </Button>
        </div>
      </div>
    </div>
  )
}
