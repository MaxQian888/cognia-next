// Cognia-native commands for the pet subsystem, reachable through the unified
// command registry (`lib/plugin/commands/registry.ts`) — the single dispatch
// surface a global hotkey (`lib/shortcuts/`), the tray (`lib/tray/defaults.ts`
// quick actions), and any future command palette entry can all invoke without
// duplicating the toggle/feed/play/pet logic per call site.

import { registerCommand } from "@/lib/plugin/commands/registry"
import { requestPetInteraction, type PetInteractionKind } from "@/lib/pet/access/gate"
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
  return openDesktopPetWindow()
}

/**
 * Open the overlay and persist the intent, idempotently.
 *
 * Split out of {@link toggleDesktopPetWindow} so a caller that wants the pet
 * on screen (the agent's `pet_show`, a deep link) does not have to reimplement
 * the open-and-persist pair and risk the two drifting apart. Already-open is a
 * success, not a toggle: asking for the pet twice should leave it visible.
 * Off Tauri it is a safe no-op that returns `false`.
 */
export async function openDesktopPetWindow(): Promise<boolean> {
  if (!isTauri()) return false
  const store = useSettingsStore.getState()
  const pet = store.settings?.petSettings ?? DEFAULT_PET_SETTINGS
  const desktop = pet.desktopPet ?? DEFAULT_PET_DESKTOP_OVERLAY

  if (!(await isPetWindowOpen())) {
    await openPetWindow({
      ...overlayWindowSize(desktop.size),
      x: desktop.position?.x,
      y: desktop.position?.y,
      clickThrough: desktop.clickThrough,
    })
  }
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

interface InteractionCommand {
  id: string
  title: string
  kind: PetInteractionKind
}

/**
 * The nurture commands, one row per interaction the gate accepts.
 *
 * `talked` is deliberately absent: it is owned by the speak pipeline, which
 * runs a model call and owns every `talked` bubble, so a command that emitted
 * it would fire a second one.
 */
const INTERACTION_COMMANDS: readonly InteractionCommand[] = [
  { id: "pet.feed", title: "Feed the pet", kind: "fed" },
  { id: "pet.play", title: "Play with the pet", kind: "played" },
  { id: "pet.pet", title: "Pet the pet", kind: "petted" },
  { id: "pet.sleep", title: "Put the pet to sleep", kind: "slept" },
  { id: "pet.clean", title: "Clean the pet", kind: "cleaned" },
  { id: "pet.treat", title: "Give the pet a treat", kind: "treated" },
] as const satisfies readonly { id: string; title: string; kind: PetInteractionKind }[]

/**
 * Registers the nurture commands. These drive the pet through the access gate,
 * so they only do anything while the pet is available (see
 * `lib/pet/access/availability.ts`), unlike {@link registerPetWindowCommand}.
 */
export function registerPetInteractionCommands(): () => void {
  const disposers = INTERACTION_COMMANDS.map(({ id, title, kind }) =>
    registerCommand({
      id,
      title,
      category: "Pet",
      pluginId: null,
      // Through the access gate rather than straight onto the bus. This is the
      // path a global hotkey and the tray reach, and before the gate it was
      // the one with no checks at all: availability, the kind whitelist and
      // the burst bucket all start here now, and the controller's per-kind
      // cooldown finishes the job downstream.
      handler: () => requestPetInteraction({ kind: "user" }, kind),
    })
  )
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
