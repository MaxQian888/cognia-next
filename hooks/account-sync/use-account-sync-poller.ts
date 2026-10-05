"use client"

/**
 * The foreground poller of account sync (ADR-0215 phase 2): every 20 s while
 * the flag is on, the page is visible and the profile is signed in to the
 * official account, look at the space and announce devices waiting for an
 * approval. A hidden page stops polling; becoming visible looks at once.
 * Failures back off to five minutes. An action asks for a look through the
 * store's `requestRefresh`.
 *
 * Off means off: with `enabled` false the hook schedules nothing and never
 * resolves a session or touches the network (`use-account-sync-poller.test.ts`).
 */

import { useEffect, useRef } from "react"

import {
  clearRequestNotification,
  notifyIncomingRequest,
  type RequestNotificationText,
} from "@/lib/account-sync/approval-notifications"
import type { IncomingRequest } from "@/lib/account-sync/enrollment/approve"
import {
  createAccountSyncContext,
  type AccountSyncContext,
} from "@/lib/account-sync/enrollment/context"
import { pollAccountSync, pollDelayMs, requestChanges } from "@/lib/account-sync/poll"
import { officialSyncSession } from "@/lib/account-sync/sync-session"
import { useAccountSyncStore } from "@/stores/account-sync/account-sync-store"

export interface UseAccountSyncPollerOptions {
  enabled: boolean
  notificationText: (request: IncomingRequest) => RequestNotificationText
  /** Test seam; defaults to the profile's official sync session. */
  resolveContext?: () => Promise<AccountSyncContext | null>
  /** Test seam. */
  poll?: typeof pollAccountSync
}

/** One context per profile, space and host, so the API keeps its server clock offset. */
function contextResolver(): () => Promise<AccountSyncContext | null> {
  let cached: { key: string; context: AccountSyncContext } | null = null
  return async () => {
    const session = await officialSyncSession()
    if (!session) {
      cached = null
      return null
    }
    const key = `${session.localAccountId}\u0000${session.spaceId}\u0000${session.syncUrl}`
    if (cached?.key !== key) cached = { key, context: createAccountSyncContext(session) }
    return cached.context
  }
}

export function useAccountSyncPoller(options: UseAccountSyncPollerOptions): void {
  const refreshNonce = useAccountSyncStore((state) => state.refreshNonce)
  const lookNow = useRef<(() => void) | null>(null)
  const textRef = useRef(options.notificationText)
  useEffect(() => {
    textRef.current = options.notificationText
  })
  const { enabled, resolveContext, poll } = options

  useEffect(() => {
    if (!enabled) return
    const resolve = resolveContext ?? contextResolver()
    const look = poll ?? pollAccountSync
    const announced = new Set<string>()
    let cancelled = false
    let running = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void run(), delay)
    }

    const run = async () => {
      if (cancelled || running) return
      // A hidden page waits for `visibilitychange` instead of polling.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return
      running = true
      try {
        const context = await resolve()
        const result = await look(context)
        if (cancelled) return
        useAccountSyncStore.getState().applyPoll(result, context, Date.now())
        const { added, ended } = requestChanges(announced, result.incoming)
        for (const request of added) {
          announced.add(request.requestId)
          void notifyIncomingRequest(request, textRef.current(request)).catch(() => {})
        }
        for (const requestId of ended) {
          announced.delete(requestId)
          void clearRequestNotification(requestId).catch(() => {})
        }
        failures = 0
      } catch (error) {
        failures += 1
        if (!cancelled)
          useAccountSyncStore
            .getState()
            .failPoll(error instanceof Error ? error.message : String(error))
      } finally {
        running = false
        if (!cancelled) schedule(pollDelayMs(failures))
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === "visible") schedule(0)
    }
    document.addEventListener("visibilitychange", onVisibility)
    lookNow.current = () => schedule(0)
    schedule(0)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
      lookNow.current = null
    }
  }, [enabled, resolveContext, poll])

  useEffect(() => {
    if (refreshNonce > 0) lookNow.current?.()
  }, [refreshNonce])
}
