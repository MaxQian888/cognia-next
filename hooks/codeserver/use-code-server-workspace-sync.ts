"use client"

import { useEffect, useRef, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"

import { useClientLiveQuery } from "@/hooks/data"
import { codeServerClient, type CodeServerWorkspaceSnapshot } from "@/lib/codeserver/client"
import { buildWorkspaceSnapshot } from "@/lib/codeserver/workspace-snapshot"
import type {
  WorkspaceIssueInput,
  WorkspacePlanInput,
  WorkspaceRunInput,
} from "@/lib/codeserver/workspace-snapshot"
import { primaryFileReference } from "@/lib/issues/editor-links"
import { listIssues } from "@/lib/db/issues"
import { listAllPlans } from "@/lib/db/plans"
import { listIssueRuns } from "@/lib/db/issue-runs"
import { statusCategoryOf } from "@/types/issues"
import {
  getActiveRemoteTransport,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import { onTransportChange, transport } from "@/lib/tauri/transport-instance"

const snapshotTransport = () => getActiveRemoteTransport() ?? transport
function subscribeSnapshotTransport(notify: () => void) {
  const stopRemote = subscribeActiveRemoteTransport(notify)
  const stopTransport = onTransportChange(notify)
  return () => {
    stopRemote()
    stopTransport()
  }
}

interface PendingSnapshot {
  root: string
  snapshot: CodeServerWorkspaceSnapshot
  serialized: string
  host: ReturnType<typeof snapshotTransport>
  epoch: number
}

// A native request can outlive its React publisher. Serialize the actual
// command across remounts, scoped narrowly enough that other roots/hosts run
// independently. Idle entries are removed when their last command settles.
const snapshotWrites = new WeakMap<object, Map<string, Promise<void>>>()
function writeSnapshot(next: PendingSnapshot, current: () => boolean): Promise<void> {
  let roots = snapshotWrites.get(next.host)
  if (!roots) {
    roots = new Map()
    snapshotWrites.set(next.host, roots)
  }
  const send = () =>
    current() ? codeServerClient.pushWorkspaceSnapshot(next.root, next.snapshot) : Promise.resolve()
  const previous = roots.get(next.root)
  const write = previous ? previous.catch(() => undefined).then(send) : send()
  roots.set(next.root, write)
  void write
    .finally(() => {
      if (roots.get(next.root) === write) roots.delete(next.root)
    })
    .catch(() => undefined)
  return write
}

/** One writer and one replaceable pending full snapshot, including across root changes. */
function createSnapshotPublisher() {
  let latest: PendingSnapshot | null = null
  let pending: PendingSnapshot | null = null
  let lastPushed: string | null = null
  let running = false
  let disposed = false
  let epoch = 0
  let retryDelay = 2_000
  let timer: ReturnType<typeof setTimeout> | undefined
  const available = () => !document.hidden && navigator.onLine !== false
  const clearTimer = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const schedule = (delay: number) => {
    clearTimer()
    timer = setTimeout(() => {
      timer = undefined
      replay()
    }, delay)
  }
  const drain = async () => {
    if (disposed || running || timer || !pending || !available()) return
    const next = pending
    // A queued snapshot belongs to the host that was selected when it was
    // built. Never let a delayed retry route old workspace data to a new host.
    if (next.host !== snapshotTransport()) {
      pending = null
      return
    }
    pending = null
    if (next.serialized === lastPushed) {
      schedule(60_000)
      return
    }
    running = true
    try {
      await writeSnapshot(
        next,
        () =>
          !disposed &&
          available() &&
          next.host === snapshotTransport() &&
          next.epoch === epoch &&
          next.serialized === latest?.serialized
      )
      if (!disposed && next.epoch === epoch) {
        lastPushed = next.serialized
        retryDelay = 2_000
      }
    } catch {
      if (!disposed && next.epoch === epoch) {
        lastPushed = null
        pending = latest
        schedule(retryDelay)
        retryDelay = Math.min(retryDelay * 2, 30_000)
      }
    } finally {
      running = false
      if (!disposed && !timer) {
        if (pending) void drain()
        // There is no extension-generation notification in the current
        // protocol. A bounded full replay also repairs an unnoticed restart.
        else if (latest && available()) schedule(60_000)
      }
    }
  }
  function replay() {
    if (disposed || !latest || !available()) return
    clearTimer()
    lastPushed = null
    latest = { ...latest, epoch: ++epoch }
    pending = latest
    void drain()
  }
  const onVisibility = () => {
    if (available()) replay()
    else clearTimer()
  }
  window.addEventListener("online", replay)
  window.addEventListener("offline", onVisibility)
  document.addEventListener("visibilitychange", onVisibility)

  return {
    update(root: string, snapshot: CodeServerWorkspaceSnapshot | null) {
      if (!snapshot) {
        epoch += 1
        latest = pending = null
        lastPushed = null
        clearTimer()
        return
      }
      const host = snapshotTransport()
      if (latest?.root !== root || latest.host !== host) {
        epoch += 1
        lastPushed = null
        retryDelay = 2_000
        clearTimer()
      }
      const serialized = JSON.stringify({ root, snapshot })
      if (latest?.serialized === serialized && latest.epoch === epoch) return
      latest = pending = { root, snapshot, serialized, host, epoch }
      // New data bypasses the healthy replay timer, but respects failure
      // backoff so writes cannot hammer an unavailable cloud host.
      if (lastPushed !== null) clearTimer()
      void drain()
    },
    dispose() {
      disposed = true
      latest = pending = null
      clearTimer()
      window.removeEventListener("online", replay)
      window.removeEventListener("offline", onVisibility)
      document.removeEventListener("visibilitychange", onVisibility)
    },
  }
}

/**
 * Keep the Pro IDE's Cognia panel in step with the user's work (ADR-0088
 * Phase 3).
 *
 * Push-only, app-decides: this reads the same Dexie tables the board and plan
 * views read, projects them through the pure
 * `buildWorkspaceSnapshot`, and hands the extension a finished picture. The
 * extension never queries back — see that module for why.
 *
 * The live queries do the change detection: `useClientLiveQuery` re-runs on any
 * write to the tables it touched, so a new issue, a plan step completing, or a
 * run settling all re-push. A low-frequency full replay repairs extension
 * restarts that the current protocol cannot announce.
 */
export function useCodeServerWorkspaceSync(enabled: boolean, root: string): void {
  const t = useTranslations("proIdePanel")
  const host = useSyncExternalStore(
    subscribeSnapshotTransport,
    snapshotTransport,
    snapshotTransport
  )

  const issues = useClientLiveQuery(() => (enabled ? listIssues({}) : []), [enabled], undefined)
  const plans = useClientLiveQuery(() => (enabled ? listAllPlans() : []), [enabled], undefined)
  const runs = useClientLiveQuery(
    () => (enabled ? listIssueRuns({ activeOnly: true }) : []),
    [enabled],
    undefined
  )
  const publisher = useRef<ReturnType<typeof createSnapshotPublisher> | null>(null)
  useEffect(() => {
    const current = createSnapshotPublisher()
    publisher.current = current
    return () => {
      current.dispose()
      publisher.current = null
    }
  }, [])

  useEffect(() => {
    if (!enabled || !root) {
      publisher.current?.update(root, null)
      return
    }
    // Dexie resolves these independently. Do not replace a populated panel
    // with partial empty defaults while the other tables are still loading.
    if (!issues || !plans || !runs) {
      publisher.current?.update(root, null)
      return
    }

    const issueRows: WorkspaceIssueInput[] = issues.map((issue) => {
      const reference = primaryFileReference(issue.title, issue.description)
      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        statusCategory: statusCategoryOf(issue.status),
        status: issue.status,
        updatedAt: issue.updatedAt,
        ...(reference ? { path: reference.path } : {}),
        ...(reference?.line !== undefined ? { line: reference.line } : {}),
      }
    })

    const planRows: WorkspacePlanInput[] = plans.map((plan) => ({
      id: plan.id,
      title: plan.title,
      status: plan.status,
      completedSteps: plan.steps.filter((step) => step.status === "completed").length,
      totalSteps: plan.steps.length,
      updatedAt: plan.updatedAt ?? plan.createdAt ?? 0,
    }))

    const runRows: WorkspaceRunInput[] = runs.map((run) => ({
      id: run.id,
      label: run.adapterId,
      status: run.status,
      startedAt: run.startedAt ?? 0,
    }))

    const snapshot = buildWorkspaceSnapshot({
      issues: issueRows,
      plans: planRows,
      runs: runRows,
      strings: {
        issuesTitle: t("issuesTitle"),
        plansTitle: t("plansTitle"),
        runsTitle: t("runsTitle"),
        issuesEmpty: t("issuesEmpty"),
        plansEmpty: t("plansEmpty"),
        runsEmpty: t("runsEmpty"),
        statusText: t("statusText"),
        statusTooltip: t("statusTooltip"),
        disconnected: t("disconnected"),
        noCustomActions: t("noCustomActions"),
        chooseAction: t("chooseAction"),
        noDiagnostics: t("noDiagnostics"),
      },
    })

    publisher.current?.update(root, snapshot)
  }, [enabled, root, host, issues, plans, runs, t])
}
