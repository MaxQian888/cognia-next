"use client"

/**
 * One place to run a Site action: per-key busy tracking, a toast on both
 * outcomes, and the per-actor `CloudflareSitesService` factory.
 *
 * The service is built per call rather than held in state because every method
 * loads the provider token from the keyring at call time — a long-lived
 * instance would pin a stale token after the user re-saves one.
 *
 * **Busy is per key, not global.** The console used to hold one `busy: string |
 * null` and disable every control whenever any of them was set, so a
 * ten-minute build froze the domains form, the access policy, and every other
 * version's Upload button. It also claimed single-flight in this comment and
 * did not implement it: two clicks both ran, and whichever finished first
 * cleared the flag for both. Keys are now tracked in a set, a second `run` for
 * a key already in flight is refused outright, and only the handful of actions
 * that genuinely act on the whole Site ({@link SiteActionRunOptions.exclusive})
 * disable everything.
 */
import { useCallback, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { CloudflareSitesService } from "@/lib/sites/cloudflare/service"

export interface SiteActionRunOptions {
  /** Localized success toast. Pass null to stay silent (the UI shows the result). */
  successMessage?: string | null
  /**
   * Lifecycle mutations that change what every other control would act on —
   * takedown, restore, purge, deleting the metadata. While one is in flight
   * `isBusy()` is true for every key, not just its own.
   */
  exclusive?: boolean
}

export interface SiteActions {
  /** Keys currently in flight. */
  busyKeys: ReadonlySet<string>
  /**
   * `isBusy()` — anything exclusive is running.
   * `isBusy(key)` — that key is running, or something exclusive is.
   */
  isBusy: (key?: string) => boolean
  /** Fresh, actor-bound service instance. */
  service: () => CloudflareSitesService
  /**
   * Run one action. Resolves to the action's value on success and `undefined`
   * on failure — failures are reported through the toast, so callers that only
   * need the happy path can ignore the result without an unhandled rejection.
   *
   * A key already in flight resolves to `undefined` immediately without
   * running or toasting: a double-click is not a second intention.
   */
  run: <T>(
    key: string,
    action: () => Promise<T>,
    options?: SiteActionRunOptions
  ) => Promise<T | undefined>
}

export function useSiteActions(actorAccountId: string): SiteActions {
  const t = useTranslations("sites")
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [exclusiveCount, setExclusiveCount] = useState(0)
  // The guard reads the ref, not the state: two clicks inside one tick both see
  // the same stale state, and the second would slip through.
  const inFlight = useRef(new Set<string>())

  const service = useMemo(
    () => () => new CloudflareSitesService({ actorAccountId }),
    [actorAccountId]
  )

  const run = useCallback(
    async <T>(
      key: string,
      action: () => Promise<T>,
      options?: SiteActionRunOptions
    ): Promise<T | undefined> => {
      if (inFlight.current.has(key)) return undefined
      inFlight.current.add(key)
      setBusyKeys(new Set(inFlight.current))
      if (options?.exclusive) setExclusiveCount((count) => count + 1)
      try {
        const value = await action()
        const message = options?.successMessage
        if (message !== null) toast.success(message ?? t("feedback.success"))
        return value
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
        return undefined
      } finally {
        inFlight.current.delete(key)
        setBusyKeys(new Set(inFlight.current))
        if (options?.exclusive) setExclusiveCount((count) => count - 1)
      }
    },
    [t]
  )

  const isBusy = useCallback(
    (key?: string) => exclusiveCount > 0 || (key !== undefined && busyKeys.has(key)),
    [busyKeys, exclusiveCount]
  )

  return { busyKeys, isBusy, service, run }
}
