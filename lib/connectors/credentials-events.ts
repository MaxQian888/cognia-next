/**
 * Credentials rotation event bus.
 *
 * Settings/Connections forms (lark/slack/discord/telegram/onebot) emit
 * `credentials:rotated` after a successful save so the lifecycle layer can
 * re-queue the affected adapter without a full app restart.
 *
 * Why this exists: every adapter reads its credentials lazily via
 * `connectorsKeyringGet(rowId, name)` getters that are captured at build
 * time, so the **next** call after a Save will already see the new value.
 * The missing link was telling the runtime which adapter to tear down +
 * restart so any long-poll cursor, gateway socket, or webhook signature
 * cache is rebuilt against the rotated material. This module is that link.
 *
 * The contract is intentionally narrow:
 *   - `emitCredentialsRotated(adapterId)` — fire-and-forget from the form.
 *   - `onCredentialsRotated(handler)` — register a global listener; returns
 *     an unsubscribe function. The handler receives the adapterId so it
 *     can decide whether the rotation matters to it (lifecycle requeues
 *     only the matching running adapter).
 *
 * The renderer-local bus uses EventTarget. Nonsecret revisions survive reloads
 * and storage events notify other same-origin windows after a credential save.
 */
export interface CredentialsRotatedDetail {
  adapterId: string
  rotatedAt: number
}

const EVENT_NAME = "connectors:credentials:rotated"
const GENERATION_PREFIX = "cognia:connectors:credentials-revision:"
const bus: EventTarget = new EventTarget()
const unpersistedGenerations = new Map<string, string>()
const persistedGenerations = new Map<string, string>()

function revisionStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

function parseGeneration(value: string | null): string | undefined {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined
}

/** A nonsecret revision for account-bound display caches and late-result fences. */
export function getCredentialsGeneration(adapterId: string): string {
  try {
    const persisted = parseGeneration(
      revisionStorage()?.getItem(GENERATION_PREFIX + adapterId) ?? null
    )
    if (persisted) persistedGenerations.set(adapterId, persisted)
  } catch {
    // Storage availability must not prevent credential rotation in this renderer.
  }
  const local = unpersistedGenerations.get(adapterId) ?? "0"
  const persisted = persistedGenerations.get(adapterId) ?? "0"
  // A failed save of the revision must never be undone by subsequently reading
  // the old stored revision. The local nonce remains part of the cache identity.
  return local === "0" && persisted === "0" ? "0" : `${local}:${persisted}`
}

export function emitCredentialsRotated(adapterId: string): void {
  if (!adapterId) return
  getCredentialsGeneration(adapterId)
  // Independent windows can save in the same millisecond; read/increment/write
  // counters would assign the same revision and suppress the second storage event.
  const generation = crypto.randomUUID()
  unpersistedGenerations.set(adapterId, generation)
  try {
    const storage = revisionStorage()
    if (storage) {
      storage.setItem(GENERATION_PREFIX + adapterId, generation)
      persistedGenerations.set(adapterId, generation)
      unpersistedGenerations.delete(adapterId)
    }
  } catch {
    // The in-memory event still invalidates this renderer when storage is unavailable.
  }
  const detail: CredentialsRotatedDetail = {
    adapterId,
    rotatedAt: Date.now(),
  }
  bus.dispatchEvent(new CustomEvent<CredentialsRotatedDetail>(EVENT_NAME, { detail }))
}

export function onCredentialsRotated(
  handler: (detail: CredentialsRotatedDetail) => void
): () => void {
  const observed = new Map<string, string>()
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<CredentialsRotatedDetail>).detail
    if (!detail) return
    observed.set(detail.adapterId, getCredentialsGeneration(detail.adapterId))
    try {
      handler(detail)
    } catch (err) {
      console.error(
        `[credentials-events] handler threw for adapter ${detail.adapterId}:`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }
  const storageListener = (event: StorageEvent) => {
    if (!event.key?.startsWith(GENERATION_PREFIX)) return
    if (event.storageArea && event.storageArea !== revisionStorage()) return
    const adapterId = event.key.slice(GENERATION_PREFIX.length)
    const generation = parseGeneration(event.newValue)
    const current = adapterId ? getCredentialsGeneration(adapterId) : "0"
    if (
      !adapterId ||
      !generation ||
      current === observed.get(adapterId) ||
      generation !== persistedGenerations.get(adapterId)
    )
      return
    listener(
      new CustomEvent<CredentialsRotatedDetail>(EVENT_NAME, {
        detail: { adapterId, rotatedAt: Date.now() },
      })
    )
  }
  bus.addEventListener(EVENT_NAME, listener)
  if (typeof window !== "undefined") window.addEventListener("storage", storageListener)
  return () => {
    bus.removeEventListener(EVENT_NAME, listener)
    if (typeof window !== "undefined") window.removeEventListener("storage", storageListener)
  }
}

/** Test helper — resets revision memory; listeners still use their unsubscribe handles. */
export function __resetCredentialsEventsForTesting(): void {
  unpersistedGenerations.clear()
  persistedGenerations.clear()
}
