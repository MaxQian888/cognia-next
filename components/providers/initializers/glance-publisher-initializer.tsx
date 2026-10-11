"use client"

/**
 * Main-window publisher of `GlanceSnapshotV1` (ADR-0225 §7).
 *
 * Glance consumers (the tray panel window today) own no Dexie and no stores.
 * This initializer is what gives them something to render, and the only place
 * their requests run:
 *
 * - Consumers announce themselves over `glance://subscribe` while visible. A
 *   subscription is a lease; while at least one is live the sources run and
 *   every change is pushed to each live consumer, coalesced to one push per
 *   frame-ish window. With none live, nothing is computed.
 * - Requests arrive over `glance://request`, are validated whole
 *   (`parseGlanceRequest`), executed through the owning subsystem's own path,
 *   and answered over `glance://result` to the consumer that asked.
 *
 * Nothing here approves, stops or answers a task: those requests do not exist
 * (ADR-0225 §1). A Fleet click opens the island on that row instead.
 */

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"

import { useGlanceSources, type UseGlanceSourcesResult } from "@/hooks/glance/use-glance-sources"
import { glanceOwnerHref } from "@/lib/glance/owner-routes"
import { normalizeGlancePanelSettings } from "@/lib/glance/presets"
import { parseGlanceRequest, type GlanceRequest } from "@/lib/glance/requests"
import { GLANCE_SNAPSHOT_VERSION, type GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import { GlanceSubscriptionRegistry } from "@/lib/glance/subscriptions"
import { sendIslandFocusRow } from "@/lib/island/client"
import { requestIslandFocus } from "@/lib/island/focus-request"
import { getIslandProjection } from "@/lib/island/projection-store"
import { requestNotificationCenter } from "@/lib/notifications/center-request"
import { isMainAppWindow } from "@/lib/pet/window-role"
import { executeCommand, getCommand } from "@/lib/plugin/commands/registry"
import { isTauri } from "@/lib/tauri"
import { isIslandWindowOpen, openIslandWindow } from "@/lib/tauri/fleet"
import {
  GLANCE_LEASE_TTL_MS,
  onGlanceRequest,
  onGlanceSubscription,
  sendGlanceResult,
  sendGlanceSnapshot,
} from "@/lib/tauri/glance"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui"
import type { GlancePanelSettings } from "@/types/glance/layout"

/** Pushes are coalesced to at most one per this window. */
export const GLANCE_PUSH_DEBOUNCE_MS = 120
/** How often lapsed leases are swept. */
export const GLANCE_PRUNE_INTERVAL_MS = 10_000

async function focusMainWindow(): Promise<void> {
  if (!isTauri()) return
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    const window = getCurrentWindow()
    await window.show()
    await window.setFocus()
  } catch {
    // Focusing is a courtesy; the navigation already happened.
  }
}

/** Apply a settings change to the stored glance layout. */
async function patchLayout(apply: (current: GlancePanelSettings) => GlancePanelSettings) {
  const store = useSettingsStore.getState()
  const current = normalizeGlancePanelSettings(store.settings?.trayPanelLayout)
  await store.save({ trayPanelLayout: apply(current) })
}

export interface GlanceRequestDeps {
  sources: UseGlanceSourcesResult
  navigate: (path: string) => void
}

/** Run one validated request. Resolves to the result's `errorKey`, or null on success. */
export async function executeGlanceRequest(
  request: GlanceRequest,
  deps: GlanceRequestDeps
): Promise<string | null> {
  switch (request.kind) {
    case "refresh": {
      const config = normalizeGlancePanelSettings(
        useSettingsStore.getState().settings?.trayPanelLayout
      )
      await Promise.all([
        deps.sources.quota.refreshAll(),
        config.options.usage.scope === "all-tools"
          ? deps.sources.refreshUsage()
          : Promise.resolve(),
      ])
      return null
    }
    case "open-fleet": {
      // A count click names a state, not a row: focus the first row in it, so
      // "2 awaiting" lands on a task that is actually waiting.
      const rowId =
        request.rowId ??
        (request.filter
          ? (getIslandProjection()?.rows.find(
              (row) =>
                (request.filter === "awaiting" && row.status === "blocked") ||
                (request.filter === "working" && row.status === "working") ||
                (request.filter === "failed" && row.status === "failed")
            )?.id ?? null)
          : null)
      const opened = await requestIslandFocus(rowId, {
        isOpen: isIslandWindowOpen,
        open: () => openIslandWindow(),
        send: sendIslandFocusRow,
        now: Date.now,
      })
      if (opened) return null
      // No island (it failed to open): the run history lists the same work.
      deps.navigate(glanceOwnerHref("fleet"))
      await focusMainWindow()
      return null
    }
    case "open-owner": {
      await focusMainWindow()
      if (request.owner === "notifications" && requestNotificationCenter()) return null
      deps.navigate(glanceOwnerHref(request.owner, request.itemId))
      return null
    }
    case "open-session": {
      useChatStore.getState().setActiveSession(request.sessionId)
      useUIStore.getState().setSelectedGuild({ kind: "dm" })
      deps.navigate("/")
      await focusMainWindow()
      return null
    }
    case "quota-refresh":
      return (await deps.sources.quota.refreshOne(request.key)) ? null : "errors.quotaRefresh"
    case "quota-enable":
      return (await deps.sources.quota.enable(request.provider, request.accountId))
        ? null
        : "errors.quotaEnable"
    case "set-scope":
      await patchLayout((c) => ({ ...c, scope: request.scope }))
      return null
    case "set-usage-scope":
      await patchLayout((c) => ({
        ...c,
        options: { ...c.options, usage: { ...c.options.usage, scope: request.scope } },
      }))
      return null
    case "set-show-spend":
      await patchLayout((c) => ({
        ...c,
        options: { ...c.options, usage: { ...c.options.usage, showSpend: request.showSpend } },
      }))
      return null
    case "set-activity-range":
      await patchLayout((c) => ({
        ...c,
        options: { ...c.options, activity: { range: request.range } },
      }))
      return null
    case "set-max-height":
      await patchLayout((c) => ({ ...c, maxHeight: request.maxHeight }))
      return null
    case "set-width":
      await patchLayout((c) => ({ ...c, width: request.width }))
      return null
    case "pet-care":
      if (!getCommand(request.command)) return "errors.commandUnavailable"
      await executeCommand(request.command)
      return null
  }
}

export function GlancePublisherInitializer() {
  const router = useRouter()
  const registry = useRef(new GlanceSubscriptionRegistry(GLANCE_LEASE_TTL_MS))
  const [active, setActive] = useState(false)
  const sources = useGlanceSources(active)

  const epoch = useRef(0)
  const revision = useRef(0)
  const latest = useRef<GlanceSnapshotV1 | null>(null)
  const sourcesRef = useRef(sources)
  const routerRef = useRef(router)
  useEffect(() => {
    sourcesRef.current = sources
    routerRef.current = router
  }, [sources, router])

  // Build the snapshot on every source change and push it, coalesced.
  useEffect(() => {
    if (!active) return
    if (epoch.current === 0) epoch.current = Date.now()
    revision.current += 1
    latest.current = {
      version: GLANCE_SNAPSHOT_VERSION,
      epoch: epoch.current,
      revision: revision.current,
      ...sources.body,
    }
    const timer = setTimeout(() => {
      const snapshot = latest.current
      if (!snapshot) return
      for (const lease of registry.current.live(Date.now())) {
        void sendGlanceSnapshot(lease.windowLabel, snapshot)
      }
    }, GLANCE_PUSH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [active, sources.body])

  useEffect(() => {
    if (!isTauri() || !isMainAppWindow()) return
    let alive = true
    const offs: Array<() => void> = []
    const track = (off: () => void) => (alive ? offs.push(off) : off())

    void onGlanceSubscription((subscription) => {
      if (!alive) return
      const now = Date.now()
      const changed = registry.current.announce(subscription, now)
      setActive(registry.current.hasLive(now))
      // A consumer that just appeared gets the newest snapshot at once, before
      // the sources even notice it, so it never paints empty.
      if (changed && subscription.visible && latest.current) {
        void sendGlanceSnapshot(subscription.windowLabel, latest.current)
      }
    }).then(track)

    void onGlanceRequest((payload) => {
      if (!alive) return
      const request = parseGlanceRequest(payload)
      if (!request) return
      const windowLabel = registry.current.windowOf(request.consumer, Date.now())
      void executeGlanceRequest(request, {
        sources: sourcesRef.current,
        navigate: (path) => routerRef.current.push(path),
      })
        .then((errorKey) => {
          if (windowLabel) {
            void sendGlanceResult(windowLabel, {
              requestId: request.requestId,
              ok: errorKey === null,
              ...(errorKey ? { errorKey } : {}),
            })
          }
        })
        .catch(() => {
          if (windowLabel) {
            void sendGlanceResult(windowLabel, {
              requestId: request.requestId,
              ok: false,
              errorKey: "errors.requestFailed",
            })
          }
        })
    }).then(track)

    const prune = setInterval(() => {
      const now = Date.now()
      if (registry.current.prune(now)) setActive(registry.current.hasLive(now))
    }, GLANCE_PRUNE_INTERVAL_MS)

    return () => {
      alive = false
      clearInterval(prune)
      offs.forEach((off) => off())
    }
  }, [])

  return null
}

export default GlancePublisherInitializer
