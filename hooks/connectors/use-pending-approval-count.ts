"use client"

/**
 * Live count of HITL tool-permission approvals awaiting a button press for
 * one session. Backed by the in-process approval registry
 * (`lib/connectors/hitl/approval-registry.ts`) through `useSyncExternalStore`,
 * so the chip re-renders exactly when a card is projected, answered,
 * superseded, or auto-denied by its TTL — no polling.
 *
 * The registry lives in the renderer that runs the connector runtime; in a
 * shell without a runtime (web / mobile) it is simply always empty, and the
 * server snapshot is 0 so static export never sees a non-zero count.
 */

import { useCallback, useSyncExternalStore } from "react"
import {
  pendingApprovalCountForSession,
  subscribePendingApprovals,
} from "@/lib/connectors/hitl/approval-registry"

const getServerSnapshot = () => 0

export function usePendingApprovalCount(sessionId: string): number {
  const getSnapshot = useCallback(() => pendingApprovalCountForSession(sessionId), [sessionId])
  return useSyncExternalStore(subscribePendingApprovals, getSnapshot, getServerSnapshot)
}
