"use client"

// Reactive access to the Unified Notification Center (ADR-0042). Hydrates the
// store from Dexie once on mount, then re-renders on every `ingest`/mutation.
// `refresh` lets the bell/center re-pull (e.g. on open) to surface records
// whose snooze just elapsed.

import { useEffect } from "react"
import { useNotificationStore } from "@/stores/notifications/notification-store"

export function useNotifications() {
  const items = useNotificationStore((s) => s.items)
  const directedUnread = useNotificationStore((s) => s.directedUnread)
  const ambientUnseen = useNotificationStore((s) => s.ambientUnseen)
  const hydrated = useNotificationStore((s) => s.hydrated)
  const sourceFilter = useNotificationStore((s) => s.sourceFilter)
  const hydrate = useNotificationStore((s) => s.hydrate)

  useEffect(() => {
    if (!hydrated) void hydrate()
  }, [hydrated, hydrate])

  const visible = sourceFilter ? items.filter((r) => r.source === sourceFilter) : items

  return {
    items: visible,
    allItems: items,
    directedUnread,
    ambientUnseen,
    hasUnread: directedUnread > 0 || ambientUnseen > 0,
    hydrated,
    sourceFilter,
    refresh: hydrate,
    markSeen: useNotificationStore.getState().markSeen,
    markRead: useNotificationStore.getState().markRead,
    markDone: useNotificationStore.getState().markDone,
    restore: useNotificationStore.getState().restore,
    markAllRead: useNotificationStore.getState().markAllRead,
    archiveAll: useNotificationStore.getState().archiveAll,
    snooze: useNotificationStore.getState().snooze,
    unsnooze: useNotificationStore.getState().unsnooze,
    remove: useNotificationStore.getState().remove,
    clearAll: useNotificationStore.getState().clearAll,
    setSourceFilter: useNotificationStore.getState().setSourceFilter,
  }
}
