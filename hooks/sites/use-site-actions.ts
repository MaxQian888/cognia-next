"use client"

/**
 * One place to run a Site action: single-flight busy tracking, a toast on both
 * outcomes, and the per-actor `CloudflareSitesService` factory.
 *
 * The service is built per call rather than held in state because every method
 * loads the provider token from the keyring at call time — a long-lived
 * instance would pin a stale token after the user re-saves one.
 */
import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { CloudflareSitesService } from "@/lib/sites/cloudflare/service"

export interface SiteActionRunOptions {
  /** Localized success toast. Pass null to stay silent (the UI shows the result). */
  successMessage?: string | null
}

export interface SiteActions {
  /** Key of the action in flight, or null. One action at a time, by design. */
  busy: string | null
  isBusy: (key?: string) => boolean
  /** Fresh, actor-bound service instance. */
  service: () => CloudflareSitesService
  /**
   * Run one action. Resolves to the action's value on success and `undefined`
   * on failure — failures are reported through the toast, so callers that only
   * need the happy path can ignore the result without an unhandled rejection.
   */
  run: <T>(
    key: string,
    action: () => Promise<T>,
    options?: SiteActionRunOptions
  ) => Promise<T | undefined>
}

export function useSiteActions(actorAccountId: string): SiteActions {
  const t = useTranslations("sites")
  const [busy, setBusy] = useState<string | null>(null)

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
      setBusy(key)
      try {
        const value = await action()
        const message = options?.successMessage
        if (message !== null) toast.success(message ?? t("feedback.success"))
        return value
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
        return undefined
      } finally {
        setBusy(null)
      }
    },
    [t]
  )

  const isBusy = useCallback(
    (key?: string) => (key === undefined ? busy !== null : busy === key),
    [busy]
  )

  return { busy, isBusy, service, run }
}
