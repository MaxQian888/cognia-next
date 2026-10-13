/** Shared collaboration subscriptions for a renderer or an always-on brain. */
import { installCollabFeed, type CollabFeedDeps } from "@/lib/collab/feed"
import {
  installCollabNotificationsSync,
  type InstallCollabNotificationsSyncDeps,
} from "@/lib/collab/notifications-sync"
import { subscribeCollabConnection } from "@/lib/collab/connection"
import type { RefreshCollabPlaneResult } from "@/lib/collab/refresh"
import { registerHeadlessRuntime } from "../registry"

/** The brain supplies its file-backed session and durable notification cursor. */
export interface HeadlessCollabAdapter {
  resolve: (localAccountId: string) => ReturnType<NonNullable<CollabFeedDeps["resolve"]>>
  refresh: NonNullable<CollabFeedDeps["refreshLegs"]>
  local: NonNullable<InstallCollabNotificationsSyncDeps["local"]>
  refreshAll: () => Promise<RefreshCollabPlaneResult | null>
}

export interface CollabRuntimeDeps {
  feed?: CollabFeedDeps
  notifications?: InstallCollabNotificationsSyncDeps
  subscribeConnection?: typeof subscribeCollabConnection
}

export function startCollabRuntime(
  localAccountId: string,
  deps: CollabRuntimeDeps = {}
): () => void {
  const install = () => {
    const detachFeed = installCollabFeed(localAccountId, deps.feed)
    let detachNotifications: () => void
    try {
      detachNotifications = installCollabNotificationsSync(localAccountId, deps.notifications)
    } catch (error) {
      detachFeed()
      throw error
    }
    return () => {
      detachNotifications()
      detachFeed()
    }
  }
  let detach = install()
  let stopped = false
  let unsubscribe: () => void
  try {
    unsubscribe = (deps.subscribeConnection ?? subscribeCollabConnection)(() => {
      if (stopped) return
      detach()
      detach = () => undefined
      detach = install()
    })
  } catch (error) {
    detach()
    throw error
  }
  return () => {
    if (stopped) return
    stopped = true
    unsubscribe()
    detach()
  }
}

registerHeadlessRuntime({
  name: "collab-runtime",
  hosts: ["brain"],
  start: (ctx) => {
    const adapter = ctx.collab
    if (!adapter) return
    return startCollabRuntime(ctx.localAccountId, {
      feed: {
        resolve: () => adapter.resolve(ctx.localAccountId),
        refreshLegs: adapter.refresh,
        setTimeout: (callback, ms) => {
          const timer = setTimeout(callback, ms)
          timer.unref?.()
          return timer
        },
      },
      notifications: { resolve: adapter.resolve, local: adapter.local },
    })
  },
})
