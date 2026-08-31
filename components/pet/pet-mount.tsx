// App-wide mount point for the pet widget. Reads the pet settings, gates the
// whole subsystem on `enabled`, wires the event bus, and lazily ensures the
// profile exists (resolving / persisting the deterministic account seed). Mounted
// once in `app/layout.tsx`.

"use client"

import { useEffect, useMemo } from "react"
import { useRouter } from "next/navigation"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_PET_DESKTOP_OVERLAY, DEFAULT_PET_SETTINGS } from "@/types/pet"
import { usePetEventBus } from "@/hooks/pet/use-pet-event-bus"
import { useActiveCharacterId } from "@/hooks/pet/use-active-character-id"
import { useActivityTracker } from "@/hooks/pet/use-activity-tracker"
import { usePetCareAlert } from "@/hooks/pet/use-pet-care-alert"
import { ensurePetAccountId } from "@/lib/pet/bones/account-id"
import { ensurePetProfile } from "@/lib/pet/runtime/init-pet"
import { registerPetInteractionCommands, registerPetWindowCommand } from "@/lib/pet/commands"
import { getPetWindowRole, isSecondaryOverlayRole } from "@/lib/pet/window-role"
import { overlayWindowSize } from "@/lib/pet/overlay-geometry"
import {
  isPetWindowOpen,
  onPetNativeStateChanged,
  openPetWindow,
  setPetClickThrough,
} from "@/lib/tauri/pet-window"
import { isTauri } from "@/lib/platform/detect"
import { usePlatform } from "@/hooks/use-platform"
import { startMainPetBridge } from "@/lib/pet/events/cross-window-bridge"
import { PetWidget } from "./pet-widget"

export function PetMount() {
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const pet = settings?.petSettings ?? DEFAULT_PET_SETTINGS
  const enabled = pet.enabled
  const activeCharacterId = useActiveCharacterId()

  // Resolve the window role once: the shared root layout mounts PetMount in
  // every webview, but the controller (event bus + XP awards) and the widget
  // must live only in the main window. Both secondary pet windows — the
  // transparent overlay (`/pet-overlay`, label "pet") and the click popup
  // (`/pet-popup`, label "pet-popup") — render presentation only, so here they
  // must contribute nothing; otherwise XP double-awards.
  const role = useMemo(() => getPetWindowRole(), [])
  const secondary = isSecondaryOverlayRole(role)

  // The floating in-app widget is a desktop / web affordance only. On the
  // Capacitor mobile shell it would dock to a viewport corner with a 96px hit
  // area that sits on top of page content — most visibly covering bottom-right
  // action buttons (e.g. the preset editor's Save / Create), which is then
  // untappable. Exclude the whole subsystem on mobile, mirroring the Perf HUD.
  const isMobile = usePlatform() === "mobile"
  const widgetEnabled = enabled && !secondary && !isMobile
  // The main desktop window — where the global-hotkey → command dispatch lives.
  // Independent of `enabled`: the toggle-window hotkey must summon the pet even
  // when the widget is currently off.
  const isMainDesktopWindow = !secondary && !isMobile && isTauri()
  const desktopPet = pet.desktopPet ?? DEFAULT_PET_DESKTOP_OVERLAY

  usePetEventBus(widgetEnabled, pet.twinAwareness)
  // User-activity signal (Smart-Moving): feeds the proactive idle trigger and
  // pings the overlay's wander gate over the bridge (throttled).
  useActivityTracker(widgetEnabled)
  // Gentle care notification when the pet first becomes unwell (main window only).
  usePetCareAlert(widgetEnabled)

  useEffect(() => {
    if (!widgetEnabled) return
    let cancelled = false
    void (async () => {
      const accountId = await ensurePetAccountId(settings, save)
      if (cancelled) return
      await ensurePetProfile(accountId)
    })()
    return () => {
      cancelled = true
    }
  }, [widgetEnabled, settings, save])

  // Main window owns the cross-window bridge: it broadcasts the controller's
  // visual-state/bubble/one-shots and replays overlay interactions (including
  // the popup's "open the /pet console at a tab" request — routed here because
  // only this window has the app router). Pointless on the web (single
  // browsing context), so gate on Tauri.
  const router = useRouter()
  useEffect(() => {
    if (!widgetEnabled || !isTauri()) return
    const dispose = startMainPetBridge({
      onOpenConsole: (tab) => router.push(`/pet?tab=${tab}`),
    })
    return dispose
  }, [widgetEnabled, router])

  // The desktop-pet toggle command backs a global hotkey / tray quick action.
  // Register it on the main desktop window regardless of `enabled` so a chord
  // the user bound stays live (and isn't reserved-but-dead) when the pet is off.
  useEffect(() => {
    if (!isMainDesktopWindow) return
    return registerPetWindowCommand()
  }, [isMainDesktopWindow])

  // Reconcile persisted intent after a cold start. The native window is
  // process-local, so `desktopPet.enabled` can survive a restart while no
  // `pet` webview exists. Probe first and open ONLY when nothing is there:
  // `open_pet_window_claimed`'s existing-window branch reveals the panel and
  // emits `pet://resume`, so calling it unconditionally would re-raise the
  // overlay and restart its animation loops on every settings write. It also
  // ignores `opts.x`/`opts.y` (it re-derives placement from the window's own
  // position), so re-opening on a position change raises the pet without even
  // applying the change that triggered it — hence `position` is an input to
  // the FIRST open only and is deliberately not a dependency here.
  useEffect(() => {
    if (!isMainDesktopWindow || !widgetEnabled || !desktopPet.enabled) return
    let cancelled = false
    void isPetWindowOpen().then((open) => {
      if (cancelled || open) return
      void openPetWindow({
        ...overlayWindowSize(desktopPet.size),
        x: desktopPet.position?.x,
        y: desktopPet.position?.y,
        clickThrough: desktopPet.clickThrough,
      })
    })
    return () => {
      cancelled = true
    }
    // `desktopPet.position` seeds the first open and must not re-trigger it —
    // see the note above this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    desktopPet.clickThrough,
    desktopPet.enabled,
    desktopPet.size,
    isMainDesktopWindow,
    widgetEnabled,
  ])

  // Click-through has a dedicated native command that does not reveal or raise
  // the window, so it is the one overlay setting that can be reconciled live.
  // Size has no such command; it applies on the next open, as it did before.
  useEffect(() => {
    if (!isMainDesktopWindow || !widgetEnabled || !desktopPet.enabled) return
    let cancelled = false
    void isPetWindowOpen().then((open) => {
      if (cancelled || !open) return
      void setPetClickThrough(desktopPet.clickThrough)
    })
    return () => {
      cancelled = true
    }
  }, [desktopPet.clickThrough, desktopPet.enabled, isMainDesktopWindow, widgetEnabled])

  // Keep PetSettings in sync with NATIVE window mutations the renderer didn't
  // initiate (tray toggle, tray click-through recovery): the Rust side
  // broadcasts `pet://state-changed` on every open/close/click-through change;
  // patch only on real drift so renderer-initiated changes (which already
  // persisted) don't loop. Independent of `enabled` — a tray open must land in
  // settings even while the widget is off.
  useEffect(() => {
    if (!isMainDesktopWindow) return
    return onPetNativeStateChanged((native) => {
      const store = useSettingsStore.getState()
      const latest = store.settings?.petSettings
      if (!latest) return
      const desktop = latest.desktopPet ?? DEFAULT_PET_DESKTOP_OVERLAY
      if (desktop.enabled === native.open && desktop.clickThrough === native.clickThrough) return
      void store.save({
        petSettings: {
          ...latest,
          desktopPet: {
            ...desktop,
            enabled: native.open,
            clickThrough: native.clickThrough,
          },
        },
      })
    })
  }, [isMainDesktopWindow])

  // Feed/play/pet need the running controller, so gate them on the widget.
  useEffect(() => {
    if (!widgetEnabled) return
    return registerPetInteractionCommands()
  }, [widgetEnabled])

  if (!widgetEnabled) return null
  return <PetWidget settings={pet} activeCharacterId={activeCharacterId} />
}
