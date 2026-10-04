/**
 * Permission-mode labels for the phone's external-agent screens, and the mode
 * a new agent starts in.
 */

import {
  adaptPermissionMode,
  supportedPermissionModes,
} from "@/lib/ai/agent/external/policy/permission-modes"
import type { AcpPermissionMode, ExternalAgentProtocol } from "@/types/agent/external-agent"

/** i18n label key (under `mobile.externalAgents`) for each permission mode. */
export const PERMISSION_MODE_LABEL_KEY: Record<AcpPermissionMode, string> = {
  default: "permissionDefault",
  acceptEdits: "permissionAcceptEdits",
  bypassPermissions: "permissionBypass",
  plan: "permissionPlan",
  dontAsk: "permissionDontAsk",
}

/** The modes a protocol can actually run under, in display order. */
export function permissionModesFor(protocol: ExternalAgentProtocol): readonly AcpPermissionMode[] {
  return supportedPermissionModes(protocol)
}

/**
 * The mode to show (and store) for a requested one: clamped to what the
 * protocol supports, so the phone can never offer a mode the Host would refuse
 * to run. The Host clamps again; this only keeps the two from disagreeing on
 * screen.
 */
export function effectivePermissionMode(
  requested: AcpPermissionMode | undefined,
  protocol: ExternalAgentProtocol
): AcpPermissionMode {
  return adaptPermissionMode(requested ?? "default", protocol).mode
}
