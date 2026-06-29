/**
 * ADR-0056 (decision D4) — deciding whether a `permissionMode` change is an
 * *escalation* toward more agent autonomy. The phone's `/me/agent` page uses
 * this to decide whether a remote write to the paired desktop must pass the
 * biometric gate (`biometricRequiredFor.escalatePermissionMode`).
 *
 * Pure + side-effect-free so it is trivially testable and reusable.
 */

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto"

/** Higher rank = more autonomous (fewer confirmations before the agent acts). */
const PERMISSION_MODE_RANK: Record<PermissionMode, number> = {
  plan: 0,
  default: 1,
  acceptEdits: 2,
  dontAsk: 3,
  auto: 3,
  bypassPermissions: 4,
}

/** Modes that grant the agent more autonomy than `default` / `plan`. */
const AUTONOMOUS_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  "acceptEdits",
  "dontAsk",
  "auto",
  "bypassPermissions",
])

/**
 * True when moving from `from` to `to` increases agent autonomy into one of the
 * autonomous modes. A missing `from` is treated as `default`. Lateral or
 * de-escalating moves (e.g. → `plan`, → `default`, or auto↔dontAsk at equal
 * rank) return false.
 */
export function isPermissionModeEscalation(
  from: PermissionMode | undefined,
  to: PermissionMode
): boolean {
  if (!AUTONOMOUS_MODES.has(to)) return false
  const fromRank = from ? PERMISSION_MODE_RANK[from] : PERMISSION_MODE_RANK.default
  return PERMISSION_MODE_RANK[to] > fromRank
}
