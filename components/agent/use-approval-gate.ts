"use client"

import { useMemo } from "react"
import { approve, reject } from "@/lib/runtime/approval-bus"

/**
 * Thin React hook binding the generic approval-bus to a fixed scope+id.
 * The ApprovalGateDialog calls `onApprove(payload)` / `onReject(feedback)`
 * which forward to approval-bus via the hook's returned helpers.
 *
 * Per ADR-0022 §3 HITL gates.
 */
export function useApprovalGate(
  scope: string,
  id: string
): {
  approve: (plan?: unknown) => void
  reject: (feedback?: string) => void
} {
  return useMemo(
    () => ({
      approve: (plan?: unknown) => {
        approve({ scope, id }, plan)
      },
      reject: (feedback?: string) => {
        reject({ scope, id }, feedback)
      },
    }),
    [scope, id]
  )
}
