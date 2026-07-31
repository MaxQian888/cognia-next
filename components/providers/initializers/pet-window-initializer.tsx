"use client"

import { useEffect, useRef } from "react"

import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_PET_DESKTOP_OVERLAY } from "@/types/pet"
import { isTauri } from "@/lib/platform/detect"
import { getPetWindowRole } from "@/lib/pet/window-role"
import { openPetWindow } from "@/lib/tauri/pet-window"
import { overlayWindowSize } from "@/lib/pet/overlay-geometry"
import { loggers } from "@cognia/logging"

const log = loggers.shell

/**
 * Boot-time initializer that re-opens the transparent desktop-pet overlay
 * window when the user left it enabled. Runs only in the main window of the
 * Tauri shell — the overlay window itself (role "overlay") must never re-open
 * itself, and the web/mobile shells have no multi-window support.
 *
 * The settings store hydrates asynchronously, so this subscribes and acts on
 * the first snapshot whose `petSettings.desktopPet.enabled` is true, then guards
 * against ever opening twice (a ref flips on the first open, and the
 * subscription tears down). Following the `OcrRuntimeInitializer` shape so the
 * `app/layout.tsx` initializer block stays homogeneous.
 */
export function PetWindowInitializer() {
  const hasOpened = useRef(false)

  useEffect(() => {
    if (hasOpened.current) return
    // Only the main desktop window owns the overlay lifecycle.
    if (!isTauri() || getPetWindowRole() !== "main") return

    const maybeOpen = (settings: ReturnType<typeof useSettingsStore.getState>["settings"]) => {
      // Open at most once, even if later snapshots also report `enabled`.
      if (hasOpened.current) return
      const desktop = settings?.petSettings?.desktopPet
      if (!desktop?.enabled) return
      hasOpened.current = true
      const size = desktop.size ?? DEFAULT_PET_DESKTOP_OVERLAY.size
      void openPetWindow({
        ...overlayWindowSize(size),
        x: desktop.position?.x,
        y: desktop.position?.y,
        clickThrough: desktop.clickThrough ?? false,
      }).catch((err) => log.warn("pet-window: boot open threw", { err }))
    }

    // Act on the current snapshot (already-hydrated case) then on every change
    // (async-hydration case). The `hasOpened` guard keeps it idempotent; the
    // subscription lives until unmount.
    maybeOpen(useSettingsStore.getState().settings)
    const unsubscribe = useSettingsStore.subscribe((state) => maybeOpen(state.settings))

    return () => {
      unsubscribe()
    }
  }, [])

  return null
}

export default PetWindowInitializer
