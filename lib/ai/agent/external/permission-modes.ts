import type { AcpPermissionMode, ExternalAgentProtocol } from "@/types/agent/external-agent"
import { MODE_RANK } from "./permission-cascade"

/**
 * Per-backend permission-mode capability map.
 *
 * `AcpPermissionMode` is the canonical (ACP / Claude Code) permission model with
 * five rungs. Not every external-agent backend can honour all five — e.g. the
 * Codex app-server has no native `bypassPermissions` switch (it is emulated via
 * `approvalPolicy: never`) and no pre-approval registry for `dontAsk`. This
 * module is the single source of truth for:
 *  - which modes a given protocol can actually enforce, and
 *  - how to {@link adaptPermissionMode | adapt} a requested mode the backend
 *    cannot honour down to the nearest one it can — never escalating beyond the
 *    user's intent.
 *
 * Both the runtime (manager → session creation / `setSessionMode`) and the UI
 * (settings + scheduler payload editors) consume it so the mode a user picks,
 * the mode persisted on disk, and the mode the backend runs under stay in sync.
 */

/**
 * All canonical modes in UX display order (most-common first), independent of
 * the permissiveness {@link MODE_RANK} used for clamping. ACP (Claude Code) is
 * the reference backend and supports every entry here.
 */
export const ALL_PERMISSION_MODES: readonly AcpPermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
] as const

/**
 * Modes each built-in protocol can enforce, in display order. Plugin-contributed
 * (`${pluginId}:${id}`) protocols are not listed; {@link supportedPermissionModes}
 * falls back to the full ACP set for them and lets the adapter clamp at runtime.
 *
 * - `acp` — reference model, all five.
 * - `codex-app-server` / `opencode` / `opencode-v2` — no pre-approval registry, so `dontAsk`
 *   ("deny unless pre-approved") has no distinct behaviour and is dropped; the
 *   other four map onto their native approval policies.
 * - `a2a` / `http` / `websocket` — fire-and-forget request/response transports
 *   with no client-side tool-approval loop, so only the pass-through `default`
 *   is meaningful; the remote agent owns its own policy.
 */
export const PROTOCOL_PERMISSION_MODE_SUPPORT: Record<
  ExternalAgentProtocol,
  readonly AcpPermissionMode[]
> = {
  acp: ALL_PERMISSION_MODES,
  "codex-app-server": ["default", "acceptEdits", "bypassPermissions", "plan"],
  opencode: ["default", "acceptEdits", "bypassPermissions", "plan"],
  "opencode-v2": ["default", "acceptEdits", "bypassPermissions", "plan"],
  a2a: ["default"],
  http: ["default"],
  websocket: ["default"],
  custom: ALL_PERMISSION_MODES,
}

/**
 * The permission modes a backend can enforce, in display order. Unknown /
 * plugin-contributed protocols fall back to the full canonical set.
 */
export function supportedPermissionModes(
  protocol: ExternalAgentProtocol
): readonly AcpPermissionMode[] {
  return PROTOCOL_PERMISSION_MODE_SUPPORT[protocol] ?? ALL_PERMISSION_MODES
}

/**
 * Whether `mode` is natively enforceable by `protocol`.
 */
export function isPermissionModeSupported(
  mode: AcpPermissionMode,
  protocol: ExternalAgentProtocol
): boolean {
  return supportedPermissionModes(protocol).includes(mode)
}

/**
 * The outcome of clamping a requested permission mode to what a backend can
 * enforce.
 */
export interface AdaptedPermissionMode {
  /** The effective mode the backend will actually run under. */
  mode: AcpPermissionMode
  /** The mode originally requested. */
  requested: AcpPermissionMode
  /** True when `mode` differs from `requested`. */
  adapted: boolean
}

/**
 * Map a requested mode onto the nearest mode `protocol` can enforce.
 *
 * When the request is already supported it passes through unchanged. Otherwise
 * we clamp to the nearest supported mode whose permissiveness {@link MODE_RANK}
 * is **at or below** the request (rounding toward restriction so we never grant
 * more than asked). If every supported mode is strictly more permissive than the
 * request — e.g. a backend that only offers `default` was asked for read-only
 * `plan` — we fall back to the least-permissive supported mode, the closest the
 * backend can get, and flag `adapted` so callers can surface the gap.
 */
export function adaptPermissionMode(
  requested: AcpPermissionMode,
  protocol: ExternalAgentProtocol
): AdaptedPermissionMode {
  const supported = supportedPermissionModes(protocol)
  if (supported.includes(requested)) {
    return { mode: requested, requested, adapted: false }
  }

  const requestedRank = MODE_RANK[requested]
  const ascending = [...supported].sort((a, b) => MODE_RANK[a] - MODE_RANK[b])
  const atOrBelow = ascending.filter((m) => MODE_RANK[m] <= requestedRank)
  const chosen = atOrBelow.length > 0 ? atOrBelow[atOrBelow.length - 1] : ascending[0]

  return { mode: chosen, requested, adapted: true }
}
