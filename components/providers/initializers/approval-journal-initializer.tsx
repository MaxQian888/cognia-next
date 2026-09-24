"use client"

import { useEffect } from "react"
import { useTranslations } from "next-intl"

import { isMainAppWindow } from "@/lib/pet/window-role"
import {
  unannouncedInterrupted,
  useApprovalJournalStore,
} from "@/stores/agent/approval-journal-store"

/**
 * Boot notice for interrupted tool approvals. On rehydrate the approval journal
 * marks every unsettled ask `interrupted` (its sidecar waiter died with the
 * previous page). This surfaces "N approvals were interrupted" so a
 * crash/restart never silently swallows a pending ask; the items themselves
 * stay listed in the attention panel.
 *
 * Each journal entry is announced exactly once. The only guard used to be a
 * `useRef` on this component, but the gates above it (account lock/unlock,
 * onboarding, recovery) remount the provider tree, and every full-layout
 * window mounts its own copy, so the same entries re-toasted on every
 * remount and in every window. The entries now carry a persisted `notifiedAt`
 * stamp, written before the notice is sent so a racing remount finds them
 * already claimed, and only the main app window announces.
 */
export function ApprovalJournalInitializer() {
  const t = useTranslations("attention")

  useEffect(() => {
    if (!isMainAppWindow()) return
    void (async () => {
      // Let zustand persist finish rehydrating before reading the journal.
      await Promise.resolve()
      const store = useApprovalJournalStore.getState()
      const fresh = unannouncedInterrupted(store.entries)
      if (fresh.length === 0) return
      // Claim first: a remount racing this one sees them already announced.
      store.markNotified(
        fresh.map((entry) => entry.requestId),
        Date.now()
      )
      try {
        const { notify } = await import("@/lib/notifications/runtime")
        await notify({
          source: "session",
          level: "warning",
          title: t("interruptedOnBoot", { count: fresh.length }),
          channels: ["center", "toast"],
          dedupeKey: "approval-journal-interrupted-boot",
        })
      } catch {
        // Boot notice is best-effort; the entries remain in the attention panel.
      }
    })()
  }, [t])

  return null
}
