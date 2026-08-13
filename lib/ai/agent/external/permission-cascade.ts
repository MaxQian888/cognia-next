import type { AcpCapabilities, AcpPermissionMode } from "@/types/agent/external-agent"
import type { AgentPermissionCeiling } from "@/types/agent/permission-ceiling"
import { clampSandboxPolicy } from "@/lib/sandbox/policy-bridge"

/**
 * A minimal, protocol-agnostic description of the permission surface an
 * external-agent session is allowed to touch. Both the team-dispatch path
 * (Thread A1) and the subagent-dispatch path (Thread A2) build one of these
 * for the *parent* context and (optionally) one for the *child* agent
 * definition, then derive the effective spec via
 * {@link deriveExternalSessionPermission}.
 *
 * The cascade rule mirrors OpenCode's `deriveSubagentSessionPermission` and
 * Goose's force-Auto behaviour: **a parent's restriction always cascades; a
 * child may only further-restrict, never escalate.**
 */
/** @deprecated Import `AgentPermissionCeiling` from `@/types/agent/permission-ceiling`. */
export type ExternalSessionPermissionSpec = AgentPermissionCeiling

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

const RANK_TO_MODE = (Object.entries(MODE_RANK) as Array<[AcpPermissionMode, number]>).reduce(
  (acc, [mode, rank]) => {
    acc[rank] = mode
    return acc
  },
  {} as Record<number, AcpPermissionMode>
)

function clampMode(
  parent: AcpPermissionMode | undefined,
  child: AcpPermissionMode | undefined
): AcpPermissionMode | undefined {
  // An unset side imposes no ceiling (rank = Infinity).
  const parentRank = parent ? MODE_RANK[parent] : Number.POSITIVE_INFINITY
  const childRank = child ? MODE_RANK[child] : parentRank
  const effective = Math.min(parentRank, childRank)
  if (!Number.isFinite(effective)) return undefined
  return RANK_TO_MODE[effective]
}

function intersectAllow(
  parent: string[] | undefined,
  child: string[] | undefined
): string[] | undefined {
  if (parent && child) {
    const childSet = new Set(child)
    return parent.filter((tool) => childSet.has(tool))
  }
  return parent ?? child
}

function unionDeny(
  parent: string[] | undefined,
  child: string[] | undefined
): string[] | undefined {
  if (!parent && !child) return undefined
  return Array.from(new Set([...(parent ?? []), ...(child ?? [])]))
}

function intersectServers(
  parent: ExternalSessionPermissionSpec["mcpServers"],
  child: ExternalSessionPermissionSpec["mcpServers"]
): ExternalSessionPermissionSpec["mcpServers"] {
  if (parent && child) {
    const childNames = new Set(child.map((s) => s.name))
    return parent.filter((s) => childNames.has(s.name))
  }
  return parent ?? child
}

/**
 * Compose a parent permission spec with an optional child spec, enforcing the
 * "child may only further-restrict" invariant across every dimension:
 * - `permissionMode` clamps down to the lesser-permissive of the two.
 * - `allowedTools` intersect (the child cannot widen the allow-list).
 * - `disallowedTools` union (a parent deny always cascades).
 * - `mcpServers` intersect by name (cannot expose a server the parent lacks).
 */
export function deriveExternalSessionPermission(
  parent: ExternalSessionPermissionSpec,
  child?: ExternalSessionPermissionSpec
): ExternalSessionPermissionSpec {
  if (!child) return { ...parent }

  const result: ExternalSessionPermissionSpec = {}

  const permissionMode = clampMode(parent.permissionMode, child.permissionMode)
  if (permissionMode) result.permissionMode = permissionMode

  const allowedTools = intersectAllow(parent.allowedTools, child.allowedTools)
  if (allowedTools) result.allowedTools = allowedTools

  const disallowedTools = unionDeny(parent.disallowedTools, child.disallowedTools)
  if (disallowedTools) result.disallowedTools = disallowedTools

  const mcpServers = intersectServers(parent.mcpServers, child.mcpServers)
  if (mcpServers) result.mcpServers = mcpServers

  const sandboxPolicy = clampSandboxPolicy(parent.sandboxPolicy, child.sandboxPolicy)
  if (sandboxPolicy) result.sandboxPolicy = sandboxPolicy

  return result
}

/**
 * Capability-gated UX guards derived from an agent's discovered
 * {@link AcpCapabilities}. Mirrors the ACP `initialize` handshake:
 * - a single-turn agent (`multiTurn === false`, the `loadSession=false`
 *   analogue in our capability projection) cannot resume — never pass a
 *   prior `sessionId`.
 * - an agent that advertises a `supportedFileTypes` list without any
 *   `image/*` entry cannot receive image blocks — strip them before sending.
 *
 * Unknown capabilities default to permissive (`true`) so we never over-block
 * an agent that simply didn't advertise.
 */
export function deriveCapabilityGuards(capabilities: AcpCapabilities | undefined): {
  allowResume: boolean
  allowImages: boolean
} {
  const allowResume = capabilities?.multiTurn !== false

  const fileTypes = capabilities?.supportedFileTypes
  const allowImages =
    !fileTypes || fileTypes.length === 0 || fileTypes.some((t) => t.startsWith("image/"))

  return { allowResume, allowImages }
}
