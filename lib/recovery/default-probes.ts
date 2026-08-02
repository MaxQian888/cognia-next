import { createRecoveryProbes, type RecoveryProbeDeps, type RecoveryProbeSet } from "./probes"

/**
 * Wires the recovery probes to the real app.
 *
 * Every dependency is loaded through a dynamic `import()` for one reason: this
 * module runs when the app is *suspected of being broken*, and a static import
 * would pull the plugin, connector and sidecar graphs into the boot bundle —
 * making the diagnostics shell depend on the very subsystems it exists to
 * diagnose. Loading each one only when its probe runs also means a module that
 * throws on import is caught as that group's failure, which is exactly the
 * signal we want.
 *
 * Read-only is enforced by choosing read-only entry points, not by convention:
 * counts, list queries, a status read, and pure in-memory registries.
 */
export function createDefaultRecoveryProbeDeps(): RecoveryProbeDeps {
  return {
    countPluginRows: async () => {
      const { getDb } = await import("@/lib/db/schema")
      return getDb().plugins.count()
    },

    listPluginManifests: async () => {
      const { getDb } = await import("@/lib/db/schema")
      const rows = await getDb().plugins.toArray()
      return rows.map((row) => ({ id: row.id, manifest: row.manifest }))
    },

    validateManifest: (manifest) => {
      // Loaded eagerly-but-lazily by the caller below; kept synchronous here so
      // the probe stays a pure predicate over already-read rows.
      return manifestValidator?.(manifest) ?? { valid: true }
    },

    getSidecarStatus: async () => {
      const { getSidecarStatus } = await import("@/lib/claude/ipc")
      return getSidecarStatus()
    },

    listConnectorAdapterIds: () => connectorAdapterIds,

    listReferencedConnectorAdapterIds: async () => {
      // Configured adapter *instances* carry a `type` (the platform kind),
      // which is what `CONNECTOR_METADATA` is keyed by. An instance whose
      // platform this build no longer ships is precisely the case that makes
      // the connector runtime throw on boot.
      const { listAdapterInstances } = await import("@/lib/db/adapter-instances")
      const rows = await listAdapterInstances()
      return [...new Set(rows.map((row) => row.type))]
    },

    listWorkflowIds: async () => {
      const { listWorkflows } = await import("@/lib/db/workflows")
      const rows = await listWorkflows()
      return rows.map((row) => row.id)
    },

    listExternalAgentIds: async () => {
      const { listExternalAgents } = await import("@/lib/native/external-agent")
      return listExternalAgents()
    },
  }
}

/**
 * Synchronous slots the async preload below fills. The probe contract is
 * synchronous for these two because they are pure lookups over data the probe
 * already has; making them async would only hide that.
 */
let manifestValidator: ((manifest: unknown) => { valid: boolean }) | undefined
let connectorAdapterIds: readonly string[] = []

/**
 * Load the two pure registries the probes need. Safe to call more than once.
 * A failure here leaves the defaults in place — permissive for the manifest
 * validator and empty for connector ids — because a probe that cannot load its
 * own reference data must not condemn a subsystem that is probably fine.
 */
export async function preloadRecoveryProbeRegistries(): Promise<void> {
  try {
    const { validatePluginManifest } = await import("@/lib/plugin/core/validation")
    manifestValidator = (manifest) => validatePluginManifest(manifest)
  } catch {
    manifestValidator = undefined
  }
  try {
    const { listConnectorMetadata } = await import("@/lib/connectors/adapter-metadata")
    connectorAdapterIds = listConnectorMetadata().map((meta) => meta.type)
  } catch {
    connectorAdapterIds = []
  }
}

/** Test seam — resets the module-level registries between cases. */
export function resetRecoveryProbeRegistries(): void {
  manifestValidator = undefined
  connectorAdapterIds = []
}

/** The probe set the boot gate runs. */
export async function createDefaultRecoveryProbes(): Promise<RecoveryProbeSet> {
  await preloadRecoveryProbeRegistries()
  return createRecoveryProbes(createDefaultRecoveryProbeDeps())
}
