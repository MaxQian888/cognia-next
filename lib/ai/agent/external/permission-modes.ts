import type { AcpPermissionMode, ExternalAgentProtocol } from "@/types/agent/external-agent"
import { isCapabilityUsable } from "@cognia/agent-config-types/external-agent-capability"
import { MODE_RANK } from "./permission-cascade"
import { externalCapabilityManifest } from "./capability-manifest"

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
 * - `pi-rpc` — all five. The bundled Cognia extension intercepts every native
 *   Pi tool call via `pi.on("tool_call")`, and `plan` / `dontAsk` additionally
 *   pin Pi's own `--tools` allowlist at spawn time, so the restrictive modes
 *   have a process-level floor rather than resting on interception alone.
 * - `codex-app-server` / `opencode` / `opencode-v2` — no pre-approval registry, so `dontAsk`
 *   ("deny unless pre-approved") has no distinct behaviour and is dropped; the
 *   other four map onto their native approval policies.
 * - `a2a` / `http` / `websocket` — fire-and-forget request/response transports
 *   with no client-side tool-approval loop, so only the pass-through `default`
 *   is meaningful; the remote agent owns its own policy.
 * - `dsh-sdk` — everything EXCEPT `default`. That exception is derived, not
 *   listed: see {@link supportedPermissionModes}.
 */
export const PROTOCOL_PERMISSION_MODE_SUPPORT: Record<
  ExternalAgentProtocol,
  readonly AcpPermissionMode[]
> = {
  acp: ALL_PERMISSION_MODES,
  // The launch-time modes only. `default` means "ask me per tool call", and
  // this transport cannot carry the question — `respondToPermission` on the DSH
  // SDK client throws, and the preset's own description says authority is
  // granted at launch. Listing all five here meant a user could pick `default`,
  // see it persisted, and get workspace-write behaviour with no prompt.
  // Enforced by {@link supportedPermissionModes} against the capability
  // manifest, so this row cannot drift back.
  "dsh-sdk": ["acceptEdits", "bypassPermissions", "plan", "dontAsk"],
  "pi-rpc": ALL_PERMISSION_MODES,
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
  const declared = PROTOCOL_PERMISSION_MODE_SUPPORT[protocol] ?? ALL_PERMISSION_MODES
  // `default` means "ask me per tool call" for any backend that has a local
  // authority model — and a protocol the capability manifest says cannot carry
  // a mid-turn question cannot honour that. Deriving the exception here rather
  // than trusting each row to remember is what stops a new protocol repeating
  // the DSH mistake: the row gets written before anyone checks the transport,
  // and the manifest is where that check already lives.
  //
  // The `length > 1` qualifier is what keeps a2a / http / websocket intact. For
  // them `default` is not a promise to ask, it is the pass-through: the remote
  // agent owns its own policy and there is no other mode to offer. Stripping it
  // would leave the picker empty and clamp to nothing.
  if (declared.length > 1 && declared.includes("default") && !protocolCanAskMidTurn(protocol)) {
    return declared.filter((mode) => mode !== "default")
  }
  return declared
}

/**
 * Can this protocol interrupt a turn to ask for approval?
 *
 * Reads the shipped capability manifest (ADR-0090 external SSOT). A protocol
 * with no manifest row — a plugin's — is given the benefit of the doubt: its
 * adapter clamps at runtime, and refusing `default` for every contributed
 * protocol would break the ones that do implement approval.
 */
function protocolCanAskMidTurn(protocol: ExternalAgentProtocol): boolean {
  const row =
    externalCapabilityManifest().protocols[
      protocol as keyof ReturnType<typeof externalCapabilityManifest>["protocols"]
    ]
  if (!row) return true
  return isCapabilityUsable(row.capabilities["permissions.interrupt-resume"].level)
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
