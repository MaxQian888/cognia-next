/**
 * One mapping from an {@link OperationAvailabilityState} to the message key
 * that explains it.
 *
 * Two surfaces need this answer and must not phrase it differently: the error
 * line after an action was refused (`useWorkspaceActionController`) and the
 * tooltip on a control that is disabled before the user clicks
 * (`useWorkspaceCommandGate`). Both read `workspace.actionErrors`.
 *
 * Pure and React-free so the hook, the controller, and any non-React caller
 * can share it without pulling next-intl into a lib module.
 */

import type { OperationAvailabilityState } from "@/lib/runtime/operation-availability"

/**
 * Keyed by state rather than switched on, so adding a state to
 * `OperationAvailabilityState` is a type error here instead of a silent
 * fall-through that renders the raw state name at the user.
 */
export const AVAILABILITY_MESSAGE_KEY: Record<OperationAvailabilityState, string> = {
  available: "unavailable.unknown",
  "read-only": "unavailable.readOnly",
  queued: "unavailable.queued",
  offline: "unavailable.offline",
  "requires-unlock": "unavailable.requiresUnlock",
  "requires-pairing": "unavailable.requiresPairing",
  "requires-grant": "unavailable.requiresGrant",
  incompatible: "unavailable.incompatible",
  unsupported: "unavailable.unsupported",
}
