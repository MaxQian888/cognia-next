// App-wide mount point for the pet widget. Reads the pet settings, gates the
// whole subsystem on `enabled`, wires the event bus, and lazily ensures the
// profile exists (resolving / persisting the deterministic account seed). Mounted
// once in `app/layout.tsx`.

"use client"

import { useEffect, useMemo } from "react"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_PET_SETTINGS } from "@/types/pet"
import { usePetEventBus } from "@/hooks/pet/use-pet-event-bus"
import { useActiveCharacterId } from "@/hooks/pet/use-active-character-id"
import { useActivityTracker } from "@/hooks/pet/use-activity-tracker"
import { usePetCareAlert } from "@/hooks/pet/use-pet-care-alert"
import { ensurePetAccountId } from "@/lib/pet/bones/account-id"
import { ensurePetProfile } from "@/lib/pet/runtime/init-pet"
import { getPetWindowRole } from "@/lib/pet/window-role"
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
  const secondary = role === "overlay" || role === "popup"

  // The floating in-app widget is a desktop / web affordance only. On the
  // Capacitor mobile shell it would dock to a viewport corner with a 96px hit
  // area that sits on top of page content — most visibly covering bottom-right
  // action buttons (e.g. the preset editor's Save / Create), which is then
  // untappable. Exclude the whole subsystem on mobile, mirroring the Perf HUD.
  const isMobile = usePlatform() === "mobile"
  const widgetEnabled = enabled && !secondary && !isMobile

  usePetEventBus(widgetEnabled)
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
  // visual-state/bubble/one-shots and replays overlay interactions. Pointless
  // on the web (single browsing context), so gate on Tauri.
  useEffect(() => {
    if (!widgetEnabled || !isTauri()) return
    const dispose = startMainPetBridge()
    return dispose
  }, [widgetEnabled])

  if (!widgetEnabled) return null
  return <PetWidget settings={pet} activeCharacterId={activeCharacterId} />
}
