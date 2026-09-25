// Cognia-native commands for the pet subsystem, reachable through the unified
// command registry (`lib/plugin/commands/registry.ts`) — the single dispatch
// surface a global hotkey (`lib/shortcuts/`), the tray (`lib/tray/defaults.ts`
// quick actions), and any future command palette entry can all invoke without
// duplicating the toggle/feed/play/pet logic per call site.

import { registerCommand } from "@/lib/plugin/commands/registry"
import {
  PET_INTERACTION_COMMAND_IDS,
  PET_WINDOW_COMMAND_ID,
  type PetInteractionCommandId,
} from "@/lib/pet/command-ids"
import {
  requestPetInteraction,
  type PetAccessResult,
  type PetInteractionKind,
  type PetRefusal,
} from "@/lib/pet/access/gate"
import { closePetWindow, isPetWindowOpen, openPetWindow } from "@/lib/tauri/pet-window"
import { overlayWindowSize } from "@/lib/pet/overlay-geometry"
import { isTauri } from "@/lib/platform/detect"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_PET_DESKTOP_OVERLAY, DEFAULT_PET_SETTINGS } from "@/types/pet"

export { PET_INTERACTION_COMMAND_IDS, PET_WINDOW_COMMAND_ID, type PetInteractionCommandId }

/**
 * Open/close the desktop-pet overlay window, persisting the flip into
 * `PetSettings.desktopPet.enabled`. Always re-queries the live OS window
 * state via `isPetWindowOpen()` rather than trusting caller-tracked state, so
 * it's safe to invoke from a context with no cached "is it open" flag (a
 * hotkey or the tray). Returns the resulting open state; off Tauri (or on
 * IPC failure) it's a safe no-op that returns `false`.
 *
 * Opening is a summon and switches the pet on (see
 * {@link openDesktopPetWindow}); closing only hides the window and never
 * switches the pet off, which stays the master switch's job.
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
 * Summon the overlay: switch the pet on, open the window, persist the intent.
 * Idempotent.
 *
 * Split out of {@link toggleDesktopPetWindow} so every caller that wants the
 * pet on screen (the hotkey, the tray, ⌘K, the settings switch, the agent's
 * `pet_show`) shares one open-and-persist path instead of drifting apart.
 * Already-open is a success, not a toggle: asking for the pet twice should
 * leave it visible. Off Tauri, or when the window fails to open, it is a safe
 * no-op that returns `false`.
 *
 * A summon switches the pet on (ADR-0058 D9). The overlay owns no controller:
 * with `PetSettings.enabled` off, `PetMount` never starts the event bus, the
 * main-window bridge or the profile, so the summoned window ignored every
 * click, and on a never-hatched install it rendered nothing at all, an
 * invisible always-on-top window. The writes are ordered on purpose:
 *
 * 1. Switch the pet on BEFORE the window exists, leaving `desktopPet.enabled`
 *    alone. Writing both first would let `PetMount`'s cold-start reconcile
 *    (it opens the overlay when both are set and no window exists) race this
 *    function into a second open.
 * 2. Open the window.
 * 3. Re-read the store and persist both flags. `saveSettings` replaces
 *    `petSettings` whole, and the native `pet://state-changed` echo that
 *    step 2 triggers saves from the store too, so spreading the snapshot
 *    taken at the top could switch the pet straight back off.
 */
export async function openDesktopPetWindow(): Promise<boolean> {
  if (!isTauri()) return false
  const initial = useSettingsStore.getState().settings?.petSettings ?? DEFAULT_PET_SETTINGS
  const desktop = initial.desktopPet ?? DEFAULT_PET_DESKTOP_OVERLAY

  if (!initial.enabled) {
    await useSettingsStore.getState().save({ petSettings: { ...initial, enabled: true } })
  }

  if (!(await isPetWindowOpen())) {
    const opened = await openPetWindow({
      ...overlayWindowSize(desktop.size),
      x: desktop.position?.x,
      y: desktop.position?.y,
      clickThrough: desktop.clickThrough,
    })
    // Persisting `desktopPet.enabled` for a window that never appeared would
    // have the cold-start reconcile retry it on every launch.
    if (!opened) return false
  }

  const store = useSettingsStore.getState()
  const latest = store.settings?.petSettings ?? DEFAULT_PET_SETTINGS
  await store.save({
    petSettings: {
      ...latest,
      enabled: true,
      desktopPet: { ...(latest.desktopPet ?? DEFAULT_PET_DESKTOP_OVERLAY), enabled: true },
    },
  })
  return true
}

/**
 * Registers the desktop-pet window toggle. Kept separate from the interaction
 * commands because its handler is self-contained (reads settings, flips the OS
 * window) and does NOT depend on the in-app widget being mounted. It must stay
 * registered whenever the main desktop window is up — even when the pet
 * subsystem is currently disabled — so a global hotkey or the tray toggle the
 * user reaches for actually summons the pet (switching it on) instead of being
 * reserved at the OS level yet dispatching to nothing.
 */
export function registerPetWindowCommand(opts: { title?: string } = {}): () => void {
  return registerCommand({
    id: PET_WINDOW_COMMAND_ID,
    // Localized by the React caller; the English literal is the fallback for a
    // caller with no translator. The title is user-visible in the tray's "All
    // Commands" submenu and the keybinding sheet.
    title: opts.title ?? "Toggle desktop pet",
    category: "Pet",
    pluginId: null,
    handler: () => toggleDesktopPetWindow(),
  })
}

interface InteractionCommand {
  id: PetInteractionCommandId
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
] as const satisfies readonly InteractionCommand[]

export interface RegisterPetInteractionCommandsOptions {
  /** Localized titles by command id; each falls back to its English literal. */
  titles?: Partial<Record<PetInteractionCommandId, string>>
  /**
   * Called when the access gate refuses an interaction. The commands are
   * registered on the main desktop window even while the pet is off, so a
   * bound global chord still answers; this is where the caller makes that
   * answer visible.
   */
  onRefused?: (kind: PetInteractionKind, refusal: PetRefusal) => void
}

/**
 * Registers the nurture commands. These drive the pet through the access gate,
 * so they only act while the pet is available (see
 * `lib/pet/access/availability.ts`); otherwise the refusal goes to
 * `onRefused` instead of vanishing.
 */
export function registerPetInteractionCommands(
  opts: RegisterPetInteractionCommandsOptions = {}
): () => void {
  const disposers = INTERACTION_COMMANDS.map(({ id, title, kind }) =>
    registerCommand({
      id,
      title: opts.titles?.[id] ?? title,
      category: "Pet",
      pluginId: null,
      // Through the access gate rather than straight onto the bus. This is the
      // path a global hotkey and the tray reach, and before the gate it was
      // the one with no checks at all: availability, the kind whitelist and
      // the burst bucket all start here now, and the controller's per-kind
      // cooldown finishes the job downstream.
      handler: async (): Promise<PetAccessResult> => {
        const result = await requestPetInteraction({ kind: "user" }, kind)
        if (!result.ok) opts.onRefused?.(kind, result.refusal)
        return result
      },
    })
  )
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Convenience: register all pet commands (window toggle + interactions) at once.
 * Returns a single bulk-unregister handle. Takes the same localization and
 * refusal options as the two registrations it combines, so a caller using it
 * never falls back to the English titles.
 */
export function registerPetCommands(
  opts: { windowTitle?: string } & RegisterPetInteractionCommandsOptions = {}
): () => void {
  const { windowTitle, ...interactionOpts } = opts
  const disposeWindow = registerPetWindowCommand({ title: windowTitle })
  const disposeInteractions = registerPetInteractionCommands(interactionOpts)
  return () => {
    disposeWindow()
    disposeInteractions()
  }
}
