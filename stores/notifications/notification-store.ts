// Notification store (ADR-0042) — the reactive in-memory mirror of the Dexie
// `notifications` table that drives the bell badge + center panel. Not
// persisted (Dexie is the source of truth); `hydrate()` loads the active feed
// and `ingest()` is the `notify()` `onRecord` hook. Read-state cascade is the
// pure `cascadeReadState`; snooze uses `snoozeUntil`.

import { create } from "zustand"
import type { NotificationRecord, NotificationSource } from "@/types/notifications"
import {
  listNotifications,
  getNotification,
  patchNotification,
  deleteNotification,
  clearNotifications,
} from "@/lib/db/notifications"
import { cascadeReadState } from "@/lib/notifications/read-state"
import { snoozeUntil, isSnoozed } from "@/lib/notifications/snooze"

const now = () => Date.now()

/** Pure: badge counts from the active (non-done) feed at `at`. */
export function recomputeCounts(
  items: NotificationRecord[],
  at: number
): { directedUnread: number; ambientUnseen: number } {
  let directedUnread = 0
  let ambientUnseen = 0
  for (const r of items) {
    if (r.readState === "done") continue
    if (isSnoozed(r, at)) continue
    if (r.directed && (r.readState === "unseen" || r.readState === "seen")) directedUnread += 1
    if (r.readState === "unseen") ambientUnseen += 1
  }
  return { directedUnread, ambientUnseen }
}

function upsert(items: NotificationRecord[], rec: NotificationRecord): NotificationRecord[] {
  const idx = items.findIndex((r) => r.id === rec.id)
  if (idx === -1) return [rec, ...items]
  const next = items.slice()
  next[idx] = rec
  return next
}

export interface NotificationStoreState {
  items: NotificationRecord[]
  directedUnread: number
  ambientUnseen: number
  hydrated: boolean
  /** Source filter for the panel (undefined = all). */
  sourceFilter?: NotificationSource

  hydrate: () => Promise<void>
  /** `notify()` onRecord hook — upsert + recompute. */
  ingest: (rec: NotificationRecord) => void
  markSeen: (id: string) => Promise<void>
  markRead: (id: string) => Promise<void>
  markDone: (id: string) => Promise<void>
  markAllRead: () => Promise<void>
  snooze: (id: string, durationMs: number) => Promise<void>
  unsnooze: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  clearAll: () => Promise<void>
  setSourceFilter: (source?: NotificationSource) => void
}

function recount(set: (p: Partial<NotificationStoreState>) => void, items: NotificationRecord[]) {
  set({ items, ...recomputeCounts(items, now()) })
}

export const useNotificationStore = create<NotificationStoreState>()((set, get) => ({
  items: [],
  directedUnread: 0,
  ambientUnseen: 0,
  hydrated: false,
  sourceFilter: undefined,

  hydrate: async () => {
    const items = await listNotifications({ hideSnoozedAfter: now() })
    set({ items, hydrated: true, ...recomputeCounts(items, now()) })
  },

  ingest: (rec) => {
    if (rec.readState === "done") {
      // Coalesce bump should not resurrect a done row into the active feed.
      const items = get().items.filter((r) => r.id !== rec.id)
      recount(set, items)
      return
    }
    recount(set, upsert(get().items, rec))
  },

  markSeen: async (id) => {
    const rec = get().items.find((r) => r.id === id)
    if (!rec) return
    const patch = cascadeReadState(rec, "seen", now())
    if (Object.keys(patch).length === 0) return
    await patchNotification(id, patch)
    recount(
      set,
      get().items.map((r) => (r.id === id ? { ...r, ...patch } : r))
    )
  },

  markRead: async (id) => {
    const rec = get().items.find((r) => r.id === id)
    if (!rec) return
    const patch = cascadeReadState(rec, "read", now())
    if (Object.keys(patch).length === 0) return
    await patchNotification(id, patch)
    recount(
      set,
      get().items.map((r) => (r.id === id ? { ...r, ...patch } : r))
    )
  },

  markDone: async (id) => {
    const rec = get().items.find((r) => r.id === id)
    if (!rec) return
    const patch = cascadeReadState(rec, "done", now())
    await patchNotification(id, patch.readState ? patch : { readState: "done", doneAt: now() })
    // Done leaves the active feed.
    recount(
      set,
      get().items.filter((r) => r.id !== id)
    )
  },

  markAllRead: async () => {
    const t = now()
    const patches = get()
      .items.filter((r) => r.readState === "unseen" || r.readState === "seen")
      .map((r) => ({ id: r.id, patch: cascadeReadState(r, "read", t) }))
    await Promise.all(patches.map((p) => patchNotification(p.id, p.patch)))
    const patchById = new Map(patches.map((p) => [p.id, p.patch]))
    recount(
      set,
      get().items.map((r) => (patchById.has(r.id) ? { ...r, ...patchById.get(r.id)! } : r))
    )
  },

  snooze: async (id, durationMs) => {
    const until = snoozeUntil(now(), durationMs)
    await patchNotification(id, { snoozedUntil: until })
    // Snoozed items leave the active feed.
    recount(
      set,
      get().items.filter((r) => r.id !== id)
    )
  },

  unsnooze: async (id) => {
    await patchNotification(id, { snoozedUntil: undefined })
    // Snoozed rows left the active feed — re-fetch and re-insert if still active.
    const rec = await getNotification(id)
    if (rec && rec.readState !== "done") {
      recount(set, upsert(get().items, { ...rec, snoozedUntil: undefined }))
    }
  },

  remove: async (id) => {
    await deleteNotification(id)
    recount(
      set,
      get().items.filter((r) => r.id !== id)
    )
  },

  clearAll: async () => {
    await clearNotifications()
    set({ items: [], directedUnread: 0, ambientUnseen: 0 })
  },

  setSourceFilter: (source) => set({ sourceFilter: source }),
}))

export default useNotificationStore
