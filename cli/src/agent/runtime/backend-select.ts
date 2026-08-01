/**
 * `--backend` selection, for real.
 *
 * The rule this module exists to enforce: **the selected backend is the backend
 * that runs, or the run fails.** There is no silent substitution. A caller that
 * asked for `codex` and got the built-in sidecar has been lied to about which
 * model saw its code, which tools were available, and where its session lives —
 * and it has no way to notice.
 *
 * So there are exactly three outcomes:
 *   - the named backend exists and satisfies every hard `requires` → run it;
 *   - the name is unknown → `usage_error` naming the valid ids;
 *   - it exists but lacks a required capability → `unsupported_capability`
 *     naming the capability.
 *
 * Cognia tools and context are never dropped to make a backend fit. If a
 * backend cannot host them, that is a capability failure, not a downgrade.
 */

import type { AgentCapabilityId } from "@cognia/agent-config-types/agent-execution"
import type { AgentStructuredError } from "@cognia/agent-config-types/agent-run-result"

import { getAvailablePresets, getPresetConfig } from "@/lib/ai/agent/external/presets"

/** The built-in Cognia sidecar. Not a preset — it is the default host. */
export const BUILTIN_BACKEND = "builtin"

export type BackendKind = "builtin" | "external"

export interface SelectedBackend {
  /** Backend id exactly as it will be reported in `AgentRunResultV1.backend`. */
  id: string
  kind: BackendKind
  /** Human-readable name for diagnostics ("OpenCode (remote server)"). */
  displayName: string
  /** Capabilities effective for this backend, after clamping. */
  capabilities: AgentCapabilityId[]
}

/**
 * Capabilities the built-in sidecar provides. This is the reference set: it is
 * the only host that runs Cognia's own tool surface, permission gate and
 * context assembly end to end.
 */
export const BUILTIN_CAPABILITIES: readonly AgentCapabilityId[] = [
  "streaming",
  "session.multi-turn",
  "session.resume",
  "tools.ordinary",
  "tools.parallel",
  "tools.fragmented-json",
  "tools.results",
  "tools.errors",
  "mcp",
  "permissions.interrupt-resume",
  "permissions.set-mode",
  "prompt-caching",
  "thinking",
  "context-management",
  "images",
  "rate-limit-handling",
  "upstream-errors",
  "stream-interruption",
  "subagents.native",
  "set-model",
  "compaction",
]

/**
 * Capabilities every external agent backend provides regardless of protocol.
 * Deliberately conservative: anything not on this list must be proven per
 * protocol rather than assumed, because assuming a capability a backend lacks
 * is exactly how a caller ends up with a silently degraded run.
 */
const EXTERNAL_BASE_CAPABILITIES: readonly AgentCapabilityId[] = [
  "streaming",
  "session.multi-turn",
  "tools.ordinary",
  "tools.results",
  "tools.errors",
  "upstream-errors",
  "stream-interruption",
]

/**
 * Per-protocol additions on top of {@link EXTERNAL_BASE_CAPABILITIES}. Keyed by
 * the preset's `protocol`, since capability is a property of the wire protocol
 * rather than of the individual executable.
 */
const PROTOCOL_CAPABILITIES: Record<string, readonly AgentCapabilityId[]> = {
  acp: ["mcp", "permissions.interrupt-resume", "session.resume", "set-model", "images"],
  codex: ["mcp", "permissions.interrupt-resume", "session.resume", "set-model"],
  "codex-app-server": [
    "mcp",
    "permissions.interrupt-resume",
    "session.resume",
    "set-model",
    "steer",
  ],
  opencode: ["mcp", "session.resume", "set-model", "steer", "compaction"],
  "opencode-v2": ["mcp", "session.resume", "set-model", "steer", "compaction"],
}

export type BackendSelection =
  { ok: true; backend: SelectedBackend } | { ok: false; error: AgentStructuredError }

export interface BackendSelectOptions {
  /** Requested backend id. Absent / "builtin" selects the sidecar. */
  requested?: string
  /** Hard requirements. A missing one fails with `unsupported_capability`. */
  requires?: readonly AgentCapabilityId[]
  /** Preferred-but-optional; a missing one is reported, never fatal. */
  prefers?: readonly AgentCapabilityId[]
  /** Injected registry lookups (tests, plugin-contributed presets). */
  lookupPreset?: typeof getPresetConfig
  listPresets?: typeof getAvailablePresets
}

export interface BackendSelectResult extends SelectedBackend {
  /** Preferred capabilities this backend does not have. Report, don't fail. */
  disabledOptional: AgentCapabilityId[]
}

/** Capability set for an external preset, derived from its protocol. */
export function capabilitiesForProtocol(protocol: string | undefined): AgentCapabilityId[] {
  const extra = protocol ? (PROTOCOL_CAPABILITIES[protocol] ?? []) : []
  return [...new Set([...EXTERNAL_BASE_CAPABILITIES, ...extra])]
}

/**
 * Resolve `--backend` to a concrete host.
 *
 * Note the ORDER: existence is checked before capability. A typo must read as
 * "no such backend, here are the valid ones", not as a confusing capability
 * complaint about a backend the user never meant to name.
 */
export function selectBackend(
  options: BackendSelectOptions = {}
): { ok: true; backend: BackendSelectResult } | { ok: false; error: AgentStructuredError } {
  const lookupPreset = options.lookupPreset ?? getPresetConfig
  const listPresets = options.listPresets ?? getAvailablePresets
  const requested = options.requested?.trim()

  let candidate: SelectedBackend
  if (!requested || requested === BUILTIN_BACKEND) {
    candidate = {
      id: BUILTIN_BACKEND,
      kind: "builtin",
      displayName: "Cognia built-in sidecar",
      capabilities: [...BUILTIN_CAPABILITIES],
    }
  } else {
    const preset = lookupPreset(requested)
    if (!preset) {
      const available = [BUILTIN_BACKEND, ...listPresets()].join(", ")
      return {
        ok: false,
        error: {
          code: "usage_error",
          message: `unknown backend "${requested}" (available: ${available})`,
          detail: { requested, available },
        },
      }
    }
    candidate = {
      id: requested,
      kind: "external",
      displayName: preset.name ?? requested,
      capabilities: capabilitiesForProtocol(preset.protocol),
    }
  }

  const effective = new Set(candidate.capabilities)
  const missingRequired = (options.requires ?? []).filter((id) => !effective.has(id))
  if (missingRequired.length > 0) {
    const capability = missingRequired[0] as AgentCapabilityId
    return {
      ok: false,
      error: {
        code: "unsupported_capability",
        message: `backend "${candidate.id}" does not support ${missingRequired.join(", ")}`,
        capability,
        detail: { backend: candidate.id, missing: missingRequired },
      },
    }
  }

  const disabledOptional = (options.prefers ?? []).filter((id) => !effective.has(id))
  return { ok: true, backend: { ...candidate, disabledOptional } }
}

/**
 * Does this backend advertise native steering? Decides whether an enqueued
 * prompt reports `next-safe-boundary` or degrades to `after-settle`.
 */
export function supportsNativeSteering(backend: SelectedBackend): boolean {
  return backend.capabilities.includes("steer")
}
