"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"

import { useApprovalJournalStore } from "@/stores/agent/approval-journal-store"

/**
 * One-shot boot notice for interrupted tool approvals. On rehydrate the
 * approval journal marks every unsettled ask `interrupted` (its sidecar waiter
 * died with the previous page). This surfaces "N approvals were interrupted"
 * once at startup so a crash/restart never silently swallows a pending ask; the
 * items themselves live in the attention panel (Dismiss to clear).
 */
export function ApprovalJournalInitializer() {
  const t = useTranslations("attention")
  const fired = useRef(false)

  useEffect(() => {
    if (fired.current) return
    fired.current = true
    void (async () => {
      // Let zustand persist finish rehydrating (onRehydrateStorage runs async).
      await Promise.resolve()
      const interrupted = useApprovalJournalStore
        .getState()
        .entries.filter((e) => e.status === "interrupted")
      if (interrupted.length === 0) return
      try {
        const { notify } = await import("@/lib/notifications/runtime")
        await notify({
          source: "session",
          level: "warning",
          title: t("interruptedOnBoot", { count: interrupted.length }),
          channels: ["center", "toast"],
          dedupeKey: "approval-journal-interrupted-boot",
        })
      } catch {
        // Boot notice is best-effort.
      }
    })()
  }, [t])

  return null
}
