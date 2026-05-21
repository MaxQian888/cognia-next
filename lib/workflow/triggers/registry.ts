/**
 * Trigger registry — tracks plugin-contributed trigger sources.
 *
 * Built-in triggers (cron / webhook / connector.inbound / chat.message /
 * manual) are wired directly through `webhook-bridge.ts` /
 * `trigger-bridge.ts`. This registry is solely for plugin-contributed
 * triggers (`PluginTriggerDef`) and runs the equivalent listener
 * machinery as `lib/workflow/nodes/registry.ts` so the editor sidebar +
 * catalog can hot-merge them on plugin enable / disable.
 */

import type {
  PluginTriggerDef,
  PluginTriggerHandle,
  PluginTriggerStartContext,
} from "@/types/plugin/plugin-workflow"

/** A live trigger instance (one per workflow that binds a plugin trigger). */
export interface TriggerInstanceHandle extends PluginTriggerHandle {
  /** Plugin-prefixed kind, e.g. `trigger.myplugin.cronEx`. */
  kind: string
  /** Workflow this instance feeds. */
  workflowId: string
}

export interface TriggerRegistration {
  /** Plugin-prefixed kind. */
  kind: string
  typeVersion: number
  pluginId: string
  def: PluginTriggerDef
  /**
   * Live instances spawned from this registration, keyed by workflowId.
   * One trigger registration may feed many workflows; each binding gets
   * its own instance.
   */
  instances: Map<string, TriggerInstanceHandle>
}

export type TriggerRegistryEventType = "register" | "unregister"

export interface TriggerRegistryEvent {
  type: TriggerRegistryEventType
  kind: string
  typeVersion: number
  pluginId: string
}

export type TriggerRegistryListener = (event: TriggerRegistryEvent) => void

const registry = new Map<string, TriggerRegistration>()
const listeners = new Set<TriggerRegistryListener>()

function emit(event: TriggerRegistryEvent): void {
  queueMicrotask(() => {
    for (const fn of listeners) {
      try {
        fn(event)
      } catch (err) {
        console.warn("Trigger registry listener threw:", err)
      }
    }
  })
}

/**
 * Register a plugin trigger. The caller is responsible for kind prefixing
 * — the plugin context wrapper does this automatically. Re-registering the
 * same (kind, version) tuple is idempotent for the registration itself,
 * but does NOT restart already-running instances.
 */
export function registerPluginTrigger(reg: TriggerRegistration): void {
  registry.set(`${reg.kind}@${reg.typeVersion}`, reg)
  emit({
    type: "register",
    kind: reg.kind,
    typeVersion: reg.typeVersion,
    pluginId: reg.pluginId,
  })
}

/**
 * Unregister a plugin trigger. Stops every live instance before clearing
 * the registration so the source is fully torn down. Idempotent.
 */
export async function unregisterPluginTrigger(kind: string, typeVersion: number): Promise<void> {
  const k = `${kind}@${typeVersion}`
  const reg = registry.get(k)
  if (!reg) return
  // Stop all live instances. Wrap each in try/catch so one bad teardown
  // doesn't strand the others.
  await Promise.all(
    [...reg.instances.values()].map(async (handle) => {
      try {
        await handle.stop()
      } catch (err) {
        console.warn(`Plugin trigger ${kind} stop() threw:`, err)
      }
    })
  )
  reg.instances.clear()
  registry.delete(k)
  emit({ type: "unregister", kind, typeVersion, pluginId: reg.pluginId })
}

export function getPluginTrigger(
  kind: string,
  typeVersion: number
): TriggerRegistration | undefined {
  return registry.get(`${kind}@${typeVersion}`)
}

export function listPluginTriggers(): TriggerRegistration[] {
  return [...registry.values()]
}

/**
 * Spin up an instance of a plugin trigger for the given workflow. The
 * instance handle is tracked on the registration so a later
 * `unregisterPluginTrigger` can stop it.
 */
export async function startPluginTriggerInstance(
  kind: string,
  typeVersion: number,
  ctx: PluginTriggerStartContext
): Promise<TriggerInstanceHandle | undefined> {
  const reg = getPluginTrigger(kind, typeVersion)
  if (!reg) return undefined
  const handle = await reg.def.start(ctx)
  const wrapped: TriggerInstanceHandle = {
    kind: reg.kind,
    workflowId: ctx.workflowId,
    stop: handle.stop,
  }
  reg.instances.set(ctx.workflowId, wrapped)
  return wrapped
}

export function subscribePluginTriggerRegistry(fn: TriggerRegistryListener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-(pluginId, kind, workflowId) mute flag. Surfaced in the plugin
// detail Triggers sub-tab; consulted by `dispatchPluginTrigger` before
// fanning out. Persisted to localStorage on every mutation so the
// preference survives reloads.
// ─────────────────────────────────────────────────────────────────────────────

const MUTE_STORAGE_KEY = "cognia.plugin.trigger.mute"
const muted = new Set<string>()
const muteListeners = new Set<() => void>()
let muteHydrated = false

function muteKey(pluginId: string, kind: string, workflowId: string): string {
  return `${pluginId}::${kind}::${workflowId}`
}

function hydrateMutesIfNeeded(): void {
  if (muteHydrated) return
  muteHydrated = true
  if (typeof window === "undefined") return
  try {
    const raw = window.localStorage.getItem(MUTE_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      for (const key of parsed) if (typeof key === "string") muted.add(key)
    }
  } catch {
    // corrupt storage — ignore
  }
}

function persistMutes(): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(MUTE_STORAGE_KEY, JSON.stringify([...muted]))
  } catch {
    // quota / disabled — silently skip
  }
}

function notifyMutes(): void {
  for (const fn of muteListeners) {
    try {
      fn()
    } catch {
      // listener crashed — keep going
    }
  }
}

export function setTriggerMuted(
  pluginId: string,
  kind: string,
  workflowId: string,
  isMuted: boolean
): void {
  hydrateMutesIfNeeded()
  const key = muteKey(pluginId, kind, workflowId)
  const before = muted.has(key)
  if (isMuted) muted.add(key)
  else muted.delete(key)
  if (muted.has(key) !== before) {
    persistMutes()
    notifyMutes()
  }
}

export function isTriggerMuted(pluginId: string, kind: string, workflowId: string): boolean {
  hydrateMutesIfNeeded()
  return muted.has(muteKey(pluginId, kind, workflowId))
}

export function subscribeTriggerMuteChanges(fn: () => void): () => void {
  muteListeners.add(fn)
  return () => {
    muteListeners.delete(fn)
  }
}

/** Test-only — wipe the mute set + storage. */
export function __resetTriggerMutesForTesting(): void {
  muted.clear()
  muteHydrated = true // skip hydration after reset
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(MUTE_STORAGE_KEY)
    } catch {
      // ignore
    }
  }
}

/** Test-only. Production code should never call this. */
export function __resetTriggerRegistryForTesting(): void {
  registry.clear()
  listeners.clear()
}
