import { isTauri } from "@/lib/platform/detect"
import { publishHostEvent } from "@/lib/companion/host-event-publisher"
import { createMutex, type Mutex } from "@cognia/primitives"
import type { MessagePersistOptions } from "@/lib/db/messages"

type RuntimeInvalidationListener = (
  databaseName: string,
  sessionId: string,
  generation: string,
  pending?: boolean
) => () => void
const runtimeInvalidationListeners = new Set<RuntimeInvalidationListener>()

/** Per-handler cache only; the sessions row remains the write authority. */
export function createTranscriptRuntimeFence(onInvalidated: (sessionId: string) => void) {
  const generations = new Map<
    string,
    { value?: string; rejected?: Set<string | undefined>; pending?: boolean }
  >()
  let listening = false
  let unlistenHost: (() => void) | undefined
  let subscription = 0
  let revisionRefresh = Promise.resolve()
  const listen: RuntimeInvalidationListener = (
    databaseName,
    sessionId,
    generation,
    pending = false
  ) => {
    const key = `${databaseName}:${sessionId}`
    const previous = generations.get(key)
    if (previous?.value === generation) {
      if (!pending) previous.pending = false
      return () => {}
    }
    const next = { value: generation, pending }
    generations.set(key, next)
    while (generations.size > 128) generations.delete(generations.keys().next().value!)
    onInvalidated(sessionId)
    return () => {
      if (generations.get(key) !== next) return
      // A failed close refused the mutation. New events may keep using that
      // runtime; cancelled writes retain their obsolete entry identity.
      if (previous) generations.set(key, { ...previous })
      else generations.delete(key)
    }
  }
  const receiveRevision = (payload: TranscriptRevisionEvent) => {
    if (
      !payload ||
      typeof payload.databaseName !== "string" ||
      typeof payload.runtimeGeneration !== "string"
    )
      return
    const key = `${payload.databaseName}:${payload.sessionId}`
    if (generations.get(key)?.value === payload.runtimeGeneration) return
    const owner = subscription
    // Cross-window notices may arrive out of order. Refresh from the row once
    // per invalidation, never once per token, rather than trusting notice order.
    revisionRefresh = revisionRefresh
      .catch(() => {})
      .then(async () => {
        const { getDb } = await import("@/lib/db/schema")
        if (!listening || owner !== subscription || getDb().name !== payload.databaseName) return
        const previous = generations.get(key)
        const session = await getDb().sessions.get(payload.sessionId)
        if (!listening || owner !== subscription || getDb().name !== payload.databaseName) return
        if (generations.get(key) !== previous || previous?.pending) return
        const generation = session?.runtimeTranscriptGeneration
        if (typeof generation === "string" && generations.get(key)?.value !== generation) {
          listen(payload.databaseName!, payload.sessionId, generation)
        }
      })
    void revisionRefresh.catch(() => {})
  }
  const receiveLocalRevision = (event: Event) =>
    receiveRevision((event as CustomEvent<TranscriptRevisionEvent>).detail)
  return {
    async capture(sessionId: string, generation?: string): Promise<MessagePersistOptions> {
      // Lazy subscription avoids leaking React StrictMode's discarded initializer.
      if (!listening) {
        generations.clear()
        runtimeInvalidationListeners.add(listen)
        listening = true
        if (typeof window !== "undefined")
          window.addEventListener(TRANSCRIPT_REVISION_EVENT, receiveLocalRevision)
        if (isTauri()) {
          const owner = ++subscription
          const moduleId = "@tauri-apps/api/event"
          void import(/* webpackIgnore: true */ moduleId)
            .then(async (events) => {
              const release = await events.listen(
                TRANSCRIPT_REVISION_EVENT,
                (event: { payload: TranscriptRevisionEvent }) => receiveRevision(event.payload)
              )
              if (owner !== subscription || !listening) release()
              else unlistenHost = release
            })
            .catch(() => {
              /* The transaction guard remains authoritative offline. */
            })
        }
      }
      const [{ getDb }, { getSession }] = await Promise.all([
        import("@/lib/db/schema"),
        import("@/lib/db/sessions"),
      ])
      const databaseName = getDb().name
      const key = `${databaseName}:${sessionId}`
      let entry = generations.get(key)
      if (!entry) {
        entry = {}
        generations.set(key, entry)
        const session = await getSession(sessionId)
        if (generations.get(key) === entry) entry.value = session?.runtimeTranscriptGeneration
      }
      if (!entry.pending && entry.value !== generation && !entry.rejected?.has(generation)) {
        // A replacement frame can beat another window's revision notice.
        // Refresh once per rejected identity, never once per stale token.
        const session = await getSession(sessionId)
        if (getDb().name === databaseName && generations.get(key) === entry) {
          const currentGeneration = session?.runtimeTranscriptGeneration
          if (typeof currentGeneration === "string" && currentGeneration !== entry.value) {
            listen(databaseName, sessionId, currentGeneration)
            entry = generations.get(key)!
          }
          if (entry.value !== generation) {
            const rejected = (entry.rejected ??= new Set())
            rejected.add(generation)
            if (rejected.size > 8) rejected.delete(rejected.values().next().value)
          }
        }
      }
      // Bound closed-pane bookkeeping; eviction fails pending writes closed.
      while (generations.size > 128) generations.delete(generations.keys().next().value!)
      const captured = entry
      return {
        runtimeGeneration: { value: generation },
        shouldPersist: () =>
          getDb().name === databaseName &&
          generations.get(key) === captured &&
          captured.value === generation,
      }
    },
    dispose() {
      runtimeInvalidationListeners.delete(listen)
      listening = false
      subscription++
      unlistenHost?.()
      unlistenHost = undefined
      if (typeof window !== "undefined")
        window.removeEventListener(TRANSCRIPT_REVISION_EVENT, receiveLocalRevision)
      // Preserve guards already handed to the unmount flush. The DB checks
      // their generation even after this observer has detached.
    },
  }
}

export type TranscriptRuntimeFence = ReturnType<typeof createTranscriptRuntimeFence>

const runtimeLocks = new Map<string, { mutex: Mutex; users: number }>()

/** Serialize runtime hydration with destructive transcript changes, across windows. */
export async function withTranscriptRuntimeLock<T>(
  sessionId: string,
  action: () => Promise<T>
): Promise<T> {
  const { getDb } = await import("@/lib/db/schema")
  const databaseName = getDb().name
  const key = `cognia:transcript-runtime:${databaseName}:${sessionId}`
  const guardedAction = async () => {
    if (getDb().name !== databaseName) {
      throw new Error("Transcript database changed while waiting for runtime lock")
    }
    return action()
  }
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(key, guardedAction)
  }
  let entry = runtimeLocks.get(key)
  if (!entry) {
    entry = { mutex: createMutex(), users: 0 }
    runtimeLocks.set(key, entry)
  }
  entry.users++
  try {
    return await entry.mutex.runExclusive(guardedAction)
  } finally {
    if (--entry.users === 0) runtimeLocks.delete(key)
  }
}

/** Stop retained provider context before a destructive transcript mutation. */
export async function invalidateTranscriptRuntime(sessionId: string): Promise<void> {
  const { isStandaloneChatMode } = await import("@/lib/runtime/standalone-mode")
  if (isStandaloneChatMode()) return
  const [{ closeSession }, { getDb }, { updateSession }] = await Promise.all([
    import("@/lib/claude/ipc"),
    import("@/lib/db/schema"),
    import("@/lib/db/sessions"),
  ])
  const databaseName = getDb().name
  const assertScope = () => {
    if (getDb().name !== databaseName) throw new Error("Transcript runtime database scope changed")
  }
  const generation = crypto.randomUUID()
  const rollbacks = [...runtimeInvalidationListeners].map((listener) =>
    listener(databaseName, sessionId, generation, true)
  )
  // A failed close enqueue must refuse the mutation. The event generation
  // fence separately rejects frames already queued by the old runtime.
  try {
    await closeSession(sessionId)
    assertScope()
  } catch (error) {
    for (const rollback of rollbacks) rollback()
    throw error
  }
  // Keep native SDK resume identities intact. AI-SDK consumes this generation
  // on reconstruction and clears it only on its matching initialization event.
  await updateSession(sessionId, {
    runtimeTranscriptInvalidated: generation,
    runtimeTranscriptGeneration: generation,
  })
  assertScope()
  for (const listener of runtimeInvalidationListeners) listener(databaseName, sessionId, generation)
  const session = await getDb().sessions.get(sessionId)
  assertScope()
  await publishTranscriptRevision(sessionId, session?.transcriptRevision ?? 0, generation)
}

/** A late initialization must not clear a newer transcript invalidation. */
export async function acknowledgeTranscriptRuntime(
  sessionId: string,
  invalidationId: string
): Promise<void> {
  const { getDb } = await import("@/lib/db/schema")
  const db = getDb()
  await db.transaction("rw", db.sessions, async () => {
    const session = await db.sessions.get(sessionId)
    if (session?.runtimeTranscriptInvalidated !== invalidationId) return
    await db.sessions.update(sessionId, { runtimeTranscriptInvalidated: undefined })
  })
}

export const TRANSCRIPT_REVISION_EVENT = "transcript://revision"

export interface TranscriptRevisionEvent {
  sessionId: string
  revision: number
  /** Present for destructive runtime invalidation; scoped across host windows. */
  runtimeGeneration?: string
  databaseName?: string
}

/** Publish only identity + revision; transcript content never enters event logs. */
export async function publishTranscriptRevision(
  sessionId: string,
  revision: number,
  runtimeGeneration?: string
): Promise<void> {
  const payload: TranscriptRevisionEvent = { sessionId, revision }
  if (runtimeGeneration !== undefined) {
    const { getDb } = await import("@/lib/db/schema")
    payload.runtimeGeneration = runtimeGeneration
    payload.databaseName = getDb().name
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(TRANSCRIPT_REVISION_EVENT, { detail: payload }))
  }
  // The host-neutral publisher: Tauri `emit` on the desktop, the bridge route
  // in the headless brain. Emitting through Tauri alone meant a headless host
  // never told paired clients that a transcript moved, so a reply it kept for
  // a paired browser appeared there only after a reload. Best effort either
  // way: the persisted revision stays authoritative for reconnect.
  await publishHostEvent(TRANSCRIPT_REVISION_EVENT, payload)
}
