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

import { nanoid } from "nanoid"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginExternalAgentAdapterDef } from "@/types/plugin/plugin-external-agent-adapter"
import { sanitizePluginCapabilityMatrix } from "@cognia/agent-config-types/external-agent-capability"
import { loggers } from "@/lib/plugin/core/logger"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import {
  createPythonBackedProxy,
  createPythonContributionReleaser,
  isPythonBackedContribution,
  type PythonCallTransport,
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
  /** Transport into the plugin's Python subprocess for python-backed
   *  adapters. Defaults to `plugin_python_call`; tests inject a fake. */
  pythonCall?: PythonCallTransport
  /** Per-wrapper instance-id factory for python-backed adapters. Defaults to
   *  `nanoid`; tests inject a deterministic one. */
  newInstanceId?: () => string
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

const PYTHON_ADAPTER_LABEL = "external-agent adapter"

/**
 * A `ProtocolAdapter` whose behaviour lives in the plugin's Python subprocess.
 *
 * Everything except `isConnected()` maps cleanly onto the seam: `prompt`
 * streams (the seam's generator satisfies `AsyncIterable`), the rest are plain
 * request/response calls. `isConnected()` is **synchronous** in the contract,
 * which an IPC round-trip cannot satisfy, so the wrapper tracks the flag
 * locally around `connect`/`disconnect` — the one piece of state the host is
 * entitled to answer without crossing the process boundary.
 *
 * Per-configuration isolation: the protocol factory runs once per external-
 * agent configuration, so one wrapper == one configuration. Each wrapper mints
 * its own instance id and every call carries it, which makes the Python host
 * route to an object owned by this wrapper alone (when the author decorated a
 * class) — configuration B's `connect` can no longer overwrite A's state, and
 * A's `disconnect` can no longer tear B down. After a successful `disconnect`
 * the wrapper releases its instance so the Python object does not outlive it;
 * a later `connect` on the same wrapper simply gets a fresh object.
 */
function createPythonProtocolAdapter(
  pluginId: string,
  contributionId: string,
  instanceId: string,
  call: PythonCallTransport | undefined
): ProtocolAdapter {
  const proxy = createPythonBackedProxy<
    Omit<ProtocolAdapter, "isConnected" | "setSessionMode" | "setSessionModel" | "getSessionModels">
  >({
    pluginId,
    contributionId,
    instanceId,
    ...(call ? { call } : {}),
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
    label: PYTHON_ADAPTER_LABEL,
  })
  const release = createPythonContributionReleaser({
    pluginId,
    contributionId,
    instanceId,
    label: PYTHON_ADAPTER_LABEL,
    ...(call ? { call } : {}),
  })
  let connected = false
  return {
    ...proxy,
    connect: async (config) => {
      await proxy.connect(config)
      connected = true
    },
    disconnect: async () => {
      // A failed disconnect leaves the Python object (and `connected`) as they
      // were, so the instance is only released once the plugin confirmed it.
      await proxy.disconnect()
      connected = false
      try {
        await release()
      } catch (err) {
        // The agent IS disconnected; a failed release only means the Python
        // object lingers until the plugin's runtime restarts (a stopped
        // runtime took it down already). Not worth failing the disconnect.
        loggers.manager.warn(
          `[external-agent-adapters-bridge] failed to release ${pluginId}:${contributionId} instance ${instanceId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
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
  const newInstanceId = options.newInstanceId ?? nanoid
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
        const contributionId = def.id
        factory = () =>
          createPythonProtocolAdapter(pluginId, contributionId, newInstanceId(), options.pythonCall)
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
