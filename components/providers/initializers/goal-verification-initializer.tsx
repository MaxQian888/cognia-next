"use client"

import { useEffect } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { reconcilePendingGoalVerifications } from "@/lib/goal/verification"
import { getDb } from "@/lib/db/schema"

/** Reconciles only already-admitted durable Goal verifier attempts after reload. */
export function GoalVerificationInitializer() {
  const pendingCount = useLiveQuery(
    () =>
      getDb()
        .chatGoals.filter(
          (goal) =>
            Boolean(goal.config.verificationWorkflow) &&
            (goal.verification?.status === "requested" || goal.verification?.status === "running")
        )
        .count(),
    [],
    0
  )
  useEffect(() => {
    void reconcilePendingGoalVerifications()
  }, [pendingCount])
  return null
}
