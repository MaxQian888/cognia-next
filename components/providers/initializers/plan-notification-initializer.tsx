"use client"

/**
 * Installs the plan subsystem's notification-action handler (ADR-0045 §5).
 *
 * `notifyPlanAwaitingApproval` persists a center row with Approve / Discard
 * buttons; those buttons dispatch the `plan.approval.respond` command, and a
 * command with no registered handler is a button that does nothing. Registering
 * it at boot — rather than lazily from whatever surface happens to run first —
 * is what makes the actions work even when the notification is answered days
 * later, from a session that is not open.
 *
 * Idempotent: `registerNotificationCommand` keys on the command id, and the
 * effect unregisters on unmount.
 */

import { useEffect } from "react"

import { installPlanNotificationActions } from "@/lib/agent/plan/notify"

export function PlanNotificationInitializer() {
  useEffect(() => installPlanNotificationActions(), [])
  return null
}
