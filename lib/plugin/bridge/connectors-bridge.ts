/**
 * Plugin connectors bridge — Task 110.
 *
 * Discovers plugin manifests that declare `connectors` entries, invokes each
 * entry's `factory` function to build a `PlatformAdapter`, and registers the
 * result with the `ConnectorBus` singleton.
 *
 * Lifecycle:
 *   - `registerPluginAdapters(pluginId, manifest, exports)` — call on plugin enable.
 *   - `unregisterPluginAdapters(pluginId)` — call on plugin disable/uninstall.
 *
 * The bridge is intentionally thin. It only discovers and wires; it does not
 * own the bus or impose any constraint on the adapter shape beyond what
 * `PlatformAdapter` requires. Policy, FIFO queuing, retries, etc. all flow
 * through the existing bus/runner machinery unchanged.
 *
 * NOTE: Plugin connector adapters run in the renderer (TypeScript), same as
 * built-in adapters. Their `PlatformAdapter.runPresentation` and
 * `runtimeCapabilities` members are first-class optional extension points and
 * pass through unchanged. Python-backed connector v1 remains on the generic
 * A2UI/plain-text projection because live presenter functions cannot cross the
 * subprocess boundary.
 */

import {
  __resetKnownConnectorKindsForTesting,
  registerPluginConnectorKind,
  unregisterPluginConnectorKindsByPlugin,
} from "@/lib/connectors/known-kinds"
import { refreshAllPackWarnings } from "@/lib/plugin/registries/character-pack-registry"
import type { PluginManifest, PluginConnectorDef } from "@/types/plugin/plugin"
import type {
  A2UICapabilityMatrix,
  AdapterContext,
  AdapterHealth,
  AdapterMeta,
  NormalizedInboundEvent,
  OutboundRequest,
  OutboundResult,
  PlatformAdapter,
} from "@/types/connectors"
import { getBus } from "@/lib/connectors/bus"
import {
  createPythonBackedProxy,
  isPythonBackedContribution,
  subscribePythonContributionPush,
} from "@/lib/plugin/bridge/_shared/python-backed-proxy"
import { canRunPythonBackedContribution } from "@/lib/plugin/python/experimental-flag"
import type { PluginAdapterFactory } from "@/types/connectors/plugin-adapter"
import { unregisterRunningAdapter } from "@/lib/connectors/lifecycle"
import { getConnectorRuntimeSupervisor } from "@/lib/connectors/runtime-supervisor"
import {
  __resetPluginConnectorRegistryForTesting,
  listPluginConnectorsFor,
  registerPluginConnector,
  unregisterPluginConnectors,
  type PluginConnectorRegistration,
  type PluginConnectorRejection,
} from "@/lib/connectors/plugin-connector-registry"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"
import type { TransportMode, TriggerPolicy } from "@/types/connectors"

/** Outcome of wiring one plugin's connector contributions. */
export interface PluginConnectorRegistrationReport {
  /** Connector kinds this plugin now owns. */
  registered: string[]
  /** Contributions refused, with the reason an author can act on. */
  rejected: Array<{ type: string; reason: PluginConnectorRejection; message: string }>
  /** Instance ids created because a contribution had none yet. */
  seeded: string[]
}

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The context object passed to each adapter factory function.
 * Mirrors `AdapterContext` from the adapter plan without importing it
 * (the full type lives in types/connectors/adapter.ts; we use a structural
 * subset here so the bridge stays decoupled from internal adapter details).
 */
export type { PluginAdapterContext } from "@/types/connectors/plugin-adapter"

/** A plugin's exported module — keys are function names. */
export type PluginExports = Record<string, unknown>

/**
 * Factory function signature a TypeScript plugin exports for each connector.
 *
 * Returning `runPresentation` opts the adapter into native durable-run
 * presentation; omitting it selects the host's capability-aware generic
 * projection. `runtimeCapabilities` must describe the real platform surface
 * rather than infer editability from a returned message id.
 */
export type AdapterFactory = PluginAdapterFactory

// ── Registry ─────────────────────────────────────────────────────────────────

/**
 * Build a `PlatformAdapter` whose behaviour lives in the plugin's Python
 * subprocess. Two parts of the contract cannot cross the process boundary
 * verbatim, and the wrapper owns both:
 *
 * - **`start(ctx)`** — `AdapterContext` carries live functions (`emit`,
 *   `logger`, `secrets`, `signal`). Only the serializable identity travels to
 *   Python; the inbound `emit` path comes *back* over the `plugin:python` push
 *   channel and is forwarded here.
 * - **`health()`** — synchronous in the contract, so an IPC round-trip cannot
 *   answer it. The wrapper tracks state around `start`/`stop`/`send`.
 *
 * This is why the `connectors` capability is `pythonExecution: "experimental"`.
 */
async function createPythonPlatformAdapter(
  pluginId: string,
  def: PluginConnectorDef
): Promise<PlatformAdapter> {
  const contributionId = def.type
  const proxy = createPythonBackedProxy<{
    describe(): Promise<{ meta: AdapterMeta; a2uiCapability: A2UICapabilityMatrix }>
    start(ctx: { adapterId: string }): Promise<void>
    stop(): Promise<void>
    send(req: OutboundRequest): Promise<OutboundResult>
  }>({
    pluginId,
    contributionId,
    methods: ["describe", "start", "stop", "send"],
    label: "connector adapter",
  })

  // `a2uiCapability()` is synchronous like `health()`, so the matrix is fetched
  // once at build time and answered from cache thereafter.
  const described = await proxy.describe()
  const adapterId = `${pluginId}:${contributionId}`
  let health: AdapterHealth = { state: "down" }
  let detachInbound: (() => void) | null = null

  return {
    id: adapterId,
    meta: described.meta,
    async start(ctx: AdapterContext): Promise<void> {
      // Wire inbound BEFORE the plugin starts so no early event is dropped.
      detachInbound = subscribePythonContributionPush({
        pluginId,
        contributionId,
        onPush: ({ channel, payload }) => {
          if (channel !== "inbound") return
          void ctx.emit(payload as NormalizedInboundEvent)
        },
      })
      health = { state: "starting" }
      try {
        await proxy.start({ adapterId: ctx.adapterId })
        health = { state: "running", lastActivityAt: Date.now() }
      } catch (error) {
        detachInbound?.()
        detachInbound = null
        health = {
          state: "down",
          reason: error instanceof Error ? error.message : String(error),
        }
        throw error
      }
    },
    async stop(): Promise<void> {
      try {
        await proxy.stop()
      } finally {
        detachInbound?.()
        detachInbound = null
        health = { state: "down" }
      }
    },
    health: () => health,
    a2uiCapability: () => described.a2uiCapability,
    async send(req: OutboundRequest): Promise<OutboundResult> {
      const result = await proxy.send(req)
      health = { ...health, lastActivityAt: Date.now() }
      return result
    },
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build and register all connector adapters declared by `manifest.connectors`.
 *
 * @param pluginId  Unique plugin identifier (from `manifest.id`).
 * @param manifest  The validated plugin manifest.
 * @param exports   The plugin module's exports (used to look up `factory` names).
 */
export async function registerPluginAdapters(
  pluginId: string,
  manifest: PluginManifest,
  exports: PluginExports
): Promise<PluginConnectorRegistrationReport> {
  const report: PluginConnectorRegistrationReport = { registered: [], rejected: [], seeded: [] }
  const defs = manifest.connectors
  if (!defs || defs.length === 0) return report

  for (const def of defs) {
    const pythonBacked = isPythonBackedContribution(def, manifest.type)
    if (pythonBacked && !canRunPythonBackedContribution("connectors")) {
      report.rejected.push({
        type: String(def.type),
        reason: "factory_missing",
        message:
          `python-backed connector "${def.type}" is experimental and the flag is off — ` +
          `enable it via setExperimentalPythonBackedEnabled`,
      })
      continue
    }

    // Python-backed contributions have no TS export to call; their factory is
    // the IPC proxy, built lazily per instance so a restart of the subprocess
    // does not strand a captured handle.
    const factory: PluginAdapterFactory | unknown = pythonBacked
      ? ((async () => createPythonPlatformAdapter(pluginId, def)) satisfies PluginAdapterFactory)
      : exports[def.factory]

    const result = registerPluginConnector({
      pluginId,
      pluginRelease: manifest.version ?? "0.0.0",
      def,
      factory,
    })
    if (!result.ok) {
      console.warn(
        `[connectors-bridge] plugin ${pluginId}: connector "${def.type}" refused — ${result.message}`
      )
      report.rejected.push({
        type: String(def.type),
        reason: result.reason,
        message: result.message,
      })
      continue
    }

    report.registered.push(result.registration.type)
    // Character Packs may declare `requires.connectors` against a plugin-owned
    // kind, so the resolvable set has to learn about it.
    registerPluginConnectorKind(pluginId, result.registration.type)

    // Seed one instance the first time a contribution is seen, so enabling a
    // plugin still produces a working bot rather than an empty settings page.
    // Everything after that is the user's: they can add more instances, edit
    // this one, or disable it. Previously there was exactly one unmanaged
    // adapter per contribution and no way to have two.
    const seededId = await seedInstanceForContribution(result.registration).catch((err) => {
      console.error(
        `[connectors-bridge] plugin ${pluginId}: could not seed an instance for "${def.type}" —`,
        err
      )
      return undefined
    })
    if (seededId) report.seeded.push(seededId)
  }

  if (report.registered.length > 0) refreshAllPackWarnings()
  return report
}

/**
 * Create the first instance for a freshly registered contribution.
 *
 * Idempotent by (type): a plugin that is disabled and re-enabled must not
 * accumulate duplicate bots. Returns the new row id, or `undefined` when an
 * instance already exists.
 *
 * The seeded row is ENABLED, which reproduces exactly what enabling a plugin
 * used to do — start one adapter — while making it an ordinary row the
 * supervisor owns. `install-connector-runtime`'s liveQuery over
 * `listEnabledAdapterInstances` picks it up with no further wiring.
 */
async function seedInstanceForContribution(
  registration: PluginConnectorRegistration
): Promise<string | undefined> {
  const { createAdapterInstance, listAdapterInstancesByType } =
    await import("@/lib/db/adapter-instances")
  const existing = await listAdapterInstancesByType(registration.type)
  if (existing.length > 0) return undefined

  const transportMode = (registration.def.transportModes?.[0] ?? "stub") as TransportMode
  const row = await createAdapterInstance({
    type: registration.type,
    displayName: registration.def.displayName ?? registration.type,
    enabled: true,
    transportMode,
    settings: {},
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: [] },
    trigger:
      (registration.def.defaultTrigger as TriggerPolicy | undefined) ?? defaultPrivateChatPolicy(),
    defaultMode: "auto",
    plugin: {
      pluginId: registration.pluginId,
      contributionId: registration.contributionId,
      pluginRelease: registration.pluginRelease,
    },
  })
  return row.id
}

/**
 * Unregister all connector adapters that were registered by `pluginId`.
 * Call on plugin disable or uninstall.
 */
export function unregisterPluginAdapters(pluginId: string): void {
  // Dropping the definitions is enough to stop the bots: every instance is an
  // ordinary row, and `buildAdapterFromRow` now returns null for a kind with no
  // owner, so the supervisor tears them down through its normal path. The rows
  // themselves stay — a user's settings and credentials must not disappear
  // because a plugin was toggled off.
  const removedKinds = unregisterPluginConnectors(pluginId)
  unregisterPluginConnectorKindsByPlugin(pluginId)

  // Stop every live instance of a kind this plugin owned. Reconciling is
  // enough: `buildAdapterFromRow` now returns null for an unowned kind, so the
  // supervisor tears the adapter down through its normal path and records why.
  const supervisor = getConnectorRuntimeSupervisor()
  const bus = getBus()
  for (const runtime of supervisor.listRunningAdapters()) {
    if (!removedKinds.includes(runtime.adapter.meta.type)) continue
    unregisterRunningAdapter(runtime.adapter.id)
    bus.unregisterAdapter(runtime.adapter.id)
    void supervisor.reconcileAdapter(runtime.adapter.id, "plugin_disabled")
  }
  // A pack that required one of this plugin's connector kinds must regain its
  // warning now that the kind is gone.
  refreshAllPackWarnings()
}

/**
 * Connector kinds a plugin currently provides.
 *
 * Replaces `getPluginAdapterIds`, which listed the ids of adapters the bridge
 * had started itself. It no longer starts any: instances are rows, so "which
 * bots does this plugin run?" is a Dexie question
 * (`listAdapterInstancesByType`), while "what can it provide?" is this one.
 */
export function getPluginConnectorKinds(pluginId: string): readonly string[] {
  return listPluginConnectorsFor(pluginId).map((r) => r.type)
}

/** Test-only: reset the internal registry. */
export function __resetBridgeForTesting(): void {
  __resetKnownConnectorKindsForTesting()
  __resetPluginConnectorRegistryForTesting()
}
