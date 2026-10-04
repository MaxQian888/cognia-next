"use client"

import { useEffect } from "react"
import { useTranslations } from "next-intl"

import { setRendererBackgroundSettleListener } from "@/lib/background-tasks/renderer-subagent-registry"
import {
  onBackgroundRunSettled,
  registerBackgroundResultNotifyStrings,
} from "@/hooks/chat/background-result-runtime"
import { startBackgroundTaskRecovery } from "@/lib/background-tasks/redispatch"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import { useAccountStore } from "@/stores/account/account-store"

/**
 * Account-scoped lifecycle for background subagent runs:
 *  1. wire the settle listener (completion re-injection + notifications) and
 *     its localized copy,
 *  2. periodically reconcile expired execution owners to `interrupted`,
 *  3. prune stale settled history (age + cap),
 *  4. opt-in: recover safe interrupted runs through the shared dispatch path.
 */
export function BackgroundTaskInitializer() {
  const t = useTranslations("desktop.jobCenter.notify")
  const accountRevision = useAccountStore((state) => state.accountRevision)
  const { target, vaultState } = useRuntimeSnapshot()
  const targetId = target?.id

  useEffect(() => {
    setRendererBackgroundSettleListener(onBackgroundRunSettled)
    const unregisterStrings = registerBackgroundResultNotifyStrings({
      title: ({ subagentId, status, elapsed }) =>
        status === "done"
          ? t("doneTitle", { subagentId, elapsed })
          : t("failedTitle", { subagentId, elapsed }),
      body: ({ runId }) => t("body", { runId }),
    })
    return () => {
      setRendererBackgroundSettleListener(undefined)
      unregisterStrings()
    }
    // `t` is stable per locale; re-registering on locale change is desired.
  }, [t])

  useEffect(() => {
    if (vaultState !== "unlocked" || !targetId) return
    let disposed = false
    const stop = startBackgroundTaskRecovery({
      onResumed: async (count) => {
        const { notify } = await import("@/lib/notifications/runtime")
        if (disposed) return
        await notify({
          source: "session",
          level: "info",
          title: t("autoResumed", { count }),
          channels: ["center", "toast"],
          dedupeKey: "background-auto-resume",
        })
      },
    })
    return () => {
      disposed = true
      stop()
    }
  }, [accountRevision, targetId, vaultState, t])

  return null
}
