/**
 * Type contracts for plugin-contributed workflow extensions.
 *
 * Plugins extend the visual workflow editor in two ways:
 * 1. Custom **node executors** (`PluginNodeDef`) — appear in the editor's
 *    Sidebar palette under a "Plugin nodes" group, scheduled by the
 *    orchestrator like any built-in.
 * 2. Custom **trigger sources** (`PluginTriggerDef`) — produce
 *    `TriggerEvent`s that wake workflows. The plugin owns the lifecycle
 *    of the long-running listener via `start` / `stop`.
 *
 * The runtime registers these via `PluginContext.workflow.register*`
 * (see `lib/plugin/core/context.ts`). Both definition kinds live behind
 * the `extension:workflow` permission gate — declared in
 * `lib/plugin/contracts/plugin-points.ts:CANONICAL_RUNTIME_POINTS`.
 *
 * See ADR 0017 for the full design.
 */

import type {
  StepExecutionContext,
  StepExecutionResult,
  WorkflowNodeCategory,
} from "@/types/workflow/visual"

/** Node executor function — same shape as built-in node executors. */
export type PluginNodeExecuteFn = (ctx: StepExecutionContext) => Promise<StepExecutionResult>

/**
 * A node definition the plugin contributes to the workflow editor catalog.
 * `kind` is automatically prefixed with `<pluginId>.` at registration time
 * to prevent collisions, so plugin authors should provide a short
 * unprefixed identifier (e.g., `"action.fetchPage"`).
 */
export interface PluginNodeDef {
  /** Unprefixed kind (e.g. `"action.fetchPage"`). Runtime prefixes pluginId. */
  kind: string
  /** Definition version — bump when params schema changes incompatibly. */
  typeVersion: number
  /**
   * Editor category. Most plugin nodes use `"plugin"` so they land in the
   * dedicated "Plugin nodes" group; advanced authors can pick a built-in
   * category to interleave with the host's nodes.
   */
  category: WorkflowNodeCategory | "plugin"
  /** Display name in the catalog. */
  label: string
  /** Short description shown in the catalog tooltip. */
  description: string
  /** lucide-react icon name; falls back to `Box` when missing. */
  iconName: string
  /** Search keywords beyond label/description. Optional. */
  keywords?: string[]
  /**
   * JSON Schema describing the node's params. Drives the auto-generated
   * inspector form when the plugin doesn't supply a custom config component.
   */
  paramsSchema: Record<string, unknown>
  /** Default param values inserted when the node is dropped on the canvas. */
  defaultParams?: Record<string, unknown>
  /** Marks the node as desktop-only; the editor shows a `Desktop` badge. */
  desktopOnly?: boolean
  /** Whether the orchestrator should retry on transient failure. Default true. */
  retryable?: boolean
  /** Per-node timeout (ms). Falls back to the workflow's default. */
  timeoutMs?: number
  /** The actual executor invoked by the orchestrator. */
  execute: PluginNodeExecuteFn
}

/**
 * Lifecycle handle returned by `PluginTriggerDef.start`. The host calls
 * `stop()` when the trigger is unregistered (plugin disable, workflow
 * delete, host shutdown). Stop must be idempotent.
 */
export interface PluginTriggerHandle {
  stop(): Promise<void> | void
}

export interface PluginTriggerStartContext {
  /** The workflow this trigger feeds. */
  workflowId: string
  /** Workflow author's per-instance trigger params. */
  params: Record<string, unknown>
  /**
   * Emit a trigger event. The host wraps this into a full `TriggerEvent`
   * and dispatches it to the orchestrator (and, in headless mode, the
   * Rust scheduler).
   */
  emit(payload: unknown): void
  /** Aborted on plugin teardown so long-poll loops can wind down cleanly. */
  signal: AbortSignal
  /** Plugin-scoped logger; lines flow through the host's audit log. */
  logger: PluginTriggerLogger
}

export interface PluginTriggerLogger {
  debug(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
}

export interface PluginTriggerDef {
  /** Unprefixed kind (e.g. `"trigger.cronEx"`). Runtime prefixes pluginId. */
  kind: string
  typeVersion: number
  label: string
  description: string
  iconName: string
  paramsSchema: Record<string, unknown>
  defaultParams?: Record<string, unknown>
  desktopOnly?: boolean
  /**
   * Begin emitting events. Must return a handle whose `stop()` shuts the
   * source down. May be called multiple times (one start per workflow
   * binding); the host tracks each instance separately.
   */
  start(ctx: PluginTriggerStartContext): Promise<PluginTriggerHandle>
}

/** Manifest-side mirror of `PluginNodeDef` — `execute` is resolved at runtime. */
export interface PluginManifestNodeDef {
  kind: string
  typeVersion: number
  category: WorkflowNodeCategory | "plugin"
  label: string
  description: string
  iconName: string
  keywords?: string[]
  paramsSchema: Record<string, unknown>
  defaultParams?: Record<string, unknown>
  desktopOnly?: boolean
  retryable?: boolean
  timeoutMs?: number
}

/** Manifest-side mirror of `PluginTriggerDef`. */
export interface PluginManifestTriggerDef {
  kind: string
  typeVersion: number
  label: string
  description: string
  iconName: string
  paramsSchema: Record<string, unknown>
  defaultParams?: Record<string, unknown>
  desktopOnly?: boolean
}

/** Optional `workflows` block under `PluginManifest`. */
export interface PluginManifestWorkflowsBlock {
  nodes?: PluginManifestNodeDef[]
  triggers?: PluginManifestTriggerDef[]
}
