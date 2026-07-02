// Cognia-native commands for the pet subsystem, reachable through the unified
// command registry (`lib/plugin/commands/registry.ts`) — the single dispatch
// surface a global hotkey (`lib/shortcuts/`), the tray (`lib/tray/defaults.ts`
// quick actions), and any future command palette entry can all invoke without
// duplicating the toggle/feed/play/pet logic per call site.

import { registerCommand } from "@/lib/plugin/commands/registry"
import { emitPetEvent } from "@/lib/pet/events/pet-event-bus"
import { closePetWindow, isPetWindowOpen, openPetWindow } from "@/lib/tauri/pet-window"
import { overlayWindowSize } from "@/lib/pet/overlay-geometry"
import { isTauri } from "@/lib/platform/detect"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_PET_DESKTOP_OVERLAY, DEFAULT_PET_SETTINGS } from "@/types/pet"

/**
 * Open/close the desktop-pet overlay window, persisting the flip into
 * `PetSettings.desktopPet.enabled`. Always re-queries the live OS window
 * state via `isPetWindowOpen()` rather than trusting caller-tracked state, so
 * it's safe to invoke from a context with no cached "is it open" flag (a
 * hotkey or the tray). Returns the resulting open state; off Tauri (or on
 * IPC failure) it's a safe no-op that returns `false`.
 */
export async function toggleDesktopPetWindow(): Promise<boolean> {
  if (!isTauri()) return false
  const store = useSettingsStore.getState()
  const pet = store.settings?.petSettings ?? DEFAULT_PET_SETTINGS
  const desktop = pet.desktopPet ?? DEFAULT_PET_DESKTOP_OVERLAY

  if (await isPetWindowOpen()) {
    await closePetWindow()
    await store.save({ petSettings: { ...pet, desktopPet: { ...desktop, enabled: false } } })
    return false
  }
  await openPetWindow({
    ...overlayWindowSize(desktop.size),
    x: desktop.position?.x,
    y: desktop.position?.y,
    clickThrough: desktop.clickThrough,
  })
  await store.save({ petSettings: { ...pet, desktopPet: { ...desktop, enabled: true } } })
  return true
}

/**
 * Registers the desktop-pet window toggle. Kept separate from the interaction
 * commands because its handler is self-contained (reads settings, flips the OS
 * window) and does NOT depend on the in-app widget being mounted. It must stay
 * registered whenever the main desktop window is up — even when the pet
 * subsystem is currently disabled — so a global hotkey the user bound to it
 * actually summons the pet instead of being reserved at the OS level yet
 * dispatching to nothing.
 */
export function registerPetWindowCommand(): () => void {
  return registerCommand({
    id: "pet.toggle-window",
    title: "Toggle desktop pet",
    category: "Pet",
    pluginId: null,
    handler: () => toggleDesktopPetWindow(),
  })
}

/**
 * Registers feed/play/pet. These emit pet events that only matter while the pet
 * controller / event bus is running, so callers gate them on the widget being
 * enabled (unlike {@link registerPetWindowCommand}).
 */
export function registerPetInteractionCommands(): () => void {
  const disposers = [
    registerCommand({
      id: "pet.feed",
      title: "Feed the pet",
      category: "Pet",
      pluginId: null,
      handler: () => emitPetEvent({ source: "user", kind: "fed" }),
    }),
    registerCommand({
      id: "pet.play",
      title: "Play with the pet",
      category: "Pet",
      pluginId: null,
      handler: () => emitPetEvent({ source: "user", kind: "played" }),
    }),
    registerCommand({
      id: "pet.pet",
      title: "Pet the pet",
      category: "Pet",
      pluginId: null,
      handler: () => emitPetEvent({ source: "user", kind: "petted" }),
    }),
    registerCommand({
      id: "pet.sleep",
      title: "Put the pet to sleep",
      category: "Pet",
      pluginId: null,
      handler: () => emitPetEvent({ source: "user", kind: "slept" }),
    }),
    registerCommand({
      id: "pet.clean",
      title: "Clean the pet",
      category: "Pet",
      pluginId: null,
      handler: () => emitPetEvent({ source: "user", kind: "cleaned" }),
    }),
    registerCommand({
      id: "pet.treat",
      title: "Give the pet a treat",
      category: "Pet",
      pluginId: null,
      handler: () => emitPetEvent({ source: "user", kind: "treated" }),
    }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Convenience: register all pet commands (window toggle + interactions) at once.
 * Returns a single bulk-unregister handle.
 */
export function registerPetCommands(): () => void {
  const disposeWindow = registerPetWindowCommand()
  const disposeInteractions = registerPetInteractionCommands()
  return () => {
    disposeWindow()
    disposeInteractions()
  }
}
