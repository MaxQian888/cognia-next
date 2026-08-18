"use client"

/**
 * Boots the issue tracker: registers the issue sources (local, the GitHub
 * mirror, and the two agent engines), installs the run bridge (adapters +
 * engine watchers), and seeds the starter label catalogue.
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
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { loggers } from "@cognia/logging"

import { seedBuiltinIssueLabels } from "@/lib/db/labels"
import { syncGithubIssueSchedule } from "@/lib/issues/github-sync-schedule"
import {
  installIssueNotificationCommands,
  installIssueNotifications,
  type IssueNotifyTranslate,
} from "@/lib/issues/notify"
import { installIssueRunBridge } from "@/lib/issues/run/install"
import { registerAgentTaskIssueSource } from "@/lib/issues/sources/agent-task-source"
import { registerAgentTeamIssueSource } from "@/lib/issues/sources/agent-team-source"
import { registerGithubIssueSource } from "@/lib/issues/sources/github-source"
import { registerLocalIssueSource } from "@/lib/issues/sources/local-source"
import { useAccountStore } from "@/stores/account/account-store"

const log = loggers.shell

/**
 * Exported separately from the component so the headless CLI host and tests can
 * boot the tracker without mounting React.
 */
export interface BootIssueTrackerOptions {
  /** `useTranslations("issues")` from React; headless hosts use the English fallback. */
  translate?: IssueNotifyTranslate
}

export async function bootIssueTracker(options: BootIssueTrackerOptions = {}): Promise<void> {
  registerLocalIssueSource()
  // The GitHub source reads only the Dexie mirror, so registering it here is
  // free even with no repo bound — it simply contributes nothing until a
  // project gains a `github-repo` resource and a sync runs.
  registerGithubIssueSource()
  // Slice ③: the two agent engines project their tasks onto the same board
  // (read-only), and the run bridge lets an issue be dispatched to them.
  registerAgentTaskIssueSource()
  registerAgentTeamIssueSource()
  installIssueRunBridge({
    onError: (error) => log.warn("issue-tracker: run bridge error", { error: String(error) }),
  })
  // Lifecycle → Notification Center (+ opt-in IM push). Watches the activity
  // trail from now on, so every mutation site is covered without calling
  // notify itself.
  installIssueNotifications({
    translate: options.translate,
    onError: (error) => log.warn("issue-tracker: notify error", { error: String(error) }),
  })
  await seedBuiltinIssueLabels()
  // Reconcile the background refresh against the bindings that already exist.
  // Adding a resource schedules it there and then; this covers the restart
  // case, where the binding survives but the scheduler row may not.
  await syncGithubIssueSchedule()
}

export function IssueTrackerInitializer() {
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const startedFor = useRef<string | null>(null)
  const router = useRouter()
  const t = useTranslations("issues")
  // Notification text is rendered at emit time; hand the watcher the latest
  // translator without re-booting on every locale/render change. The ref is
  // written in an effect (never during render), so React's ref rules hold.
  const translateRef = useRef<IssueNotifyTranslate>(t)
  useEffect(() => {
    translateRef.current = t
  }, [t])

  useEffect(() => {
    if (!unlockedAccountId) return
    if (startedFor.current === unlockedAccountId) return
    startedFor.current = unlockedAccountId

    void bootIssueTracker({
      translate: (key, values) => translateRef.current(key, values),
    }).catch((error) => {
      // Never block boot on the tracker: a failed seed leaves an empty label
      // catalogue, which is recoverable, while a thrown effect is not.
      log.warn("issue-tracker: boot failed", { error: String(error) })
    })
  }, [unlockedAccountId])

  // The `issue.open` notification action needs the App Router, which only
  // React can hand out — same arrangement as the diagnostics commands.
  useEffect(
    () => installIssueNotificationCommands({ navigate: (path) => router.push(path) }),
    [router]
  )

  return null
}
