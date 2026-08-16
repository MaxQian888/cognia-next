/**
 * Whether the Code tool presentation may be offered (ADR-0117, Phase 4).
 *
 * The rule this module exists to enforce is a single sentence from the ADR:
 * **when a strict sandbox is unavailable, Code fails closed with no degraded
 * path.** There is deliberately no "run it unsandboxed just this once" branch,
 * and no way for a caller to pass a flag that produces one — the only way to
 * get `available: true` is for the host to actually report a strict sandbox.
 *
 * The kill switch is separate from availability so the two reasons a user sees
 * are distinguishable: "this build turned Code off" and "this host cannot
 * sandbox it" call for different responses.
 */

import { AGENT_ORCHESTRATION_POLICIES } from "@cognia/agent-config-types/agent-composition"
import type {
  AgentOrchestrationPolicy,
  ToolPresentationMode,
} from "@cognia/agent-config-types/agent-composition"

const BUILD_CODE_MODE_DISABLED = process.env.NEXT_PUBLIC_CODE_MODE_KILL === "1"

/** The kill switch. Set `NEXT_PUBLIC_CODE_MODE_KILL=1` to remove Code entirely. */
export function isCodeModeKilled(environment?: Record<string, string | undefined>): boolean {
  if (!environment) return BUILD_CODE_MODE_DISABLED
  return environment.NEXT_PUBLIC_CODE_MODE_KILL === "1"
}

/**
 * What the host reports about its ability to run the sandbox.
 *
 * Every field defaults to the unsafe answer being *absent*: an unknown host
 * produces `available: false`, which is the fail-closed direction.
 */
export interface CodeSandboxProbe {
  /**
   * Whether a Node child process can be spawned. The sandbox is a separate
   * process, so without this there is no sandbox — browser and Capacitor hosts
   * land here.
   */
  canSpawnProcess: boolean
  /**
   * Whether the host can apply the OS-level confinement the runner relies on
   * (empty/read-only filesystem view, no network, scrubbed environment).
   * Reported by the sidecar, not assumed from the platform.
   */
  strictSandbox: boolean
}

export type CodeModeUnavailableReason = "killed" | "no-host-process" | "no-strict-sandbox"

export type CodeModeAvailability =
  { available: true } | { available: false; reason: CodeModeUnavailableReason }

export interface ResolveCodeModeAvailabilityInput {
  /** Absent means the host has not probed yet, which is treated as unavailable. */
  probe?: CodeSandboxProbe
  environment?: Record<string, string | undefined>
}

export function resolveCodeModeAvailability(
  input: ResolveCodeModeAvailabilityInput = {}
): CodeModeAvailability {
  if (isCodeModeKilled(input.environment)) {
    return { available: false, reason: "killed" }
  }
  // No probe at all is the same answer as a failed probe. An unprobed host is
  // not a host that "probably works".
  if (!input.probe?.canSpawnProcess) {
    return { available: false, reason: "no-host-process" }
  }
  if (!input.probe.strictSandbox) {
    return { available: false, reason: "no-strict-sandbox" }
  }
  return { available: true }
}

/** Presentations that are always available, regardless of host. */
const BASE_PRESENTATIONS: readonly ToolPresentationMode[] = ["native"]

/**
 * Presentations that need the sandbox.
 *
 * `both` is in here as well as `code`: it exposes the same `run_code` tool
 * alongside the native surface, so an unsandboxed host cannot offer it either.
 * Listing only `code` would leave `both` as an unguarded route to the same
 * executor.
 */
const SANDBOXED_PRESENTATIONS: readonly ToolPresentationMode[] = ["code", "both"]

/**
 * The `supportedToolPresentations` to hand `resolveComposition`.
 *
 * When Code is unavailable the value simply omits `code`, and the composition
 * resolver degrades a `code` selection to `native` with a visible warning. That
 * is the whole fail-closed path: the resolver already knows how to narrow, so
 * this module does not need a second, parallel refusal mechanism.
 */
export function supportedToolPresentations(
  input: ResolveCodeModeAvailabilityInput = {}
): ToolPresentationMode[] {
  const availability = resolveCodeModeAvailability(input)
  return availability.available
    ? [...BASE_PRESENTATIONS, ...SANDBOXED_PRESENTATIONS]
    : [...BASE_PRESENTATIONS]
}

/** Orchestrations are unaffected by the sandbox; listed for call-site symmetry. */
export function supportedOrchestrations(): AgentOrchestrationPolicy[] {
  return [...AGENT_ORCHESTRATION_POLICIES]
}
