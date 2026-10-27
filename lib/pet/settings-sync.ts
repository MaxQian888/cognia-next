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
//  - The main window re-reads the owning account's persisted record under a
//    Web Lock and applies the updater, never a caller's snapshot. Secondary
//    windows delegate narrow desktop patches to that owner and await its ack.
//    A captured database and active-scope guard fence account switches.
//  - The owner broadcasts an allowlisted presentation snapshot. Secondary
//    followers replace only their pet presentation fields without opening the
//    legacy database or receiving account keys, speech settings or user text.
//    Owner epochs and revisions reject stale replies and replay after hydration.
//
// Writers elsewhere in the app (`saveSettings` callers that never touch
// `petSettings`) are unaffected: a patch without the key never replaces it.

import { getSettings, saveSettings } from "@/lib/db/settings"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_PET_DESKTOP_OVERLAY, DEFAULT_PET_SETTINGS, type PetSettings } from "@/types/pet"
import { z } from "zod"
import { getPetWindowRole } from "@/lib/pet/window-role"
import { getDb } from "@/lib/db/schema"

// Secondary windows have no account cipher. Project the display preferences;
// speech configuration and user-authored text remain in the main window.
const presentationSchema = z.object({
  enabled: z.boolean(),
  anchor: z.enum(["bottom-right", "bottom-left", "top-right", "top-left"]),
  motion: z.enum(["auto", "full", "reduced"]),
  mutedBubbles: z.boolean(),
  size: z.number().min(16).max(512),
  skinId: z.enum(["svg", "live2d", "sprite-v2", "media"]).optional(),
  activeLive2dModelId: z.string().max(200).optional(),
  activeSpritePackId: z.string().max(200).optional(),
  activeMediaPackId: z.string().max(200).optional(),
  lowPower: z.boolean().optional(),
  gazeFollowing: z.boolean().optional(),
  desktopPet: z
    .object({
      enabled: z.boolean(),
      clickThrough: z.boolean(),
      size: z.number().min(64).max(512),
      position: z
        .object({ x: z.number(), y: z.number(), space: z.literal("desktop").optional() })
        .nullable()
        .optional(),
      wander: z
        .object({
          enabled: z.boolean(),
          frequency: z.enum(["calm", "normal", "lively"]),
          onlyAfterInteraction: z.boolean(),
          range: z.enum(["full", "near"]),
          climbWindows: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
})
let presentationRevision = 0
let ownerAccountScope = "",
  ownerScopeToken = ""
function scopeToken(scope: string) {
  if (ownerAccountScope !== scope) {
    ownerAccountScope = scope
    ownerScopeToken = crypto.randomUUID()
  }
  return ownerScopeToken
}
let secondaryPresentation:
  { settings: PetSettings; owner: string; scope: string; revision: number } | undefined
const pendingDesktopRequests = new Set<() => void>()
const desktopPatchSchema = z
  .object({
    position: z
      .object({ x: z.number(), y: z.number(), space: z.literal("desktop").optional() })
      .nullable()
      .optional(),
    enabled: z.boolean().optional(),
    clickThrough: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0)
function presentationMessage(
  settings: PetSettings,
  revision = ++presentationRevision,
  accountScope = DEFAULT_DEPS.accountScope()
) {
  const parsed = presentationSchema.safeParse(settings)
  return parsed.success
    ? {
        presentation: parsed.data,
        presentationRevision: revision,
        presentationScope: scopeToken(accountScope),
      }
    : {}
}

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
  presentation?: z.infer<typeof presentationSchema>
  presentationRevision?: number
  presentationScope?: string
}

/** Produces the next record from the latest persisted one. */
export type PetSettingsUpdater = (latest: PetSettings) => PetSettings

/** Injectable side effects, for tests and for callers outside React. */
export interface PetSettingsSyncDeps {
  accountScope(): string
  watchLocalSettings(listener: () => void): () => void
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
  accountScope: () => getDb().name,
  watchLocalSettings: (listener) => useSettingsStore.subscribe(listener),
  readPersisted: async () => (await getSettings()).petSettings ?? DEFAULT_PET_SETTINGS,
  write: async (next) => {
    await useSettingsStore.getState().save({ petSettings: next })
  },
  withLock: defaultWithLock,
  openChannel: defaultOpenChannel,
  applyLocal: (next) => {
    useSettingsStore.setState((state) =>
      state.settings && state.settings.petSettings !== next
        ? { settings: { ...state.settings, petSettings: next } }
        : state
    )
  },
}

function resolveDeps(deps: Partial<PetSettingsSyncDeps> | undefined): PetSettingsSyncDeps {
  return deps ? { ...DEFAULT_DEPS, ...deps } : DEFAULT_DEPS
}

function scopedOwnerDeps(d: PetSettingsSyncDeps, db = getDb()): PetSettingsSyncDeps {
  const assertActive = () => {
    if (getDb() !== db) throw new Error("Pet account changed")
  }
  const scope = { db, assertActive }
  return {
    ...d,
    readPersisted: async () => (await getSettings(scope)).petSettings ?? DEFAULT_PET_SETTINGS,
    write: async (next) => {
      const saved = await saveSettings({ petSettings: next }, { scope })
      assertActive()
      DEFAULT_DEPS.applyLocal(saved.petSettings ?? DEFAULT_PET_SETTINGS)
    },
  }
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
  const role = getPetWindowRole()
  if (!deps && (role === "overlay" || role === "popup"))
    throw new Error("Pet preferences must be saved by the main window")
  const base = resolveDeps(deps)
  const d = !deps && role === "main" ? scopedOwnerDeps(base) : base
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
      ...(role === "main" ? presentationMessage(next, undefined, d.accountScope()) : {}),
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
  const role = getPetWindowRole()
  if (!deps && (role === "overlay" || role === "popup")) {
    const current = secondaryPresentation
    if (!current) return Promise.reject(new Error("Pet presentation is not ready"))
    const parsed = desktopPatchSchema.safeParse(
      patch(current.settings.desktopPet ?? defaults, current.settings)
    )
    if (!parsed.success) return Promise.reject(new Error("Unsupported desktop pet patch"))
    return requestDesktopPatch(parsed.data, current)
  }
  return updatePetSettings((latest) => {
    const desktop = latest.desktopPet ?? defaults
    return { ...latest, desktopPet: { ...desktop, ...patch(desktop, latest) } }
  }, deps)
}

function requestDesktopPatch(
  patch: z.infer<typeof desktopPatchSchema>,
  owner: NonNullable<typeof secondaryPresentation>
): Promise<PetSettings> {
  const channel = defaultOpenChannel(PET_SETTINGS_CHANNEL)
  if (!channel) return Promise.reject(new Error("Pet settings channel unavailable"))
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, settings?: PetSettings) => {
      clearTimeout(timer)
      channel.removeEventListener("message", receive)
      channel.close()
      pendingDesktopRequests.delete(cancel)
      if (error) reject(error)
      else resolve(settings!)
    }
    const receive = (event: MessageEvent) => {
      const value = event.data
      if (
        value?.v !== 1 ||
        value.kind !== "pet-desktop-result" ||
        value.requestId !== requestId ||
        value.from !== owner.owner
      )
        return
      const current = secondaryPresentation
      if (!current || current.owner !== owner.owner || current.scope !== owner.scope) {
        finish(new Error("Pet presentation changed before the update completed"))
        return
      }
      const parsed = presentationSchema.safeParse(value.presentation)
      if (value.error || value.presentationScope !== owner.scope || !parsed.success)
        finish(new Error("Main window rejected the pet settings update"))
      else {
        if (!Number.isSafeInteger(value.presentationRevision)) {
          finish(new Error("Invalid pet presentation revision"))
          return
        }
        if (value.presentationRevision <= current.revision) {
          finish(undefined, current.settings)
          return
        }
        const settings = { ...DEFAULT_PET_SETTINGS, ...parsed.data }
        secondaryPresentation = { ...owner, settings, revision: value.presentationRevision }
        DEFAULT_DEPS.applyLocal(settings)
        finish(undefined, settings)
      }
    }
    const timer = setTimeout(() => finish(new Error("Main window did not save pet settings")), 5000)
    const cancel = () => finish(new Error("Pet settings follower was disposed"))
    pendingDesktopRequests.add(cancel)
    channel.addEventListener("message", receive)
    channel.postMessage({
      v: 1,
      kind: "pet-desktop-patch",
      requestId,
      from: REALM_ID,
      owner: owner.owner,
      scope: owner.scope,
      patch,
    })
  })
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
  const role = getPetWindowRole()
  const secondary = role === "overlay" || role === "popup"
  let mainRealm: string | undefined,
    latestRevision = 0
  const retiredRealms = new Set<string>()
  let latestPresentation: PetSettings | undefined
  const unwatch = secondary
    ? d.watchLocalSettings(() => {
        const fresh = secondaryPresentation?.settings ?? latestPresentation
        if (fresh && !disposed) d.applyLocal(fresh)
      })
    : () => {}
  const publish = async () => {
    const revision = ++presentationRevision
    const scope = d.accountScope()
    const settings = await d.readPersisted()
    if (!disposed && d.accountScope() === scope)
      channel.postMessage({
        v: 1,
        kind: "pet-settings-changed",
        from: REALM_ID,
        ...presentationMessage(settings, revision, scope),
      })
  }
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
    if (disposed || event.data?.from === REALM_ID) return
    if (role === "main" && event.data?.v === 1 && event.data?.kind === "pet-desktop-patch") {
      const message = event.data,
        parsed = desktopPatchSchema.safeParse(message.patch),
        scope = d.accountScope()
      if (
        message.owner !== REALM_ID ||
        typeof message.requestId !== "string" ||
        message.requestId.length > 128
      )
        return
      const reply = (value: Record<string, unknown>) => {
        if (!disposed)
          channel.postMessage({
            v: 1,
            kind: "pet-desktop-result",
            requestId: message.requestId,
            from: REALM_ID,
            ...value,
          })
      }
      if (!parsed.success || message.scope !== scopeToken(scope)) {
        reply({ error: true })
        return
      }
      const current = () => {
        if (disposed || d.accountScope() !== scope) throw new Error("Pet account changed")
      }
      const ownerDeps = deps ? d : scopedOwnerDeps(d)
      void updateDesktopPetSettings(
        () => {
          current()
          return parsed.data
        },
        DEFAULT_PET_DESKTOP_OVERLAY,
        {
          ...ownerDeps,
          write: async (next) => {
            current()
            await ownerDeps.write(next)
          },
        }
      )
        .then((settings) => {
          current()
          reply(presentationMessage(settings, undefined, scope))
        })
        .catch(() => reply({ error: true }))
      return
    }
    if (
      role === "main" &&
      event.data?.v === 1 &&
      event.data?.kind === "pet-settings-request" &&
      typeof event.data.from === "string"
    ) {
      void publish().catch(() => {})
      return
    }
    if (!isChangedMessage(event.data)) return
    if (secondary) {
      const message = event.data
      const parsed = presentationSchema.safeParse(message.presentation)
      if (
        !parsed.success ||
        !Number.isSafeInteger(message.presentationRevision) ||
        message.presentationRevision! < 1 ||
        retiredRealms.has(message.from)
      )
        return
      if (mainRealm !== message.from) {
        if (mainRealm) retiredRealms.add(mainRealm)
        mainRealm = message.from
        latestRevision = 0
      }
      if (message.presentationRevision! <= latestRevision) return
      if (
        secondaryPresentation?.owner === message.from &&
        secondaryPresentation.scope === message.presentationScope &&
        message.presentationRevision! <= secondaryPresentation.revision
      )
        return
      latestRevision = message.presentationRevision!
      latestPresentation = { ...DEFAULT_PET_SETTINGS, ...parsed.data }
      if (typeof message.presentationScope === "string")
        secondaryPresentation = {
          settings: latestPresentation,
          owner: message.from,
          scope: message.presentationScope,
          revision: message.presentationRevision!,
        }
      d.applyLocal(latestPresentation)
      return
    }
    refresh()
  }
  channel.addEventListener("message", onMessage as EventListener)
  if (role === "main") void publish().catch(() => {})
  if (secondary) channel.postMessage({ v: 1, kind: "pet-settings-request", from: REALM_ID })
  return () => {
    disposed = true
    unwatch()
    if (secondary) {
      secondaryPresentation = undefined
      for (const cancel of [...pendingDesktopRequests]) cancel()
    }
    channel.removeEventListener("message", onMessage as EventListener)
    channel.close()
  }
}

/** Test seam: this realm's writer id. */
export function petSettingsRealmIdForTest(): string {
  return REALM_ID
}
