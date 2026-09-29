"use client"

/**
 * The always-mounted runtime for project coordination (ADR-0204). Renders
 * nothing. Mounted once inside `ClaudeChatRuntimeProvider`, so thread briefs
 * and coordinator reports go through the same `send` a person's message takes.
 *
 * For every workspace with coordination on, it:
 * - watches thread turns and reports each one that ends to the coordinator;
 * - reconciles after a reload (redeliver unsent briefs, mark dead turns);
 * - keeps the coordinator live while its threads work, so reports wake it;
 * - resolves threads that sat quiet for a week.
 */

import { useEffect, useMemo, useRef } from "react"
import type { ChatSession } from "@cognia/agent-config-types"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { useClientLiveQuery } from "@/hooks/data"
import { useSessionRunStatusMap } from "@/hooks/chat/use-session-run-status-map"
import { sessionStatusOf } from "@/hooks/chat/steer-runtime"
import { resolveCoordinatorConfig } from "@/lib/project-coordinator/config"
import { coordinatorNeedsHold, sweepIdleThreads } from "@/lib/project-coordinator/auto-resolve"
import {
  listProjectThreads,
  resolveThread,
  resumeProjectThreads,
} from "@/lib/project-coordinator/thread-runtime"
import { watchProjectThreadTurns } from "@/lib/project-coordinator/thread-watcher"

export const COORDINATOR_HOLDER_ID = "project-runtime"
export const AUTO_RESOLVE_INTERVAL_MS = 60 * 60 * 1000

const EMPTY: Array<[string, ChatSession[]]> = []

export function ProjectCoordinatorHost() {
  const projects = useProjectStore((s) => s.projects)
  const coordinatorIds = useMemo(
    () =>
      projects
        .map((project) => resolveCoordinatorConfig(project))
        .filter((config) => config.enabled && config.sessionId)
        .map((config) => config.sessionId as string)
        .sort(),
    [projects]
  )
  const coordinatorKey = coordinatorIds.join(",")

  const threadsByCoordinator = useClientLiveQuery(
    () =>
      Promise.all(
        coordinatorIds.map(
          async (id) => [id, await listProjectThreads(id)] as [string, ChatSession[]]
        )
      ),
    [coordinatorKey],
    EMPTY
  )
  const statuses = useSessionRunStatusMap()

  // The watcher is installed once; it reads the latest rows through this ref.
  const threadsRef = useRef(new Map<string, ChatSession>())
  useEffect(() => {
    const next = new Map<string, ChatSession>()
    for (const [, threads] of threadsByCoordinator ?? EMPTY) {
      for (const thread of threads) next.set(thread.id, thread)
    }
    threadsRef.current = next
  }, [threadsByCoordinator])

  useEffect(() => watchProjectThreadTurns((sessionId) => threadsRef.current.get(sessionId)), [])

  // Reconcile each coordinator once per mount.
  const resumed = useRef(new Set<string>())
  useEffect(() => {
    for (const id of coordinatorIds) {
      if (resumed.current.has(id)) continue
      resumed.current.add(id)
      void resumeProjectThreads(id).catch((error) =>
        console.warn("project thread reconciliation failed", error)
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the id list's content
  }, [coordinatorKey])

  // Keep each coordinator live exactly while its threads are active.
  useEffect(() => {
    const store = useChatStore.getState()
    for (const [coordinatorId, threads] of threadsByCoordinator ?? EMPTY) {
      const statusOf = (id: string) => statuses.get(id) ?? "idle"
      if (coordinatorNeedsHold(threads, statusOf)) {
        store.holdInBackground(coordinatorId, COORDINATOR_HOLDER_ID)
      } else {
        store.releaseBackgroundHold(coordinatorId, COORDINATOR_HOLDER_ID)
      }
    }
  }, [threadsByCoordinator, statuses])

  useEffect(() => {
    const sweep = () => {
      const threads = [...threadsRef.current.values()]
      void sweepIdleThreads(threads, {
        statusOf: sessionStatusOf,
        pendingApprovals: (id) =>
          useChatStore.getState().sessions[id]?.pendingApprovals.length ?? 0,
        resolve: (id) => resolveThread(id, "auto"),
        now: Date.now,
      }).catch((error) => console.warn("project thread sweep failed", error))
    }
    // A first pass shortly after boot, so short app sessions still sweep.
    const first = setTimeout(sweep, 60_000)
    const timer = setInterval(sweep, AUTO_RESOLVE_INTERVAL_MS)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [])

  return null
}
