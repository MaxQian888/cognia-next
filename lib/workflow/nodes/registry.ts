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

export type NodeExecuteFn = (ctx: StepExecutionContext) => Promise<StepExecutionResult>

export interface NodeExecutorRegistration {
  kind: WorkflowNodeKind
  typeVersion: number
  execute: NodeExecuteFn
  /** Whether the node should retry on transient failure. Default true. */
  retryable?: boolean
  /** Maximum runtime in ms; the orchestrator aborts after. Default uses workflow setting. */
  timeoutMs?: number
}

export type NodeRegistryEventType = "register" | "unregister"

export interface NodeRegistryEvent {
  type: NodeRegistryEventType
  kind: WorkflowNodeKind
  typeVersion: number
}

export type NodeRegistryListener = (event: NodeRegistryEvent) => void

const registry = new Map<string, NodeExecutorRegistration>()
const listeners = new Set<NodeRegistryListener>()

function key(kind: WorkflowNodeKind, version: number): string {
  return `${kind}@${version}`
}

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
  registry.set(key(reg.kind, reg.typeVersion), reg)
  emit({ type: "register", kind: reg.kind, typeVersion: reg.typeVersion })
}

/**
 * Remove a previously registered executor. Used by the plugin runtime when
 * a plugin is disabled / unloaded so its node kinds disappear from the
 * editor and stop being scheduleable. Idempotent — silently no-ops if the
 * (kind, version) pair is not registered.
 */
export function unregisterNodeExecutor(kind: WorkflowNodeKind, version: number): void {
  const k = key(kind, version)
  if (!registry.has(k)) return
  registry.delete(k)
  emit({ type: "unregister", kind, typeVersion: version })
}

export function getExecutor(
  kind: WorkflowNodeKind,
  version: number
): NodeExecutorRegistration | undefined {
  return registry.get(key(kind, version))
}

export function listRegisteredKinds(): WorkflowNodeKind[] {
  const kinds = new Set<WorkflowNodeKind>()
  for (const reg of registry.values()) kinds.add(reg.kind)
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
  registry.clear()
  listeners.clear()
}
