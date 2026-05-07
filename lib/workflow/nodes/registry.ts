/**
 * Node executor registry — maps `(kind, typeVersion)` → execute function.
 *
 * Every node implementation registers itself here on import. The orchestrator
 * pulls executors via `getExecutor(kind, typeVersion)` and invokes them with
 * a `StepExecutionContext`. A missing registration produces a "no executor
 * registered" run failure rather than crashing — the failure is recoverable
 * (user installs a plugin / upgrades typeVersion / picks a different node).
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

const registry = new Map<string, NodeExecutorRegistration>()

function key(kind: WorkflowNodeKind, version: number): string {
  return `${kind}@${version}`
}

export function registerNodeExecutor(reg: NodeExecutorRegistration): void {
  registry.set(key(reg.kind, reg.typeVersion), reg)
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

/** Test-only: clear the registry. Production code should never call this. */
export function __resetRegistryForTesting(): void {
  registry.clear()
}
