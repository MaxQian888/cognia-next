/**
 * Host-neutral boot for the issue tracker (ADR-0132).
 *
 * Registers the five issue sources (local, the GitHub mirror, the two agent
 * engines, and the ADR-0149 collaboration mirror), installs the run bridge and the lifecycle → Notification
 * Center watcher, seeds the starter label catalogue, and reconciles the GitHub
 * refresh schedule.
 *
 * Lives in `lib/` rather than beside the React initializer because BOTH hosts
 * boot it: the desktop through `IssueTrackerInitializer`, and the cloud brain
 * through `lib/headless/runtimes/issue-tracker.ts`. Everything underneath is
 * Dexie plus `schedulerDb`, so there is no seam to remap — only the two entry
 * points differ, and neither may import the other's host (a `"use client"`
 * component pulls React and `next/*` into the brain bundle).
 *
 * Registration is idempotent (`IssueSourceRegistry.register` keys on
 * `source.kind`), seeding is idempotent (`createLabel` returns the existing row
 * for a taken name), and both installers return their existing teardown when
 * already installed — so a re-run on account switch is harmless.
 */

import { loggers } from "@cognia/logging"

import { seedBuiltinIssueLabels } from "@/lib/db/labels"
import { syncGithubIssueSchedule } from "@/lib/issues/github-sync-schedule"
import { installIssueNotifications, type IssueNotifyTranslate } from "@/lib/issues/notify"
import { installIssueRunBridge } from "@/lib/issues/run/install"
import { registerAgentTaskIssueSource } from "@/lib/issues/sources/agent-task-source"
import { registerCollabIssueSource } from "@/lib/issues/sources/collab-source"
import { registerAgentTeamIssueSource } from "@/lib/issues/sources/agent-team-source"
import { registerGithubIssueSource } from "@/lib/issues/sources/github-source"
import { registerLocalIssueSource } from "@/lib/issues/sources/local-source"

const log = loggers.shell

export interface BootIssueTrackerOptions {
  /** `useTranslations("issues")` on desktop; the brain passes `ctx.resolveMessage`. */
  translate?: IssueNotifyTranslate
}

/**
 * Returns a teardown for the two watchers this boots. The desktop initializer
 * ignores it — the tracker lives as long as the window does — but the headless
 * brain stops its runtimes in reverse order on shutdown, and a run bridge still
 * subscribed to Dexie after teardown would keep a closed database alive. Source
 * registration and label seeding are idempotent and have no teardown, so the
 * returned function only disposes what actually holds a subscription.
 */
export async function bootIssueTracker(options: BootIssueTrackerOptions = {}): Promise<() => void> {
  registerLocalIssueSource()
  // The GitHub source reads only the Dexie mirror, so registering it here is
  // free even with no repo bound — it simply contributes nothing until a
  // project gains a `github-repo` resource and a sync runs.
  registerGithubIssueSource()
  // Slice ③: the two agent engines project their tasks onto the same board
  // (read-only), and the run bridge lets an issue be dispatched to them.
  registerAgentTaskIssueSource()
  registerAgentTeamIssueSource()
  // ADR-0149 §6: the collaboration plane's mirror. Registering it costs nothing
  // on a profile nobody has signed in on — the mirror is empty until a pull
  // runs, and the board simply shows the local rows.
  registerCollabIssueSource()
  const disposeRunBridge = installIssueRunBridge({
    onError: (error) => log.warn("issue-tracker: run bridge error", { error: String(error) }),
  })
  // Lifecycle → Notification Center (+ opt-in IM push). Watches the activity
  // trail from now on, so every mutation site is covered without calling
  // notify itself.
  const disposeNotifications = installIssueNotifications({
    translate: options.translate,
    onError: (error) => log.warn("issue-tracker: notify error", { error: String(error) }),
  })
  await seedBuiltinIssueLabels()
  // Reconcile the background refresh against the bindings that already exist.
  // Adding a resource schedules it there and then; this covers the restart
  // case, where the binding survives but the scheduler row may not.
  await syncGithubIssueSchedule()
  return () => {
    disposeNotifications()
    disposeRunBridge()
  }
}
