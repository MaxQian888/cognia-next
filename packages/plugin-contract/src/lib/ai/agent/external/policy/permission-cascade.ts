/**
 * The plugin contract's share of `lib/ai/agent/external/policy/permission-cascade.ts`, which re-exports these.
 */
import type { AgentPermissionCeiling } from "../../../../../types/agent/permission-ceiling"

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
