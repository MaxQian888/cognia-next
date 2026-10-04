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
// never clipped — and dismisses on blur (handled in Rust) or Esc. Rust owns its
// placement: every time the card's size changes this view reports the new
// size and Rust re-places the window against the pet it was opened for.

"use client"

import { useEffect, useRef, useState, type ComponentType } from "react"
import { useTranslations } from "next-intl"
import {
  AppWindowIcon,
  EyeOffIcon,
  MousePointerClickIcon,
  SlidersHorizontalIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useSettingsStore } from "@/stores/settings"
import { usePetStore } from "@/stores/pet/pet-store"
import { DEFAULT_PET_DESKTOP_OVERLAY, DEFAULT_PET_SETTINGS } from "@/types/pet"
import { startPetSettingsFollower, updateDesktopPetSettings } from "@/lib/pet/settings-sync"
import { usePet } from "@/hooks/pet/use-pet"
import { useActiveLive2dModel } from "@/hooks/pet/use-active-live2d-model"
import { useActiveSpritePack } from "@/hooks/pet/use-active-sprite-pack"
import { startOverlayPetBridge, type OverlayPetBridge } from "@/lib/pet/events/cross-window-bridge"
import type { PetBridgeInteractionKind } from "@/lib/pet/events/cross-window-protocol"
import type { PetConsoleTab } from "@/lib/pet/console-tabs"
import { schedulePetWindowReveal } from "@/lib/pet/reveal"
import {
  closePetPopup,
  closePetWindow,
  onPetPopupHidden,
  onPetPopupShown,
  resizePetPopup,
  setPetClickThrough,
  showMainWindow,
} from "@/lib/tauri/pet-window"
import { resolveEffectiveSkin, selectionFromEffectiveSkin } from "./skins/resolve-effective-skin"
import { resolveCharacterSkinSelection } from "@/lib/pet/binding/resolve-skin"
import { PetInteractionPanel } from "./pet-interaction-panel"

/** Extra px around the measured card so its drop-shadow isn't clipped by the
 * window edge (the wrapper centers the card with this much breathing room). */
const SHADOW_MARGIN = 16

type PopupWindowActionId = "click-through" | "settings" | "main-window" | "hide"

interface PopupWindowAction {
  id: PopupWindowActionId
  label: string
  description?: string
  Icon: ComponentType<{ className?: string }>
}

export function PetPopupView() {
  const t = useTranslations("pet.quickMenu")
  const { profile, view } = usePet(undefined)
  const pet = useSettingsStore((s) => s.settings?.petSettings) ?? DEFAULT_PET_SETTINGS
  const cardRef = useRef<HTMLDivElement>(null)

  // Resolve the effective skin so the popup's stat-card avatar matches the
  // floating sprite (Live2D when picked + ready, otherwise SVG) instead of
  // always drawing the SVG mascot.
  const bridgedSelection = usePetStore((s) => s.appearanceSelection)
  const preferredSelection = bridgedSelection ?? resolveCharacterSkinSelection(pet, undefined)
  const { modelId, row: activeModel, coreReady } = useActiveLive2dModel(pet, preferredSelection)
  const { row: activeSpritePack } = useActiveSpritePack(pet, preferredSelection)
  const effectiveSkin = resolveEffectiveSkin(preferredSelection.skinId, {
    coreReady,
    hasActiveModel: Boolean(modelId),
    modelReady: activeModel?.compatibility?.status !== "invalid",
    hasActiveSpritePack: Boolean(activeSpritePack),
  })
  const selection = selectionFromEffectiveSkin(effectiveSkin, {
    modelId,
    packId: activeSpritePack?.id,
  })

  // Paint through to the desktop while mounted (transparent page background).
  useEffect(() => {
    const root = document.documentElement
    root.dataset.petOverlay = "1"
    return () => {
      delete root.dataset.petOverlay
    }
  }, [])

  // The popup webview survives blur-hides for cheap re-show, so it follows the
  // other windows' pet-settings writes rather than rendering its boot copy.
  useEffect(() => startPetSettingsFollower(), [])

  // Reveal the popup only AFTER the first painted frame. Rust creates it
  // `visible(false)` and no longer shows it on the create path, so the user
  // never sees the pre-hydration opaque page background flash inside what must
  // be a transparent window (see `lib/pet/reveal.ts`). Focus after showing so
  // the native blur-to-close behaves exactly like a system context menu.
  useEffect(() => schedulePetWindowReveal({ focus: true }), [])

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
  const send = (kind: PetBridgeInteractionKind, text?: string) =>
    bridgeRef.current?.sendInteraction(kind, text)

  // Esc dismisses the popup (blur dismissal is handled natively in Rust).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void closePetPopup()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Native blur-hide (`pet-popup://hidden`): the window survives for cheap
  // re-show, but the panel's transient UI (expanded talk composer) must not —
  // remount it so the next open starts from the collapsed baseline instead of
  // whatever mid-interaction state the blur froze.
  const [panelSession, setPanelSession] = useState(0)
  useEffect(() => onPetPopupHidden(() => setPanelSession((k) => k + 1)), [])

  // Fit the window to the card's natural size. Rust re-places the window
  // against the pet on every size write (above it, flipped below when there is
  // no room, always on-screen), so the composer opening or closing never runs
  // the popup off the screen or leaves a gap between it and the pet.
  const lastSize = useRef<{ w: number; h: number } | null>(null)
  const fitRef = useRef<() => void>(() => {})
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
    fitRef.current = fit
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    fit()
    return () => {
      ro.disconnect()
      fitRef.current = () => {}
    }
  }, [])

  // A re-show resets the native window to the size estimate (and re-anchors
  // it to wherever the pet is now), while this webview still remembers the
  // card size it last reported, so an unchanged card would never fit again.
  // Forget it and fit now.
  useEffect(
    () =>
      onPetPopupShown(() => {
        lastSize.current = null
        fitRef.current()
      }),
    []
  )

  // Overlay-only window actions. Each closes the popup afterwards so the
  // action feels like selecting a menu item.
  const onClickThrough = () => {
    void setPetClickThrough(true)
    // Merged into the persisted record under the cross-window lock: this
    // window's copy may predate changes made in the main window.
    void updateDesktopPetSettings(() => ({ clickThrough: true }), DEFAULT_PET_DESKTOP_OVERLAY)
    void closePetPopup()
  }
  // Hiding the sprite window also hides this popup (handled in Rust), so no
  // explicit close call is needed here.
  const onHideDesktopPet = () => void closePetWindow()
  const openConsoleTab = (tab: PetConsoleTab) => {
    // Console navigation happens in the main window (it owns the router);
    // raise it first, then dismiss like a menu selection.
    void showMainWindow()
    bridgeRef.current?.sendOpenConsole(tab)
    void closePetPopup()
  }
  const onShowMainWindow = () => {
    void showMainWindow()
    void closePetPopup()
  }

  // Dispatched by id from the click handler, so the list below stays plain
  // render data and no handler that reads a ref travels through it.
  const runWindowAction = (id: PopupWindowActionId) => {
    switch (id) {
      case "click-through":
        return onClickThrough()
      case "settings":
        return openConsoleTab("customize")
      case "main-window":
        return onShowMainWindow()
      case "hide":
        return onHideDesktopPet()
    }
  }
  const windowActions: PopupWindowAction[] = [
    {
      id: "click-through",
      label: t("clickThrough"),
      description: t("clickThroughDescription"),
      Icon: MousePointerClickIcon,
    },
    { id: "settings", label: t("openSettings"), Icon: SlidersHorizontalIcon },
    { id: "main-window", label: t("showMainWindow"), Icon: AppWindowIcon },
    { id: "hide", label: t("hideDesktopPet"), Icon: EyeOffIcon },
  ]

  return (
    <div className="flex min-h-screen w-screen items-center justify-center bg-transparent p-2">
      <div
        ref={cardRef}
        data-testid="pet-popup-card"
        className="w-max rounded-xl border bg-popover p-3 shadow-lg"
      >
        {profile && view ? (
          <PetInteractionPanel
            key={panelSession}
            profile={profile}
            view={view}
            onFeed={() => send("fed")}
            onPlay={() => send("played")}
            onPet={() => send("petted")}
            onTalk={(text) => send("talked", text)}
            onSleep={() => send("slept")}
            onClean={() => send("cleaned")}
            onTreat={() => send("treated")}
            skinId={effectiveSkin}
            selection={selection}
            // No controller in this window: the consume event would be lost.
            showInventory={false}
            // No plugin runtime in this window: the slot could only be empty.
            showPluginActions={false}
            onOpenConsole={openConsoleTab}
          />
        ) : null}
        {/* Window actions: a compact 2×2 grid instead of a stacked list, so
            the card stays short enough to sit above the pet on a small
            screen without flipping below it. */}
        <div
          role="group"
          aria-label={t("windowActions")}
          data-testid="pet-popup-window-actions"
          className="mt-3 grid grid-cols-2 gap-1 border-t pt-3"
        >
          {windowActions.map(({ id, label, description, Icon }) => (
            <Button
              key={id}
              size="sm"
              variant="ghost"
              data-window-action={id}
              title={description}
              aria-description={description}
              className="h-8 min-w-0 justify-start gap-2 px-2 text-xs"
              onClick={() => runWindowAction(id)}
            >
              <Icon className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{label}</span>
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}
