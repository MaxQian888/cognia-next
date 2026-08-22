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
 *
 * What this module no longer does is DECIDE what a backend can do. It used to
 * carry its own `PROTOCOL_CAPABILITIES` table — a third answer alongside the
 * renderer's `RUNTIME_CAPABILITIES.external` and the TUI's
 * `externalCapabilities()` — and the three disagreed. It claimed `steer` for
 * OpenCode, whose adapter has no `steerTurn` at all, so a `--requires steer`
 * run was admitted here and then failed at the first steer. Capabilities now
 * come from the external SSOT (ADR-0090): the protocol manifest row, the
 * preset refinement and this host's ceilings.
 *
 * Selection is the STATIC half of a two-phase admission, so it refuses only
 * what is already definitely wrong: refusing an `unknown` here would reject
 * agents that work. What happens to that `unknown` afterwards is narrower than
 * the design's full shape — the execution resolver refuses to freeze a spec
 * against a profile that never completed its handshake, but the hard-requirement
 * re-check (`admitNegotiatedExternalAgent`) has no caller, because nothing in
 * the product declares external hard requirements yet. `requires` below is
 * reachable from the API and has no CLI flag behind it.
 */

import type { AgentCapabilityId } from "@cognia/agent-config-types/agent-execution"
import type { AgentStructuredError } from "@cognia/agent-config-types/agent-run-result"
import {
  isCapabilityUsable,
  type ExternalAgentCapabilityId,
} from "@cognia/agent-config-types/external-agent-capability"

import { getAvailablePresets, getPresetConfig } from "@/lib/ai/agent/external/presets"
import { preflightExternalAgent } from "@/lib/ai/agent/external/capability-preflight"
import { externalAgentSandboxSupportsPlatform } from "@/lib/ai/agent/external/security-policy"

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

/**
 * The CLI's own host facts, as the capability profile sees them.
 *
 * Both halves are deliberate. `hookRuntimeAvailable` is false because the CLI's
 * external-agent session does not run Cognia's lifecycle hooks around an
 * external turn (the renderer does), and `toolHostRunning` is false because the
 * broker has not started at SELECTION time — it is a live fact, and claiming it
 * here would be a pre-handshake guess.
 */
const CLI_SELECTION_HOST_FACTS = {
  toolHostRunning: false,
  subagentDispatchProjected: false,
  hookRuntimeAvailable: false,
} as const

/**
 * Capability set for an external preset, from the external SSOT.
 *
 * Returns only the v2 ids: the external-only axes (`models.list`,
 * `mcp.logs`, …) have no place in `SelectedBackend.capabilities`, which feeds
 * `AgentExecutionEnvironment.hostCapabilities` and must speak the closed
 * vocabulary the resolver understands.
 */
export function capabilitiesForProtocol(
  protocol: string | undefined,
  presetId?: string
): AgentCapabilityId[] {
  if (!protocol) return []
  const preflight = preflightExternalAgent({
    protocol,
    ...(presetId ? { presetId } : {}),
    hostFacts: CLI_SELECTION_HOST_FACTS,
    ceilings: { sandboxAvailable: externalAgentSandboxSupportsPlatform() },
    // Selection must not depend on the adapter registry: the CLI resolves a
    // backend id before any protocol module is loaded, and a registry miss
    // there would read as "the plugin is disabled".
    hasAdapter: () => true,
  })
  const capabilities: AgentCapabilityId[] = []
  for (const [id, cell] of Object.entries(preflight.profile.effective)) {
    if (!isCapabilityUsable(cell.level)) continue
    if (isExternalOnly(id as ExternalAgentCapabilityId)) continue
    capabilities.push(id as AgentCapabilityId)
  }
  return capabilities
}

function isExternalOnly(id: ExternalAgentCapabilityId): boolean {
  return (
    id === "mcp.logs" ||
    id === "rate-limit-reporting" ||
    id === "subagents.model-selection" ||
    id === "models.list"
  )
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
      capabilities: capabilitiesForProtocol(preset.protocol, requested),
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
