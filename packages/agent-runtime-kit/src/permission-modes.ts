import type { AcpPermissionMode } from "@cognia/agent-contracts/external-agent"

/**
 * Permissiveness ranking, ascending. `plan` (read-only) is the most
 * restrictive; `bypassPermissions` (skip all checks) the most permissive.
 * The effective mode is the *minimum* rank of parent and child.
 *
 * This ranks the **restrictiveness-of-execution** axis (what tools can run):
 * `dontAsk` denies everything un-preapproved, so it sits BELOW `default` here.
 * That is deliberately DIFFERENT from
 * `lib/settings/permission-mode-escalation.ts:PERMISSION_MODE_RANK`, which ranks
 * the orthogonal **autonomy** axis (there `dontAsk` runs pre-approved tools
 * without asking, so it sits ABOVE `default`). The two tables are not drift —
 * they measure different things and must not be merged.
 */
export const MODE_RANK: Record<AcpPermissionMode, number> = {
  plan: 0,
  dontAsk: 1,
  default: 2,
  acceptEdits: 3,
  bypassPermissions: 4,
}
