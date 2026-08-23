/**
 * External-Agent Adapters Bridge.
 *
 * Resolves `manifest.externalAgentAdapters` contributions on plugin enable
 * (synthetic module-bridge key — field-driven, no capability tag, same posture
 * as `protocol-adapter` / `context-provider`).
 *
 * An external-agent adapter is always CODE: the plugin ships a
 * `() => ProtocolAdapter` factory. The bridge dynamic-imports the entry (ADR-0026
 * lazy entry, in the RENDERER where plugin code legitimately runs) and registers
 * the factory into the external-agent `protocolAdapterRegistry` under the
 * namespaced protocol `${pluginId}:${id}`, so it can never collide with a
 * built-in protocol (acp / codex-app-server / opencode / a2a) or another
 * plugin's adapter. The generic Rust process layer still owns subprocess spawn;
 * the contributed adapter only drives renderer-side protocol/session logic.
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginExternalAgentAdapterDef } from "@/types/plugin/plugin-external-agent-adapter"
import { sanitizePluginCapabilityMatrix } from "@cognia/agent-config-types/external-agent-capability"
import { loggers } from "@/lib/plugin/core/logger"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import {
  createPythonBackedProxy,
  isPythonBackedContribution,
} from "@/lib/plugin/bridge/_shared/python-backed-proxy"
import {
  getPluginProtocolAdapterProtocols,
  registerPluginProtocolAdapter,
  unregisterPluginProtocolAdaptersByPlugin,
  type ProtocolAdapter,
  type ProtocolAdapterFactory,
} from "@/lib/ai/agent/external/protocol-adapter"

export interface ExternalAgentAdaptersBridgeError {
  pluginId: string
  adapterId: string
  message: string
}

export interface ExternalAgentAdaptersBridgeResult {
  registered: number
  errors: ExternalAgentAdaptersBridgeError[]
}

export interface ExternalAgentAdaptersBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
}

const DEFAULT_IMPORTER: NonNullable<ExternalAgentAdaptersBridgeOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

/** Structural validation. Returns an error message or null. */
function validateDef(
  def: PluginExternalAgentAdapterDef,
  pluginType: string | undefined
): string | null {
  if (!def.id || typeof def.id !== "string") return "id is required"
  if (!def.label || typeof def.label !== "string") return "label is required"
  // Python-backed adapters resolve through the plugin_python_call seam and
  // therefore reference no JS module.
  if (isPythonBackedContribution(def, pluginType)) return null
  if (!def.entry || typeof def.entry !== "string") return "entry is required"
  if (!def.export || typeof def.export !== "string") return "export is required"
  return null
}

/**
 * A `ProtocolAdapter` whose behaviour lives in the plugin's Python subprocess.
 *
 * Everything except `isConnected()` maps cleanly onto the seam: `prompt`
 * streams (the seam's generator satisfies `AsyncIterable`), the rest are plain
 * request/response calls. `isConnected()` is **synchronous** in the contract,
 * which an IPC round-trip cannot satisfy, so the wrapper tracks the flag
 * locally around `connect`/`disconnect` — the one piece of state the host is
 * entitled to answer without crossing the process boundary.
 */
function createPythonProtocolAdapter(pluginId: string, contributionId: string): ProtocolAdapter {
  const proxy = createPythonBackedProxy<
    Omit<ProtocolAdapter, "isConnected" | "setSessionMode" | "setSessionModel" | "getSessionModels">
  >({
    pluginId,
    contributionId,
    methods: [
      "connect",
      "disconnect",
      "createSession",
      "closeSession",
      "prompt",
      "execute",
      "respondToPermission",
    ],
    streamingMethods: ["prompt"],
    label: "external-agent adapter",
  })
  let connected = false
  return {
    ...proxy,
    connect: async (config) => {
      await proxy.connect(config)
      connected = true
    },
    disconnect: async () => {
      await proxy.disconnect()
      connected = false
    },
    isConnected: () => connected,
  }
}

export async function registerExternalAgentAdaptersForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: ExternalAgentAdaptersBridgeOptions = {}
): Promise<ExternalAgentAdaptersBridgeResult> {
  const pluginId = manifest.id
  const defs = manifest.externalAgentAdapters ?? []
  if (defs.length === 0) {
    return { registered: 0, errors: [] }
  }

  // Clear prior registry entries on re-enable so a re-registration replaces
  // cleanly. Registry-only — NOT the full disable teardown — so a re-register
  // does not disconnect agents that are about to be restored below.
  unregisterPluginProtocolAdaptersByPlugin(pluginId)

  const importer = options.importer ?? DEFAULT_IMPORTER
  const errors: ExternalAgentAdaptersBridgeError[] = []
  const registeredProtocols: string[] = []
  let registered = 0

  for (const def of defs) {
    const invalid = validateDef(def, manifest.type)
    if (invalid) {
      errors.push({ pluginId, adapterId: def.id ?? "(missing id)", message: invalid })
      loggers.manager.error(
        `[external-agent-adapters-bridge] invalid contribution ${pluginId}:${def.id}: ${invalid}`
      )
      continue
    }

    const protocol = `${pluginId}:${def.id}`
    try {
      let factory: ProtocolAdapterFactory
      if (isPythonBackedContribution(def, manifest.type)) {
        factory = () => createPythonProtocolAdapter(pluginId, def.id)
      } else {
        const resolved = resolvePluginPath(installRoot, def.entry!)
        const mod = await importer(resolved)
        const exported = mod[def.export!]
        if (typeof exported !== "function") {
          throw new Error(`entry "${def.entry}" does not export a factory named "${def.export}"`)
        }
        factory = exported as ProtocolAdapterFactory
      }
      const ok = registerPluginProtocolAdapter(protocol, factory, {
        pluginId,
        adapterId: def.id,
        ...(def.version ? { version: def.version } : {}),
        // Sanitised, NOT forwarded verbatim. `mergeExternalAgentCapabilities`
        // enforces the ladder (a refinement cannot widen a protocol refusal)
        // but checks no shapes, so an out-of-vocabulary `level` would reach
        // `profile.effective` and silently disable the ceiling clamp for that
        // cell, and a manifest could stamp `cognia-verified` on its own work.
        // The contract owns both rules; the bridge only decides whether the
        // adapter loads.
        ...(def.capabilities
          ? { capabilities: sanitizePluginCapabilityMatrix(def.capabilities) }
          : {}),
      })
      if (!ok) {
        // Unreachable through the namespaced id, but keep the signal honest.
        errors.push({
          pluginId,
          adapterId: def.id,
          message: "protocol collides with a built-in or another plugin's adapter",
        })
        continue
      }
      registeredProtocols.push(protocol)
      registered++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ pluginId, adapterId: def.id, message })
      loggers.manager.error(
        `[external-agent-adapters-bridge] failed to load adapter ${protocol}: ${message}`
      )
      continue
    }
  }

  // Re-enable symmetry: an agent created earlier against this plugin's protocol
  // had its adapter dropped when the plugin was disabled. Now that the protocol
  // is registered again, revive those agents (recreate adapter + clear the
  // "plugin disabled" block) so they reconnect instead of staying dead. Lazy
  // import keeps the heavy manager graph out of the plugin-boot path; `peek`
  // is a no-op when no manager exists yet (nothing to restore).
  if (registeredProtocols.length > 0) {
    try {
      const { ExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
      ExternalAgentManager.peekInstance()?.restoreAgentsForProtocols(registeredProtocols)
    } catch (err) {
      loggers.manager.error(
        `[external-agent-adapters-bridge] failed to restore agents for ${pluginId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  return { registered, errors }
}

/**
 * Drop every external-agent adapter contributed by `pluginId` AND tear down the
 * live agents those protocols back, so a disabled plugin never leaks a spawned
 * external-agent process. The protocols are captured BEFORE unregistering (the
 * registry forgets ownership on unregister), then handed to the manager — but
 * only if a manager already exists (peek), so disabling an unrelated plugin
 * never instantiates it.
 */
export async function unregisterExternalAgentAdaptersForPlugin(pluginId: string): Promise<void> {
  const protocols = getPluginProtocolAdapterProtocols(pluginId)
  unregisterPluginProtocolAdaptersByPlugin(pluginId)
  if (protocols.length === 0) {
    return
  }
  try {
    const { ExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
    const manager = ExternalAgentManager.peekInstance()
    if (manager) {
      await manager.teardownAgentsByProtocols(protocols)
    }
  } catch (err) {
    loggers.manager.error(
      `[external-agent-adapters-bridge] failed to tear down agents for ${pluginId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}
