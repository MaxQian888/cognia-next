/**
 * Host-neutral boot for the issue tracker (ADR-0132).
 *
 * Registers the five issue sources (local, the GitHub mirror, the two agent
 * engines, and the ADR-0149 collaboration mirror), installs the run bridge, the lifecycle → Notification
 * Center watcher and the issue wakeup bridge, seeds the starter label
 * catalogue, and reconciles the GitHub refresh schedule.
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

import { refreshCollabPlaneQuietly } from "@/lib/collab/refresh"
import { seedBuiltinIssueLabels } from "@/lib/db/labels"
import { syncGithubIssueSchedule } from "@/lib/issues/github-sync-schedule"
import { installIssueNotifications, type IssueNotifyTranslate } from "@/lib/issues/notify"
import { installIssueRunBridge } from "@/lib/issues/run/install"
import { installIssueWakeupBridge } from "@/lib/issues/wakeups/bridge"
import { registerAgentTaskIssueSource } from "@/lib/issues/sources/agent-task-source"
import { registerCollabIssueSource } from "@/lib/issues/sources/collab-source"
import { registerAgentTeamIssueSource } from "@/lib/issues/sources/agent-team-source"
import { registerGithubIssueSource } from "@/lib/issues/sources/github-source"
import { registerLocalIssueSource } from "@/lib/issues/sources/local-source"
import { registerIssueSyncProvider } from "@/lib/issues/sync/registry"
import { createGithubSyncProvider } from "@/lib/issues/sync/providers/github"
import { createLarkBitableSyncProvider } from "@/lib/issues/sync/providers/lark-bitable"
import { createLarkTaskSyncProvider } from "@/lib/issues/sync/providers/lark-task"

const log = loggers.shell

export interface BootIssueTrackerOptions {
  /** `useTranslations("issues")` on desktop; the brain passes `ctx.resolveMessage`. */
  translate?: IssueNotifyTranslate
}

/**
 * Returns a teardown for the three watchers this boots. The desktop initializer
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
  // Spec 2026-09-06 D1: the bidirectional sync providers. Registering costs
  // nothing until a container binds a resource of the provider's kind.
  registerIssueSyncProvider(createGithubSyncProvider())
  registerIssueSyncProvider(createLarkTaskSyncProvider())
  registerIssueSyncProvider(createLarkBitableSyncProvider())
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
  // Issue wakeups: the trail → `issue:activity` scheduler events, and the
  // executor + fire gate that turn a matching event into a run. The executor
  // module pulls the scheduler graph, so it loads off the boot's critical path;
  // a wakeup that comes due first loads it through `executor-owners.ts`.
  const disposeWakeups = installIssueWakeupBridge({
    onError: (error) => log.warn("issue-tracker: wakeup bridge error", { error: String(error) }),
  })
  void import("@/lib/issues/wakeups/executor")
    .then(({ registerIssueWakeupExecutor }) => registerIssueWakeupExecutor())
    .catch((error) =>
      log.warn("issue-tracker: wakeup executor failed to load", { error: String(error) })
    )
  await seedBuiltinIssueLabels()
  // Reconcile the background refresh against the bindings that already exist.
  // Adding a resource schedules it there and then; this covers the restart
  // case, where the binding survives but the scheduler row may not.
  await syncGithubIssueSchedule()
  // Plan Phase 1: every open parent waits for its children. The bridge adds
  // the rule when a parent is set from now on; this covers parents that
  // gained children before, or while the tracker was not running.
  void import("@/lib/issues/wakeups/service")
    .then(({ reconcileChildrenDoneWakeups }) => reconcileChildrenDoneWakeups())
    .catch((error) =>
      log.warn("issue-tracker: children-done wakeup reconcile failed", { error: String(error) })
    )
  // ADR-0149 §6 — the pull that makes the collaboration mirror non-empty.
  //
  // Deliberately last, and deliberately quiet. It is the only step here that
  // needs the network, and an unreachable collaboration server must not stop
  // the board from booting: the local rows are the ones that matter most and
  // they need no network at all. `refreshCollabPlaneQuietly` also returns
  // `skipped` rather than throwing for the ordinary states — no server
  // configured, nobody signed in — so those cost one localStorage read.
  void refreshCollabPlaneQuietly().then((result) => {
    if (result?.status === "refreshed") {
      log.info("issue-tracker: collaboration plane refreshed", {
        issues: result.issues,
        workspaces: result.workspaces,
        plans: result.plans,
        runs: result.runs,
      })
    }
  })
  return () => {
    disposeWakeups()
    disposeNotifications()
    disposeRunBridge()
  }
}
