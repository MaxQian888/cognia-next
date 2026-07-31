/**
 * Unified plugin-tool invocation seam.
 *
 * Every host-side caller that wants to execute a plugin-registered tool —
 * the sidecar `plugin_tool_exec` IPC path (`lib/claude/plugin-tool-ipc.ts`),
 * the `action.plugin.invoke` workflow node (`lib/workflow/nodes/built-ins.ts`),
 * and future surfaces (quick actions, agent team) — goes through
 * {@link invokePluginTool} so resolution, lazy activation, permission
 * consent, AbortSignal threading, and error normalization behave
 * identically everywhere.
 *
 * Behavior:
 *  - Resolves the tool through the live plugin manager registry (the same
 *    registry `ctx.agent.registerTool()` writes into).
 *  - If the owning plugin is not enabled and `autoActivate` is on
 *    (default), fires the `onTool:<name>` activation event so plugins that
 *    declared lazy activation light up exactly like they do for the chat
 *    agent (`manager.handleActivationEvent` is idempotent and skips
 *    enabled plugins).
 *  - Gates execution on the plugin's manifest-declared permissions: tiers
 *    `confirm`/`forbid` route through `checkWithConsent` (consent overlay /
 *    audit), the historical `silent` default executes without prompting.
 *  - Threads `AbortSignal` into `PluginToolContext.signal`.
 *  - Never executes a tool whose registry entry belongs to a different
 *    plugin than the caller named (ownership check).
 *
 * All failures throw a typed {@link PluginToolInvocationError}; callers
 * that need a never-throws contract (IPC) catch and collapse it.
 */

import type {
  PluginPermission,
  PluginResilienceConfig,
  PluginTool,
  PluginToolContext,
} from "@/types/plugin"
import { TimeoutError } from "@cognia/primitives"

import { breakerKey, getOrCreateBreaker } from "@/lib/plugin/resilience/breaker-registry"
import { resolveResilienceConfig } from "@/lib/plugin/resilience/config"
import { CircuitOpenError, runResilient } from "@/lib/plugin/resilience/run-resilient"

export type InvokePluginToolErrorCode =
  | "plugin-not-found"
  | "plugin-disabled"
  | "tool-not-found"
  | "permission-denied"
  | "aborted"
  | "circuit-open"
  | "timeout"
  | "execution-failed"

export class PluginToolInvocationError extends Error {
  readonly code: InvokePluginToolErrorCode
  readonly pluginId: string
  readonly toolName: string

  constructor(
    code: InvokePluginToolErrorCode,
    pluginId: string,
    toolName: string,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = "PluginToolInvocationError"
    this.code = code
    this.pluginId = pluginId
    this.toolName = toolName
  }
}

export interface InvokePluginToolOptions {
  /** Abort signal threaded into `PluginToolContext.signal`. */
  signal?: AbortSignal
  /** Chat/workflow session id surfaced to the tool. */
  sessionId?: string
  /** Message id surfaced to the tool. */
  messageId?: string
  /**
   * Attempt `onTool:<name>` lazy activation when the plugin is not
   * enabled. Defaults to `true` (mirrors the chat agent's behavior).
   */
  autoActivate?: boolean
  /** Reason string shown in the consent overlay / audit log. */
  reason?: string
}

export interface InvokePluginToolResult {
  result: unknown
  pluginId: string
  toolName: string
}

/**
 * Narrow views of the three singletons the seam touches. Kept structural
 * so tests can inject plain objects without constructing the real
 * manager/guard/broker (which throw or hit Dexie in jsdom).
 */
export interface InvokePluginToolDeps {
  getManager: () => {
    getPlugin: (pluginId: string) =>
      | {
          status: string
          config?: Record<string, unknown>
          manifest: { permissions?: PluginPermission[]; resilience?: PluginResilienceConfig }
        }
      | undefined
    getRegistry: () => { getTool: (name: string) => PluginTool | undefined }
    handleActivationEvent: (event: `onTool:${string}`) => Promise<void>
    /** Refresh the plugin's idle-suspend clock on tool use (optional so test
     * fixtures may omit it). */
    recordPluginToolUse?: (pluginId: string) => void
  }
  getGuard: () => {
    getTier: (pluginId: string, permission: PluginPermission) => "silent" | "confirm" | "forbid"
    checkWithConsent: (
      pluginId: string,
      permission: PluginPermission,
      broker: {
        request: (req: {
          pluginId: string
          permission: PluginPermission
          reason?: string
        }) => Promise<boolean>
      },
      options?: { reason?: string; context?: string }
    ) => Promise<boolean>
  }
  getBroker: () => {
    request: (req: {
      pluginId: string
      permission: PluginPermission
      reason?: string
    }) => Promise<boolean>
  }
}

let depsOverride: InvokePluginToolDeps | null = null

/**
 * Inject custom deps. Test-only — mirrors
 * `__setPluginToolResolverForTesting` in `lib/claude/plugin-tool-ipc.ts`.
 * Pass `null` to restore the dynamic-import defaults.
 */
export function __setInvokePluginToolDepsForTesting(deps: InvokePluginToolDeps | null): void {
  depsOverride = deps
}

/**
 * Default deps — lazy dynamic imports so the module graph doesn't drag
 * the plugin manager / permission guard into bundles that only need the
 * error type or option interfaces (same rationale as the IPC handler).
 */
async function defaultDeps(): Promise<InvokePluginToolDeps> {
  const [{ getPluginManager }, { getPermissionGuard }, { getPluginConsentBroker }] =
    await Promise.all([
      import("@/lib/plugin/core/manager"),
      import("@/lib/plugin/security/permission-guard"),
      import("@/lib/plugin/security/consent-broker"),
    ])
  return {
    getManager: () => getPluginManager(),
    // Pass the singleton getters through directly — no wrapper lambdas.
    getGuard: getPermissionGuard,
    getBroker: getPluginConsentBroker,
  }
}

/**
 * Resolve a plugin tool by its bare name (the only identifier the sidecar
 * wire carries). Returns the owning plugin id, or `undefined` when no
 * plugin registered the name or the manager isn't initialised. Reads the
 * same deps (and test override) as {@link invokePluginTool} so callers
 * that stub one stub both.
 */
export async function resolvePluginToolByName(
  toolName: string
): Promise<{ pluginId: string } | undefined> {
  const deps = depsOverride ?? (await defaultDeps())
  try {
    const tool = deps.getManager().getRegistry().getTool(toolName)
    return tool ? { pluginId: tool.pluginId } : undefined
  } catch {
    return undefined
  }
}

function abortedError(pluginId: string, toolName: string, cause?: unknown) {
  return new PluginToolInvocationError(
    "aborted",
    pluginId,
    toolName,
    `plugin tool invocation aborted: ${pluginId}/${toolName}`,
    { cause }
  )
}

/**
 * Execute `toolName` registered by `pluginId` with `args`.
 *
 * @throws {PluginToolInvocationError} on every failure mode — see
 * {@link InvokePluginToolErrorCode} for the taxonomy.
 */
export async function invokePluginTool(
  pluginId: string,
  toolName: string,
  args: Record<string, unknown>,
  options: InvokePluginToolOptions = {}
): Promise<InvokePluginToolResult> {
  if (options.signal?.aborted) {
    throw abortedError(pluginId, toolName, options.signal.reason)
  }

  const deps = depsOverride ?? (await defaultDeps())

  let manager: ReturnType<InvokePluginToolDeps["getManager"]>
  try {
    manager = deps.getManager()
  } catch (err) {
    // Manager not yet initialised (early renderer boot, headless test).
    throw new PluginToolInvocationError(
      "plugin-not-found",
      pluginId,
      toolName,
      `plugin manager unavailable while invoking ${pluginId}/${toolName}`,
      { cause: err }
    )
  }

  let plugin = manager.getPlugin(pluginId)
  if (!plugin) {
    throw new PluginToolInvocationError(
      "plugin-not-found",
      pluginId,
      toolName,
      `plugin ${pluginId} not found`
    )
  }

  // ── Lazy activation ────────────────────────────────────────────────────
  // Mirror the chat agent: a disabled plugin that declared an
  // `onTool:`-style activation event gets enabled on demand. The manager
  // skips enabled plugins and guards in-flight activations, so calling
  // unconditionally is safe + idempotent.
  if (plugin.status !== "enabled" && options.autoActivate !== false) {
    await manager.handleActivationEvent(`onTool:${toolName}`)
    plugin = manager.getPlugin(pluginId) ?? plugin
  }
  if (plugin.status !== "enabled") {
    throw new PluginToolInvocationError(
      "plugin-disabled",
      pluginId,
      toolName,
      `plugin ${pluginId} is not enabled (status: ${plugin.status})`
    )
  }

  // Refresh the idle-suspend clock: a plugin driven purely by agent tools must
  // not be suspended out from under an active run (the slash-command handler
  // does the same on command invocation).
  manager.recordPluginToolUse?.(pluginId)

  const tool = manager.getRegistry().getTool(toolName)
  // Ownership check: a caller naming plugin A must not execute plugin B's
  // tool just because the bare name matched in the shared registry.
  if (!tool || tool.pluginId !== pluginId) {
    throw new PluginToolInvocationError(
      "tool-not-found",
      pluginId,
      toolName,
      `plugin ${pluginId} has no registered tool '${toolName}'`
    )
  }

  // ── Permission consent gate ────────────────────────────────────────────
  // Tools don't declare per-tool permissions; gating operates on the
  // plugin's manifest-declared permission set. `silent` (the historical
  // default tier) executes without prompting; `confirm` routes through the
  // consent broker; `forbid` denies. Same mechanism as `createGuardedAPI`.
  const guard = deps.getGuard()
  const broker = deps.getBroker()
  const declared = plugin.manifest.permissions ?? []
  for (const permission of declared) {
    const tier = guard.getTier(pluginId, permission)
    if (tier === "silent") continue
    const allowed = await guard.checkWithConsent(pluginId, permission, broker, {
      reason: options.reason,
      context: `invokePluginTool:${toolName}`,
    })
    if (!allowed) {
      throw new PluginToolInvocationError(
        "permission-denied",
        pluginId,
        toolName,
        `permission ${permission} denied for plugin ${pluginId}`
      )
    }
  }

  if (options.signal?.aborted) {
    throw abortedError(pluginId, toolName, options.signal.reason)
  }

  const context: PluginToolContext = {
    sessionId: options.sessionId,
    messageId: options.messageId,
    config: plugin.config ?? {},
    signal: options.signal,
  }

  // ── Resilience: timeout + retry + per-plugin circuit breaker ───────────
  // The permission gate above runs exactly once, OUTSIDE the retry loop, so
  // consent is never re-prompted on a retry. Only `tool.execute` is wrapped.
  const cfg = resolveResilienceConfig(plugin.manifest, tool.definition)
  const key = breakerKey(pluginId, cfg.breakerScope === "plugin" ? "*" : toolName)
  const breaker = getOrCreateBreaker(key, {
    failureThreshold: cfg.breaker.failureThreshold,
    cooldownMs: cfg.breaker.cooldownMs,
    successThreshold: cfg.breaker.successThreshold,
  })

  try {
    const result = await runResilient(
      (attemptSignal) => tool.execute(args, { ...context, signal: attemptSignal }),
      {
        timeoutMs: cfg.timeoutMs,
        maxRetries: cfg.maxRetries,
        retryable: cfg.retryable,
        breaker,
        label: `${pluginId}/${toolName}`,
        signal: options.signal,
      }
    )
    return { result, pluginId, toolName }
  } catch (err) {
    if (options.signal?.aborted) {
      throw abortedError(pluginId, toolName, err)
    }
    if (err instanceof CircuitOpenError) {
      throw new PluginToolInvocationError(
        "circuit-open",
        pluginId,
        toolName,
        `circuit breaker open for ${pluginId}/${toolName} — too many recent failures`,
        { cause: err }
      )
    }
    if (err instanceof TimeoutError) {
      throw new PluginToolInvocationError("timeout", pluginId, toolName, err.message, {
        cause: err,
      })
    }
    throw new PluginToolInvocationError(
      "execution-failed",
      pluginId,
      toolName,
      err instanceof Error ? err.message : String(err),
      { cause: err }
    )
  }
}
