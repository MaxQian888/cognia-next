"use client"

import { useEffect } from "react"
import { useTranslations } from "next-intl"

import {
  interruptRendererBackgroundTasksOnBoot,
  setRendererBackgroundSettleListener,
} from "@/lib/background-tasks/renderer-subagent-registry"
import {
  onBackgroundRunSettled,
  registerBackgroundResultNotifyStrings,
} from "@/hooks/chat/background-result-runtime"
import {
  redispatchBackgroundRun,
  DEFAULT_MAX_AUTO_RESUME_ATTEMPTS,
} from "@/lib/background-tasks/redispatch"

/**
 * Boot lifecycle for background subagent runs:
 *  1. wire the settle listener (completion re-injection + notifications) and
 *     its localized copy,
 *  2. reconcile orphaned `running` journal rows to `interrupted`,
 *  3. prune stale settled history (age + cap),
 *  4. opt-in: auto-resume THIS boot's interrupted runs (attempt-capped).
 */
export function BackgroundTaskInitializer() {
  const t = useTranslations("desktop.jobCenter.notify")

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
    void (async () => {
      const interrupted = await interruptRendererBackgroundTasksOnBoot()

      try {
        const { pruneBackgroundTaskRecords } = await import("@/lib/db/background-tasks")
        await pruneBackgroundTaskRecords({ now: Date.now(), host: "renderer" })
      } catch {
        // Retention is best-effort.
      }

      if (interrupted.length === 0) return
      try {
        const { getSettings } = await import("@/lib/db/settings")
        const settings = await getSettings()
        const bg = settings?.backgroundTasks
        if (!bg?.autoResumeInterrupted) return
        const cap = bg.maxAutoResumeAttempts ?? DEFAULT_MAX_AUTO_RESUME_ATTEMPTS
        let resumed = 0
        for (const record of interrupted) {
          if (record.kind !== "subagent" || record.mode !== "background") continue
          const outcome = await redispatchBackgroundRun(record, {
            kind: "auto",
            maxAutoResumeAttempts: cap,
          })
          if (outcome.ok) resumed += 1
        }
        if (resumed > 0) {
          const { notify } = await import("@/lib/notifications/runtime")
          await notify({
            source: "session",
            level: "info",
            title: t("autoResumed", { count: resumed }),
            channels: ["center", "toast"],
            dedupeKey: "background-auto-resume",
          })
        }
      } catch {
        // Auto-resume is opt-in convenience; boot must never fail on it.
      }
    })()
    // Boot-once semantics; `t` only affects the summary copy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
