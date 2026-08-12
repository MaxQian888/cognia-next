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
import { buildAdapterContext } from "@/lib/connectors/adapter-context"
import {
  getRunningAdapter,
  registerRunningAdapter,
  unregisterRunningAdapter,
} from "@/lib/connectors/lifecycle"
import { getConnectorRuntimeSupervisor } from "@/lib/connectors/runtime-supervisor"

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

/** pluginId → list of adapter ids registered by that plugin */
const pluginAdapterIds = new Map<string, string[]>()

async function startPluginAdapter(
  adapter: PlatformAdapter,
  bus: ReturnType<typeof getBus>
): Promise<void> {
  if (getRunningAdapter(adapter.id)) {
    throw new Error(`Adapter id is already running: ${adapter.id}`)
  }
  const supervisor = getConnectorRuntimeSupervisor()
  supervisor.setDefinition({
    id: adapter.id,
    owner: "plugin",
    desiredState: () => "enabled",
    build: async () => adapter,
    registerRust: async () => undefined,
    unregisterRust: async () => undefined,
    start: async (built, signal) => {
      await built.start(buildAdapterContext({ adapterId: built.id, signal, bus }))
    },
    publish: (built) => {
      bus.registerAdapter(built)
      const active = supervisor.getRunningAdapter(built.id)
      if (!active) throw new Error(`Supervisor did not fence plugin adapter: ${built.id}`)
      registerRunningAdapter(built.id, {
        adapter: built,
        abortController: active.abortController,
        owner: "plugin",
        restart: () => supervisor.restartAdapter(built.id, "compatibility_restart"),
      })
    },
    unpublish: (adapterId) => {
      unregisterRunningAdapter(adapterId)
      bus.unregisterAdapter(adapterId)
    },
  })
  await supervisor.reconcileAdapter(adapter.id, "plugin_enabled")
  const observed = supervisor.getSnapshot(adapter.id)?.observedState
  if (observed !== "running" && observed !== "starting" && observed !== "degraded") {
    throw new Error(`Plugin adapter failed to start: ${adapter.id}`)
  }
}

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
): Promise<void> {
  const defs = manifest.connectors
  if (!defs || defs.length === 0) return

  const bus = getBus()
  const ids: string[] = []

  for (const def of defs) {
    const pythonBacked = isPythonBackedContribution(def, manifest.type)
    if (pythonBacked && !canRunPythonBackedContribution("connectors")) {
      console.warn(
        `[connectors-bridge] plugin ${pluginId}: python-backed connector "${def.type}" is ` +
          `experimental and the flag is off — skipping (enable via setExperimentalPythonBackedEnabled)`
      )
      continue
    }
    const factoryFn = pythonBacked ? undefined : exports[def.factory]
    if (!pythonBacked && typeof factoryFn !== "function") {
      console.warn(
        `[connectors-bridge] plugin ${pluginId}: factory "${def.factory}" not found in exports — skipping`
      )
      continue
    }

    let adapter: PlatformAdapter
    try {
      adapter = pythonBacked
        ? await createPythonPlatformAdapter(pluginId, def)
        : await (factoryFn as AdapterFactory)({ pluginId, connectorDef: def })
    } catch (err) {
      console.error(`[connectors-bridge] plugin ${pluginId}: factory "${def.factory}" threw —`, err)
      continue
    }

    try {
      await startPluginAdapter(adapter, bus)
    } catch (err) {
      console.error(
        `[connectors-bridge] plugin ${pluginId}: adapter "${adapter.id}" failed to start —`,
        err
      )
      continue
    }
    ids.push(adapter.id)
    // Character Packs may declare `requires.connectors` against a plugin-owned
    // kind, so the resolvable set has to learn about it.
    registerPluginConnectorKind(pluginId, def.type)
  }

  if (ids.length > 0) {
    pluginAdapterIds.set(pluginId, ids)
    refreshAllPackWarnings()
  }
}

/**
 * Unregister all connector adapters that were registered by `pluginId`.
 * Call on plugin disable or uninstall.
 */
export function unregisterPluginAdapters(pluginId: string): void {
  const ids = pluginAdapterIds.get(pluginId)
  if (!ids) return
  for (const id of ids) {
    unregisterRunningAdapter(id)
    getBus().unregisterAdapter(id)
    void getConnectorRuntimeSupervisor().removeDefinition(id, "plugin_disabled")
  }
  pluginAdapterIds.delete(pluginId)
  unregisterPluginConnectorKindsByPlugin(pluginId)
  // A pack that required one of this plugin's connector kinds must regain its
  // warning now that the kind is gone.
  refreshAllPackWarnings()
}

/**
 * Return the list of adapter ids currently owned by a plugin.
 * Primarily for tests and diagnostics.
 */
export function getPluginAdapterIds(pluginId: string): readonly string[] {
  return pluginAdapterIds.get(pluginId) ?? []
}

/** Test-only: reset the internal registry. */
export function __resetBridgeForTesting(): void {
  pluginAdapterIds.clear()
  __resetKnownConnectorKindsForTesting()
}
