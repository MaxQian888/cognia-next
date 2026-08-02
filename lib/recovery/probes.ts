import type { RecoverySubsystem } from "@cognia/logging"
import { RECOVERY_ORDER } from "@cognia/logging"

/**
 * Read-only health probes for the six recovery groups (ADR-0102 §4).
 *
 * Every probe here must be **side-effect free**. That is not a style
 * preference: these run while the app is already suspected of being broken, in
 * the order the groups get re-enabled, and a probe that starts a sidecar or
 * activates a plugin would be doing the very thing recovery is trying to avoid
 * until the group is cleared. Read state, decide, return.
 *
 * Each probe answers one question: *would enabling this group fail?* — not "is
 * this group perfect". A `reasonCode` is a stable identifier the operator UI
 * localizes; never a sentence.
 */

export interface RecoveryProbeResult {
  ok: boolean
  /** Stable identifier, e.g. `plugins.manifest_invalid`. Absent when ok. */
  reasonCode?: string
}

export type RecoveryProbe = () => Promise<RecoveryProbeResult>

export type RecoveryProbeSet = Record<RecoverySubsystem, RecoveryProbe>

const OK: RecoveryProbeResult = { ok: true }

function failed(reasonCode: string): RecoveryProbeResult {
  return { ok: false, reasonCode }
}

/**
 * Run a probe without letting it throw. A probe that blows up *is* a failed
 * probe — losing that to an unhandled rejection would silently mark the group
 * healthy.
 */
export async function runProbe(
  probe: RecoveryProbe,
  fallbackReasonCode: string
): Promise<RecoveryProbeResult> {
  try {
    return await probe()
  } catch {
    // The thrown value is deliberately not read: a probe error can carry a
    // file path or a connection string, and this result is persisted.
    return failed(fallbackReasonCode)
  }
}

/** Dependencies each default probe needs, injected so tests need no app graph. */
export interface RecoveryProbeDeps {
  /** Opens the Dexie database and returns a row count from a core table. */
  countPluginRows: () => Promise<number>
  /** Installed plugin rows, for manifest validation. */
  listPluginManifests: () => Promise<{ id: string; manifest: unknown }[]>
  validateManifest: (manifest: unknown) => { valid: boolean }
  /** Sidecar readiness query — a status read, never a spawn. */
  getSidecarStatus: () => Promise<{ ready: boolean }>
  /** Connector adapter ids the build knows about. */
  listConnectorAdapterIds: () => readonly string[]
  /** Adapter ids referenced by persisted connector state. */
  listReferencedConnectorAdapterIds: () => Promise<string[]>
  /** Stored workflow rows. */
  listWorkflowIds: () => Promise<string[]>
  /** Registered external agents. */
  listExternalAgentIds: () => Promise<string[]>
}

/**
 * Build the probe set from injected dependencies.
 *
 * Split from the wiring below so a test can exercise every branch — including
 * the failure branches, which are the ones that matter — without a database, a
 * sidecar, or a Tauri host.
 */
export function createRecoveryProbes(deps: RecoveryProbeDeps): RecoveryProbeSet {
  return {
    database: async () => {
      const count = await deps.countPluginRows()
      // A negative count is not a number Dexie can return; treating it as a
      // failure means a stubbed or corrupted adapter cannot pass the gate.
      return Number.isFinite(count) && count >= 0 ? OK : failed("database.unreadable")
    },

    plugins: async () => {
      const rows = await deps.listPluginManifests()
      const broken = rows.find((row) => !deps.validateManifest(row.manifest).valid)
      return broken ? failed("plugins.manifest_invalid") : OK
    },

    sidecar: async () => {
      const status = await deps.getSidecarStatus()
      return status.ready ? OK : failed("sidecar.not_ready")
    },

    connectors: async () => {
      const known = new Set(deps.listConnectorAdapterIds())
      const referenced = await deps.listReferencedConnectorAdapterIds()
      const orphan = referenced.find((id) => !known.has(id))
      return orphan ? failed("connectors.adapter_missing") : OK
    },

    workflow: async () => {
      const ids = await deps.listWorkflowIds()
      // A row without an id cannot be scheduled or resumed; the workflow
      // runtime would throw on it at boot.
      const broken = ids.some((id) => typeof id !== "string" || id.length === 0)
      return broken ? failed("workflow.definition_unreadable") : OK
    },

    "external-agent": async () => {
      const ids = await deps.listExternalAgentIds()
      const broken = ids.some((id) => typeof id !== "string" || id.length === 0)
      return broken ? failed("external_agent.registry_unreadable") : OK
    },
  }
}

/** Fallback reason code used when a probe throws. */
export const PROBE_FALLBACK_REASON: Record<RecoverySubsystem, string> = {
  database: "database.probe_threw",
  plugins: "plugins.probe_threw",
  sidecar: "sidecar.probe_threw",
  connectors: "connectors.probe_threw",
  workflow: "workflow.probe_threw",
  "external-agent": "external_agent.probe_threw",
}

export interface RecoverySequenceStep {
  subsystem: RecoverySubsystem
  result: RecoveryProbeResult
}

/**
 * Run the probes in `RECOVERY_ORDER`, stopping at the first failure.
 *
 * Stopping is the contract, not an optimization: later groups depend on
 * earlier ones, so probing `workflow` after `database` failed would report a
 * second failure that is really the first one wearing a different name.
 *
 * `onResult` is awaited between steps so each outcome is persisted by the
 * native controller before the next probe runs — a crash mid-sequence then
 * resumes with the progress it had, instead of starting over.
 */
export async function runRecoverySequence(
  probes: RecoveryProbeSet,
  onResult: (subsystem: RecoverySubsystem, result: RecoveryProbeResult) => Promise<void> | void,
  options: { skip?: readonly RecoverySubsystem[]; startAt?: RecoverySubsystem } = {}
): Promise<RecoverySequenceStep[]> {
  const skip = new Set(options.skip ?? [])
  const startIndex = options.startAt ? RECOVERY_ORDER.indexOf(options.startAt) : 0
  const steps: RecoverySequenceStep[] = []

  for (const subsystem of RECOVERY_ORDER.slice(Math.max(0, startIndex))) {
    if (skip.has(subsystem)) continue
    const result = await runProbe(probes[subsystem], PROBE_FALLBACK_REASON[subsystem])
    steps.push({ subsystem, result })
    await onResult(subsystem, result)
    if (!result.ok) break
  }

  return steps
}
