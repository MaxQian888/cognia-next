/**
 * Renderer-side handler for `plugin_hook_exec` — the settings.json ⇄ plugin
 * lifecycle-hook bridge.
 *
 * A user writes `{ "type": "plugin", "pluginId": "…", "hookId": "onPreToolUse" }`
 * as a hook handler in `settings.json`; the sidecar round-trips here to run the
 * plugin's in-process callback. See `sidecar/dispatch/plugin-hook-exec.mjs` for
 * the wire protocol, and for why `host_rpc` could not carry it.
 *
 * ## Two independent gates
 *
 * Writing the handler into `settings.json` is the USER's authorization. The
 * plugin's declared `hooks:chat-intercept` capability is the PLUGIN's. Both must
 * pass, and only for a hook bound to an event that can actually block a turn —
 * an observational hook needs no extra permission beyond the plugin already
 * being installed and enabled.
 *
 * ## Failure policy
 *
 * Fail OPEN. An unknown plugin, a disabled plugin, a missing hook, a refused
 * permission or a throwing handler all resolve to "no decision" — never a
 * block. A misconfigured bridge must not be able to lock a user out of their
 * own agent. Only a decision the plugin itself returned can block.
 */

import { getPluginHookHandler, listHookContributors } from "@/lib/plugin/registries/hook-registry"
import type { PluginHooksAll } from "@/types/plugin/plugin-hooks"
import { createLogger } from "@cognia/logging"

const log = createLogger("claude.plugin-hook-ipc")

/**
 * Hook events where a plugin handler's decision can actually deny the turn.
 * Bound to one of these, the handler additionally requires the plugin to hold
 * `hooks:chat-intercept` — the same permission the in-process System-A
 * intercept hooks require (`lib/plugin/core/manager.ts:CHAT_INTERCEPT_HOOKS`).
 */
export const BLOCKING_HOOK_EVENTS: readonly string[] = ["PreToolUse", "UserPromptSubmit"]

/** The permission a plugin must declare to gate a turn. */
export const HOOK_INTERCEPT_PERMISSION = "hooks:chat-intercept"

/**
 * Sentinel `pluginId` meaning "every plugin contributing this hook", used by the
 * host's own seams (compaction) rather than by a user's settings.json entry —
 * a user always names one plugin. Mirrors `PLUGIN_HOOK_BROADCAST` in
 * `sidecar/dispatch/plugin-hook-exec.mjs`.
 */
export const PLUGIN_HOOK_BROADCAST = "*"

export interface PluginHookExecRequest {
  sessionId: string
  execId: string
  pluginId: string
  hookId: string
  payload: Record<string, unknown>
}

export interface PluginHookExecOutcome {
  result?: unknown
  error?: string
}

export interface HandlePluginHookDeps {
  /** Resolve a live plugin's hook handler. Defaults to the shared registry. */
  resolveHandler?: typeof getPluginHookHandler
  /** Does `pluginId` hold `permission`? Injected so this stays testable. */
  hasPermission?: (pluginId: string, permission: string) => boolean | Promise<boolean>
}

async function defaultHasPermission(pluginId: string, permission: string): Promise<boolean> {
  try {
    const { usePluginStore } = await import("@/stores/plugin-runtime")
    const row = usePluginStore.getState().plugins[pluginId] as
      { manifest?: { permissions?: string[] } } | undefined
    return Boolean(row?.manifest?.permissions?.includes(permission))
  } catch {
    // Cannot read the manifest ⇒ cannot prove the grant ⇒ do not let it gate.
    return false
  }
}

/**
 * Run one plugin lifecycle-hook round-trip. Never throws — every failure is
 * returned as a structured `error` so a faulty plugin cannot break the event
 * router, and the sidecar turns it into a non-blocking warning.
 */
export async function handlePluginHookExec(
  req: PluginHookExecRequest,
  deps: HandlePluginHookDeps = {}
): Promise<PluginHookExecOutcome> {
  const resolveHandler = deps.resolveHandler ?? getPluginHookHandler
  const hasPermission = deps.hasPermission ?? defaultHasPermission
  const label = `${req.pluginId}:${req.hookId}`

  if (req.pluginId === PLUGIN_HOOK_BROADCAST) {
    return runBroadcast(req, resolveHandler)
  }

  const handler = resolveHandler(req.pluginId, req.hookId)
  if (!handler) {
    // Absent, disabled, or simply does not contribute this hook. All three are
    // "nothing to run" — a stale settings.json entry must not block a turn.
    return { error: `no live handler for ${label}` }
  }

  const event = typeof req.payload?.hook_event_name === "string" ? req.payload.hook_event_name : ""
  if (BLOCKING_HOOK_EVENTS.includes(event)) {
    const granted = await hasPermission(req.pluginId, HOOK_INTERCEPT_PERMISSION)
    if (!granted) {
      // The plugin never asked to be able to deny a turn. Refuse the binding
      // rather than silently running it observationally — the user configured a
      // gate and deserves to know it is not one.
      return {
        error: `${label} is bound to ${event} but the plugin does not declare ${HOOK_INTERCEPT_PERMISSION}`,
      }
    }
  }

  try {
    const result = await handler(req.payload as never)
    return { result: result ?? null }
  } catch (e) {
    log.warn("plugin_hook_failed", { plugin: req.pluginId, hook: req.hookId, error: String(e) })
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Fan a host-owned hook out to every plugin contributing it and merge the
 * results shallowly, later contributors winning per key.
 *
 * Only used for host seams (compaction), never for a settings.json entry, so
 * the `hooks:chat-intercept` gate does not apply: the host chose to ask, and
 * these hooks are transformative rather than turn-gating. A throwing plugin is
 * skipped rather than failing the whole fan-out.
 */
async function runBroadcast(
  req: PluginHookExecRequest,
  resolveHandler: typeof getPluginHookHandler
): Promise<PluginHookExecOutcome> {
  const contributors = listHookContributors(req.hookId as keyof PluginHooksAll)
  if (contributors.length === 0) return { result: null }

  const merged: Record<string, unknown> = {}
  for (const pluginId of contributors) {
    const handler = resolveHandler(pluginId, req.hookId)
    if (!handler) continue
    try {
      const value = await handler(req.payload as never)
      if (value && typeof value === "object") Object.assign(merged, value)
    } catch (e) {
      log.warn("plugin_broadcast_hook_failed", {
        plugin: pluginId,
        hook: req.hookId,
        error: String(e),
      })
    }
  }
  return { result: merged }
}
