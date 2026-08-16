"use client"

/**
 * Boots the issue tracker: registers the issue sources (local + the GitHub
 * mirror) and seeds the starter label catalogue.
 *
 * Without this the board renders empty forever — `registerLocalIssueSource`
 * exists and is tested, but a registry nobody registers into is the repo's
 * single most recurrent defect class (built, correct, and unreachable at
 * runtime). The `wiring-auditor` skill exists because of it.
 *
 * Registration is idempotent (`IssueSourceRegistry.register` keys on
 * `source.kind`) and seeding is idempotent (`createLabel` returns the existing
 * row for a taken name), so a re-run on account switch is harmless.
 */

import { useEffect, useRef } from "react"
import { loggers } from "@cognia/logging"

import { seedBuiltinIssueLabels } from "@/lib/db/labels"
import { syncGithubIssueSchedule } from "@/lib/issues/github-sync-schedule"
import { registerGithubIssueSource } from "@/lib/issues/sources/github-source"
import { registerLocalIssueSource } from "@/lib/issues/sources/local-source"
import { useAccountStore } from "@/stores/account/account-store"

const log = loggers.shell

/**
 * Exported separately from the component so the headless CLI host and tests can
 * boot the tracker without mounting React.
 */
export async function bootIssueTracker(): Promise<void> {
  registerLocalIssueSource()
  // The GitHub source reads only the Dexie mirror, so registering it here is
  // free even with no repo bound — it simply contributes nothing until a
  // project gains a `github-repo` resource and a sync runs.
  registerGithubIssueSource()
  await seedBuiltinIssueLabels()
  // Reconcile the background refresh against the bindings that already exist.
  // Adding a resource schedules it there and then; this covers the restart
  // case, where the binding survives but the scheduler row may not.
  await syncGithubIssueSchedule()
}

export function IssueTrackerInitializer() {
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const startedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!unlockedAccountId) return
    if (startedFor.current === unlockedAccountId) return
    startedFor.current = unlockedAccountId

    void bootIssueTracker().catch((error) => {
      // Never block boot on the tracker: a failed seed leaves an empty label
      // catalogue, which is recoverable, while a thrown effect is not.
      log.warn("issue-tracker: boot failed", { error: String(error) })
    })
  }, [unlockedAccountId])

  return null
}
