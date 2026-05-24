/**
 * Node executor registry — maps `(kind, typeVersion)` → execute function.
 *
 * Every node implementation registers itself here on import. The orchestrator
 * pulls executors via `getExecutor(kind, typeVersion)` and invokes them with
 * a `StepExecutionContext`. A missing registration produces a "no executor
 * registered" run failure rather than crashing — the failure is recoverable
 * (user installs a plugin / upgrades typeVersion / picks a different node).
 *
 * Listeners can subscribe to register/unregister events to keep dependent
 * surfaces (the editor's node palette, the catalog hot-merge, etc.) in sync
 * with plugin lifecycle changes. Built-in nodes register synchronously at
 * module load; the `subscribeNodeRegistry` machinery flushes its first
 * notification through `queueMicrotask` so a React effect that subscribes
 * after mount still sees the initial population.
 */

import type {
  StepExecutionContext,
  StepExecutionResult,
  WorkflowNodeKind,
} from "@/types/workflow/visual"
import { createOverlayRegistry } from "@/lib/plugin/registries/createOverlayRegistry"
import { loggers } from "@/lib/logging"

/**
 * Sentinel owner id for host-bundled executors. Built-ins register under this
 * id so the `first-wins-cross-plugin` policy protects them: a plugin trying to
 * register a built-in `kind@version` is rejected (the incumbent host executor
 * wins) and the collision is logged. A plugin can still refresh its OWN
 * registration (same owner id).
 */
export const BUILTIN_PLUGIN_ID = "__builtin__"

export type NodeExecuteFn = (ctx: StepExecutionContext) => Promise<StepExecutionResult>

export interface NodeExecutorRegistration {
  kind: WorkflowNodeKind
  typeVersion: number
  execute: NodeExecuteFn
  /** Whether the node should retry on transient failure. Default true. */
  retryable?: boolean
  /** Maximum runtime in ms; the orchestrator aborts after. Default uses workflow setting. */
  timeoutMs?: number
  /**
   * Owning plugin id. Absent for host built-ins (treated as
   * `BUILTIN_PLUGIN_ID`). Set by `ctx.workflow.registerNode` so cross-plugin
   * collisions are detected and built-ins protected.
   */
  pluginId?: string
}

export type NodeRegistryEventType = "register" | "unregister"

export interface NodeRegistryEvent {
  type: NodeRegistryEventType
  kind: WorkflowNodeKind
  typeVersion: number
}

export type NodeRegistryListener = (event: NodeRegistryEvent) => void

const listeners = new Set<NodeRegistryListener>()

function key(kind: WorkflowNodeKind, version: number): string {
  return `${kind}@${version}`
}

/**
 * Storage backend. Reuses the shared overlay-registry — the same factory the
 * plugin manager uses for skills / mcp-server-presets / subagents / … — so
 * node executors get pluginId tagging, conflict diagnostics, and
 * unregister-by-plugin for free instead of a bespoke `Map` with silent
 * last-wins overwrites. Keyed by `kind@typeVersion`; built-ins win over
 * plugins via `first-wins-cross-plugin`.
 */
const registry = createOverlayRegistry<NodeExecutorRegistration>({
  name: "workflow-node-executor",
  keyFn: (_id, entry) => key(entry.kind, entry.typeVersion),
  conflictPolicy: "first-wins-cross-plugin",
  onConflict: (info) => {
    loggers.plugin.warn(
      `[workflow] node executor "${info.key}" is owned by ` +
        `${info.existingPluginId ?? BUILTIN_PLUGIN_ID}; rejected registration from ` +
        `${info.incomingPluginId ?? BUILTIN_PLUGIN_ID}. Built-in and incumbent ` +
        `executors are not overwritten by other plugins.`
    )
  },
})

function emit(event: NodeRegistryEvent): void {
  // Defer dispatch so listeners that subscribe immediately after import-time
  // registration still observe the initial population. The registry itself
  // mutates synchronously — only listener notification is microtask-deferred.
  queueMicrotask(() => {
    for (const fn of listeners) {
      try {
        fn(event)
      } catch (err) {
        // Listeners must not throw across the registry boundary; downgrade.

        console.warn("Node registry listener threw:", err)
      }
    }
  })
}

export function registerNodeExecutor(reg: NodeExecutorRegistration): void {
  const owner = reg.pluginId ?? BUILTIN_PLUGIN_ID
  const k = key(reg.kind, reg.typeVersion)
  registry.register(reg.kind, reg, { pluginId: owner })
  // `first-wins-cross-plugin` may reject a cross-owner collision (onConflict
  // already logged it). Only emit a register event when the incoming entry
  // actually took effect, so listeners don't think a rejected node appeared.
  if (registry.get(k) === reg) {
    emit({ type: "register", kind: reg.kind, typeVersion: reg.typeVersion })
  }
}

/**
 * Remove a previously registered executor. Used by the plugin runtime when
 * a plugin is disabled / unloaded so its node kinds disappear from the
 * editor and stop being scheduleable. Idempotent — silently no-ops if the
 * (kind, version) pair is not registered.
 */
export function unregisterNodeExecutor(kind: WorkflowNodeKind, version: number): void {
  const removed = registry.unregisterById(key(kind, version))
  if (removed) emit({ type: "unregister", kind, typeVersion: version })
}

export function getExecutor(
  kind: WorkflowNodeKind,
  version: number
): NodeExecutorRegistration | undefined {
  return registry.get(key(kind, version))
}

export function listRegisteredKinds(): WorkflowNodeKind[] {
  const kinds = new Set<WorkflowNodeKind>()
  for (const { entry } of registry.entries()) kinds.add(entry.kind)
  return [...kinds]
}

/**
 * Subscribe to register/unregister events. Returns an unsubscribe function.
 * The first notification batch fires on the next microtask, so a subscriber
 * that mounts after eager built-in registration can still pick up the
 * current state by replaying the existing kinds.
 */
export function subscribeNodeRegistry(fn: NodeRegistryListener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Test-only: clear the registry. Production code should never call this. */
export function __resetRegistryForTesting(): void {
  registry.__resetForTesting()
  listeners.clear()
}
