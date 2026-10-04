// The one writer for `AppSettings.petSettings`, and the follower that keeps
// every pet window's copy of it fresh.
//
// The desktop pet runs in three webviews (the main window, the `pet` sprite
// overlay and the `pet-popup` click popup). Each loads the settings store once
// at boot and never refreshes it, and `saveSettings` merges at the TOP level,
// so a `{ petSettings }` patch replaces the whole nested record. Every window
// therefore wrote back the copy it booted with: the overlay persisting a
// resting spot reverted whatever the user had changed in Settings since the
// overlay opened, and the main window persisting a tray toggle threw away the
// overlay's saved position. The overlay, in turn, never saw a size, wander,
// gaze or click-through change made in the main window.
//
// Two halves close that:
//
//  - `updatePetSettings(updater)` re-reads the PERSISTED record and applies an
//    updater to it, never a caller's snapshot. It runs under a Web Lock, which
//    is shared by every same-origin browsing context (each Tauri webview of
//    this app), so two windows can never interleave their read-modify-write.
//    Where the Lock API is missing it still reads fresh, which leaves only the
//    milliseconds between that read and the write.
//  - After every write it broadcasts on a BroadcastChannel, and
//    `startPetSettingsFollower()` re-reads the record in every other window
//    and replaces just its `petSettings` slice, leaving the rest of that
//    window's settings untouched.
//
// Writers elsewhere in the app (`saveSettings` callers that never touch
// `petSettings`) are unaffected: a patch without the key never replaces it.

import { getSettings } from "@/lib/db/settings"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_PET_SETTINGS, type PetSettings } from "@/types/pet"

/** BroadcastChannel name shared by every pet window. */
export const PET_SETTINGS_CHANNEL = "cognia-pet-settings"

/** Web Lock name that serializes pet-settings writes across windows. */
export const PET_SETTINGS_LOCK = "cognia-pet-settings-write"

/** Wire message. Versioned so a future shape change can be ignored safely. */
export interface PetSettingsChangedMessage {
  v: 1
  kind: "pet-settings-changed"
  /** Realm that wrote, so it does not reload its own write. */
  from: string
}

/** Produces the next record from the latest persisted one. */
export type PetSettingsUpdater = (latest: PetSettings) => PetSettings

/** Injectable side effects, for tests and for callers outside React. */
export interface PetSettingsSyncDeps {
  readPersisted: () => Promise<PetSettings>
  write: (next: PetSettings) => Promise<void>
  withLock: <T>(task: () => Promise<T>) => Promise<T>
  openChannel: (
    name: string
  ) => Pick<
    BroadcastChannel,
    "postMessage" | "close" | "addEventListener" | "removeEventListener"
  > | null
  /** Replace this window's in-memory `petSettings` slice. */
  applyLocal: (next: PetSettings) => void
}

// One id per JavaScript realm (one per webview), never persisted.
const REALM_ID = `pet-settings-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`

/** Serializes writes inside this realm when the Web Lock API is missing. */
let localQueue: Promise<unknown> = Promise.resolve()

function defaultWithLock<T>(task: () => Promise<T>): Promise<T> {
  const locks =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & { locks?: LockManager }).locks
      : undefined
  if (locks && typeof locks.request === "function") {
    return locks.request(PET_SETTINGS_LOCK, { mode: "exclusive" }, task) as Promise<T>
  }
  const next = localQueue.catch(() => undefined).then(task)
  localQueue = next
  return next
}

function defaultOpenChannel(name: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null
  try {
    return new BroadcastChannel(name)
  } catch {
    return null
  }
}

const DEFAULT_DEPS: PetSettingsSyncDeps = {
  readPersisted: async () => (await getSettings()).petSettings ?? DEFAULT_PET_SETTINGS,
  write: async (next) => {
    await useSettingsStore.getState().save({ petSettings: next })
  },
  withLock: defaultWithLock,
  openChannel: defaultOpenChannel,
  applyLocal: (next) => {
    useSettingsStore.setState((state) =>
      state.settings ? { settings: { ...state.settings, petSettings: next } } : state
    )
  },
}

function resolveDeps(deps: Partial<PetSettingsSyncDeps> | undefined): PetSettingsSyncDeps {
  return deps ? { ...DEFAULT_DEPS, ...deps } : DEFAULT_DEPS
}

function isChangedMessage(data: unknown): data is PetSettingsChangedMessage {
  if (!data || typeof data !== "object") return false
  const m = data as Partial<PetSettingsChangedMessage>
  return m.v === 1 && m.kind === "pet-settings-changed" && typeof m.from === "string"
}

/**
 * Apply `updater` to the latest persisted pet settings and save the result.
 * Returns the record that is now persisted. An updater that returns its input
 * unchanged writes nothing and broadcasts nothing.
 */
export async function updatePetSettings(
  updater: PetSettingsUpdater,
  deps?: Partial<PetSettingsSyncDeps>
): Promise<PetSettings> {
  const d = resolveDeps(deps)
  const next = await d.withLock(async () => {
    const latest = await d.readPersisted()
    const updated = updater(latest)
    if (updated === latest) return null
    await d.write(updated)
    return updated
  })
  if (next === null) return d.readPersisted()
  const channel = d.openChannel(PET_SETTINGS_CHANNEL)
  if (channel) {
    const message: PetSettingsChangedMessage = {
      v: 1,
      kind: "pet-settings-changed",
      from: REALM_ID,
    }
    try {
      channel.postMessage(message)
    } finally {
      channel.close()
    }
  }
  return next
}

/**
 * Patch the nested desktop-overlay record on the latest persisted settings.
 * The overlay's position, size, click-through and wander fields are written
 * from different windows, so the merge must happen against the fresh record,
 * never against a component's props.
 */
export function updateDesktopPetSettings(
  patch: (
    latest: NonNullable<PetSettings["desktopPet"]>,
    pet: PetSettings
  ) => Partial<NonNullable<PetSettings["desktopPet"]>>,
  defaults: NonNullable<PetSettings["desktopPet"]>,
  deps?: Partial<PetSettingsSyncDeps>
): Promise<PetSettings> {
  return updatePetSettings((latest) => {
    const desktop = latest.desktopPet ?? defaults
    return { ...latest, desktopPet: { ...desktop, ...patch(desktop, latest) } }
  }, deps)
}

/**
 * Follow pet-settings writes made in other windows: on each broadcast,
 * re-read the persisted record and replace this window's `petSettings` slice.
 * Returns a disposer. A no-op where BroadcastChannel does not exist.
 */
export function startPetSettingsFollower(deps?: Partial<PetSettingsSyncDeps>): () => void {
  const d = resolveDeps(deps)
  const channel = d.openChannel(PET_SETTINGS_CHANNEL)
  if (!channel) return () => {}
  let disposed = false
  // Coalesce a burst of writes (a slider drag) into one trailing read.
  let reading: Promise<void> | null = null
  let again = false
  const refresh = () => {
    if (reading) {
      again = true
      return
    }
    reading = (async () => {
      do {
        again = false
        try {
          const fresh = await d.readPersisted()
          if (!disposed) d.applyLocal(fresh)
        } catch (err) {
          console.warn("pet settings follower: could not re-read settings", err)
        }
      } while (again && !disposed)
      reading = null
    })()
  }
  const onMessage = (event: MessageEvent) => {
    if (disposed || !isChangedMessage(event.data) || event.data.from === REALM_ID) return
    refresh()
  }
  channel.addEventListener("message", onMessage as EventListener)
  return () => {
    disposed = true
    channel.removeEventListener("message", onMessage as EventListener)
    channel.close()
  }
}

/** Test seam: this realm's writer id. */
export function petSettingsRealmIdForTest(): string {
  return REALM_ID
}
