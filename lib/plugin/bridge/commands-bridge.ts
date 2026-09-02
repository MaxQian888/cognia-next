/**
 * Commands bridge, the python-backed half of `manifest.commands[]`.
 *
 * A python plugin registers its slash commands the same way every plugin
 * does: declaratively, in `manifest.commands[]`. The manager turns each entry
 * into a palette command plus a slash-registry entry whose handler ends in
 * `PluginLifecycleHooks.dispatchOnCommand`. That dispatcher hands the command
 * to the plugin's `hooks.onCommand`, and for a python plugin that hook is the
 * `@hook("onCommand")` handler the manager bridged over `plugin_python_call_hook`
 * (`registerPythonHooks` in `lib/plugin/core/manager.ts`).
 *
 * What was missing is the shape of the conversation. The JS contract is
 * positional, `onCommand(command, argv, context)`, and the python hook bridge
 * packs several positional arguments into a bare list, so a python handler
 * received `[command, argv, context]` and had to know the order. This bridge
 * gives python one structured invocation object instead, and normalizes what
 * comes back into the `PluginCommandResult` the host understands. It also
 * remembers which plugins run their commands in python so the dispatcher can
 * tell the two contracts apart per plugin.
 *
 * Wiring: `MODULE_BRIDGE_CAPABILITIES["commands"]` (`manifestField:
 * "commands"`) registers on enable and clears on disable, and
 * `dispatchOnCommand` consults `isPythonCommandPlugin` before every call.
 *
 * Which plugins are python-backed follows `isPythonBackedContribution`, the
 * rule every other module bridge uses: a `type: "python"` plugin is, a hybrid
 * plugin's commands stay with its JS module unless an entry says
 * `backend: "python"`.
 */

import type {
  PluginCommandContext,
  PluginCommandResult,
  PluginManifest,
  PluginManifestCommandDef,
} from "@/types/plugin/plugin"
import { isPythonBackedContribution } from "@/lib/plugin/bridge/_shared/python-backed-proxy"
import { loggers } from "@/lib/plugin/core/logger"

/**
 * What a python `@hook("onCommand")` handler receives, as one object.
 *
 * `command` is the manifest-local id the host dispatched (`hello`, not
 * `acme.hello`), `args` is the whitespace-split tail the user typed, and the
 * two optional ids identify where the command was typed so the handler can
 * bill `ctx.agent` calls to that session.
 */
export interface PythonCommandInvocation {
  command: string
  args: string[]
  sessionId?: string
  characterId?: string
}

/**
 * The bridged python hook, as the manager registered it. Called with a single
 * argument so the hook bridge ships that argument as the hook payload: the
 * bridge packs `args.length <= 1 ? args[0] : args`, and one object is exactly
 * what `_handle_call_hook` hands to the python function.
 */
export type PythonCommandHook = (invocation: PythonCommandInvocation) => Promise<unknown> | unknown

interface PythonCommandBinding {
  pluginId: string
  commandIds: Set<string>
}

const bindings = new Map<string, PythonCommandBinding>()

export interface RegisterCommandsOptions {
  /**
   * Does the plugin have a bridged `onCommand` hook right now? The manager
   * registers python hooks before the module bridges run, so at registration
   * time this answers whether the declared commands can ever be answered. A
   * plugin whose manifest promises commands and whose code never handles
   * them is logged, not refused: the palette entry still exists and the
   * slash handler still reports "not handled", exactly as for a JS plugin.
   */
  hasCommandHook?: (pluginId: string) => boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The manifest command entries this plugin executes in python. */
export function pythonBackedCommandDefs(manifest: PluginManifest): PluginManifestCommandDef[] {
  const defs = manifest.commands ?? []
  return defs.filter(
    (def): def is PluginManifestCommandDef =>
      isRecord(def) &&
      typeof def.id === "string" &&
      def.id.length > 0 &&
      isPythonBackedContribution(def, manifest.type)
  )
}

/**
 * Record which of a plugin's `manifest.commands[]` run in python. Registration
 * is declarative and never throws: an empty or JS-only manifest is a no-op.
 */
export function registerCommandsForPlugin(
  manifest: PluginManifest,
  options: RegisterCommandsOptions = {}
): void {
  const defs = pythonBackedCommandDefs(manifest)
  if (defs.length === 0) {
    bindings.delete(manifest.id)
    return
  }
  const commandIds = new Set(defs.map((def) => def.id))
  bindings.set(manifest.id, { pluginId: manifest.id, commandIds })
  if (options.hasCommandHook && !options.hasCommandHook(manifest.id)) {
    loggers.manager.warn(
      `[commands-bridge] ${manifest.id} declares ${commandIds.size} python-backed command(s) ` +
        `but registers no @hook("onCommand") handler, so they will answer "not handled"`
    )
  }
}

/** Forget a plugin's python-backed commands (disable, unload, suspend). */
export function unregisterCommandsForPlugin(pluginId: string): void {
  bindings.delete(pluginId)
}

/** Does this plugin answer its commands from python? */
export function isPythonCommandPlugin(pluginId: string): boolean {
  return bindings.has(pluginId)
}

/** The manifest-local ids of the plugin's python-backed commands. */
export function listPythonCommandIds(pluginId: string): string[] {
  const binding = bindings.get(pluginId)
  return binding ? [...binding.commandIds].sort() : []
}

/** Build the single object a python handler sees. Absent ids are omitted. */
export function buildPythonCommandInvocation(
  command: string,
  args: readonly string[],
  context?: PluginCommandContext
): PythonCommandInvocation {
  return {
    command,
    args: [...args],
    ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context?.characterId ? { characterId: context.characterId } : {}),
  }
}

/**
 * Normalize what a python handler returned into the host's result contract.
 *
 * `True` is the legacy bare acceptance, `False` / `None` decline, and a dict
 * with a boolean `handled` is the structured form. `message` must be a
 * string and `payload` an object to survive, anything else is dropped rather
 * than forwarded as a lie. A shape outside these is a decline that logs, so a
 * handler returning its own data by mistake is visible instead of silent.
 */
export function normalizePythonCommandOutcome(
  pluginId: string,
  command: string,
  outcome: unknown
): PluginCommandResult | null {
  if (outcome === true) return { handled: true }
  if (outcome === false || outcome === null || outcome === undefined) return null
  if (isRecord(outcome) && typeof outcome.handled === "boolean") {
    if (!outcome.handled) return null
    const result: PluginCommandResult = { handled: true }
    if (typeof outcome.message === "string") result.message = outcome.message
    if (isRecord(outcome.payload)) result.payload = outcome.payload
    return result
  }
  loggers.manager.warn(
    `[commands-bridge] ${pluginId} answered /${command} with an unrecognized value ` +
      `(${describeValue(outcome)}). Return True, False or {"handled": bool, "message": str}.`
  )
  return null
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return "list"
  if (typeof value === "object") return "object without a boolean handled"
  return typeof value
}

/**
 * Invoke a python plugin's `@hook("onCommand")` with one structured
 * invocation and return the host-shaped result. Errors propagate so
 * `dispatchOnCommand` can log them and keep looking, as it does for JS.
 */
export async function dispatchPythonCommand(
  pluginId: string,
  onCommand: PythonCommandHook,
  command: string,
  args: readonly string[],
  context?: PluginCommandContext
): Promise<PluginCommandResult | null> {
  const invocation = buildPythonCommandInvocation(command, args, context)
  const outcome = await onCommand(invocation)
  return normalizePythonCommandOutcome(pluginId, command, outcome)
}

/** Test-only: drop every binding. */
export function __resetCommandsBridgeForTesting(): void {
  bindings.clear()
}
