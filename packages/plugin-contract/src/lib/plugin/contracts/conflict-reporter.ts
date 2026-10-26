/**
 * Single chokepoint for reporting registry contribution conflicts.
 *
 * Under the first-wins-cross-plugin policy, when a later plugin tries to
 * register a tool/command/component key an earlier plugin already owns, the
 * later registration is rejected. Every registry routes that event here so the
 * diagnostic shape is identical regardless of which registry detected it, and
 * it surfaces in the existing plugin diagnostics panel + per-plugin badge.
 */

import { recordPluginPointDiagnostic } from "./diagnostics-store"

export interface RegistryConflictInfo {
  /** Plugin whose contribution was rejected (the loser). */
  pluginId: string
  /** The colliding key — tool name, command id, component type, etc. */
  attemptedId: string
  /** Human-readable registry/capability label for the message (e.g. "tool"). */
  registry: string
  /** Plugin that already owns the key (the winner), when known. */
  winnerPluginId?: string
}

/**
 * Record a rejected contribution as a non-blocking `plugin.conflict.rejected`
 * runtime diagnostic against the losing plugin.
 */
export function reportRegistryConflict(info: RegistryConflictInfo): void {
  const owner = info.winnerPluginId ?? "another plugin"
  recordPluginPointDiagnostic(info.pluginId, {
    code: "plugin.conflict.rejected",
    severity: "warning",
    pointKind: "runtime",
    pointId: info.attemptedId,
    message: `${info.registry} "${info.attemptedId}" is already provided by ${owner}; this plugin's contribution was ignored.`,
    hint: `Two plugins contribute the ${info.registry} "${info.attemptedId}". Disable one, or rename the contribution.`,
  })
}
