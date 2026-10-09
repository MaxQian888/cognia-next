"use client"

/**
 * The completion-verifier workflows a goal can bind, read where the goal runs.
 *
 * A verifier binding pins a published deployment and a dependency lock built
 * from workflow versions. On the desktop (and in a browser profile) those live
 * in this database, so the list is a live query over it. A paired phone syncs
 * the deployments but not the versions, so it cannot build a binding; it asks
 * the desktop for its catalog over `goal_verification_options`, and the
 * desktop re-resolves whatever it is sent back on `goal_update`.
 */

import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { usePlatform } from "@/hooks/use-platform"
import {
  listGoalVerifierWorkflowOptions,
  type GoalVerifierWorkflowOption,
} from "@/lib/goal/verification"
import { transport } from "@/lib/tauri/transport-instance"

export interface GoalVerifierOptions {
  options: GoalVerifierWorkflowOption[]
  /** The desktop's catalog could not be read (phone only). */
  failed: boolean
}

type RemoteCatalog =
  { status: "loading" | "failed" } | { status: "ready"; options: GoalVerifierWorkflowOption[] }

const NO_OPTIONS: GoalVerifierWorkflowOption[] = []

export function useGoalVerifierOptions(): GoalVerifierOptions {
  const remote = usePlatform() === "mobile"
  // Off the phone the local query is the authority; on it the query still runs
  // (hooks are unconditional) and its answer is ignored.
  const local = useLiveQuery(
    () => (remote ? NO_OPTIONS : listGoalVerifierWorkflowOptions()),
    [remote],
    NO_OPTIONS
  )
  const [catalog, setCatalog] = useState<RemoteCatalog>({ status: "loading" })

  useEffect(() => {
    if (!remote) return
    let cancelled = false
    transport
      .call<{ options?: GoalVerifierWorkflowOption[] }>("goal_verification_options", {})
      .then((answer) => {
        if (!cancelled) setCatalog({ status: "ready", options: answer?.options ?? [] })
      })
      .catch(() => {
        if (!cancelled) setCatalog({ status: "failed" })
      })
    return () => {
      cancelled = true
    }
  }, [remote])

  if (!remote) return { options: local, failed: false }
  return {
    options: catalog.status === "ready" ? catalog.options : NO_OPTIONS,
    failed: catalog.status === "failed",
  }
}
