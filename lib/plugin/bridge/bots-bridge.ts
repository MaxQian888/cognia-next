/**
 * Bots Bridge.
 *
 * Resolves `manifest.bots[]` on plugin enable and drops every registration on
 * disable. Three of the four executors are pure data, so the bridge only has
 * real work to do for `executor: "handler"`: import the declared module and
 * take the named export, or, for a Python plugin, synthesize a handler that
 * round-trips one `run` call through the shared python-backed seam.
 *
 * Errors are collected, never thrown. One malformed Bot must not take the rest
 * of the plugin's contributions down with it, which is the same bargain
 * `ocr-providers-bridge` and `connectors-bridge` make.
 *
 * ## Why a Python handler gets a snapshot, not the context
 *
 * `BotRunContextV1` carries an `AbortSignal`, a `step` object and two
 * callbacks. None of them crosses stdio. The Python side is handed
 * {@link BotRunSnapshotV1} and reaches everything else through `ctx.bots.*`
 * host calls keyed by `runId`, which is exactly why those host methods take
 * and return plain values.
 *
 * A wait the Python handler cannot answer parks the same way an in-process
 * one does: the host call records the park intent in `pendingParks` and this
 * bridge throws the recorded `BotRunParkedError` once `proxy.run` settles —
 * it wins over both a normal result and a proxy error, so a handler that
 * ignored the park still parks. The SDK's own `BotRunParked` exception is
 * courtesy only: `wrapFailure` preserves only `message`, never the error's
 * identity, so the host never depends on it.
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type {
  PluginBotDef,
  PluginBotLifecycleHookName,
  PluginHandlerBotDef,
} from "@/types/plugin/plugin-bot"
import type {
  BotHandlerResultV1,
  BotHandlerV1,
  BotLifecycleContextV1,
  BotLifecycleHookV1,
  BotRunSnapshotV1,
} from "@/types/bot/run"

import { loggers } from "@/lib/plugin/core/logger"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import {
  createPythonBackedProxy,
  isPythonBackedContribution,
} from "@/lib/plugin/bridge/_shared/python-backed-proxy"
import {
  botDefinitionId,
  registerBot,
  unregisterBotsByPlugin,
} from "@/lib/plugin/registries/bot-registry"
import { takePendingPark } from "@/lib/bot/runtime/host-step"

export interface BotsBridgeError {
  pluginId: string
  botId: string
  message: string
}

export interface BotsBridgeResult {
  registered: number
  errors: BotsBridgeError[]
}

export interface BotsBridgeOptions {
  /**
   * How to dynamic-import a plugin entry file. Defaults to `import()`, and
   * tests inject a fake to keep the bridge hermetic.
   */
  importer?: (entry: string) => Promise<Record<string, unknown>>
}

const DEFAULT_IMPORTER: NonNullable<BotsBridgeOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

/** Default named export a handler Bot is read from when it names none. */
export const DEFAULT_BOT_HANDLER_EXPORT = "default"

/**
 * Register every Bot declared in `manifest.bots[]`.
 *
 * Idempotent at the plugin-id level: a second call for the same plugin first
 * drops the prior registrations, so a re-enable cannot leave a stale handler
 * bound to a definition that changed.
 */
export async function registerBotsForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: BotsBridgeOptions = {}
): Promise<BotsBridgeResult> {
  const pluginId = manifest.id
  const defs = manifest.bots ?? []
  if (defs.length === 0) return { registered: 0, errors: [] }

  unregisterBotsByPlugin(pluginId)

  const importer = options.importer ?? DEFAULT_IMPORTER
  const errors: BotsBridgeError[] = []
  let registered = 0

  for (const def of defs) {
    try {
      const handler =
        def.executor === "handler"
          ? await resolveHandler(def, pluginId, manifest.type, installRoot, importer)
          : undefined
      // Resolved inside the same try: a bad lifecycle fails the whole entry,
      // never leaves a half-Bot registered.
      const lifecycle = await resolveLifecycle(def, pluginId, manifest.type, installRoot, importer)
      registerBot(
        def.id,
        { id: botDefinitionId(pluginId, def.id), definition: def, handler, lifecycle },
        { pluginId }
      )
      registered++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ pluginId, botId: def.id, message })
      loggers.manager.error(`[bots-bridge] failed to register ${pluginId}:${def.id}`, err)
    }
  }

  return { registered, errors }
}

async function resolveHandler(
  def: PluginHandlerBotDef,
  pluginId: string,
  pluginType: PluginManifest["type"],
  installRoot: string,
  importer: NonNullable<BotsBridgeOptions["importer"]>
): Promise<BotHandlerV1> {
  if (isPythonBackedContribution(def, pluginType)) {
    const proxy = createPythonBackedProxy<{
      run: (snapshot: BotRunSnapshotV1) => Promise<BotHandlerResultV1 | void>
    }>({
      pluginId,
      contributionId: def.id,
      methods: ["run"],
      label: "Bot handler",
    })
    return async (ctx) => {
      try {
        return await proxy.run({
          runId: ctx.runId,
          installationId: ctx.installationId,
          botId: ctx.botId,
          event: ctx.event,
          config: ctx.config,
        })
      } finally {
        // A park the host recorded while the handler ran wins over whatever
        // `run` settled into — the wait was never answered, so the run must
        // leave the queue whether the handler agreed or not.
        const parked = takePendingPark(ctx.runId)
        if (parked) throw parked
      }
    }
  }

  if (!def.entry) {
    throw new Error(
      `JS-backed bot "${def.id}" must declare "entry"` +
        ` (set backend: "python" to run it in the plugin's Python subprocess)`
    )
  }

  // `entry` is a relative path already validated at manifest load time
  // (`lib/plugin/core/validation.ts`), resolved here against the install root.
  const resolved = resolvePluginPath(installRoot, def.entry)
  const mod = await importer(resolved)
  const exportName = def.export ?? DEFAULT_BOT_HANDLER_EXPORT
  const exported = mod[exportName]
  if (typeof exported !== "function") {
    throw new Error(
      `entry "${def.entry}" does not export a handler named "${exportName}" (got ${typeof exported})`
    )
  }
  return exported as BotHandlerV1
}

/**
 * Resolve `def.lifecycle.hooks` to callable functions, or `undefined` when
 * the definition declares none. A Python-backed Bot gets a second proxy on
 * the same contribution (`createPythonBackedProxy` carries no per-
 * contribution state, so the `run` proxy and this one coexist); a JS-backed
 * Bot's hooks are named exports of `lifecycle.entry ?? entry`.
 */
async function resolveLifecycle(
  def: PluginBotDef,
  pluginId: string,
  pluginType: PluginManifest["type"],
  installRoot: string,
  importer: NonNullable<BotsBridgeOptions["importer"]>
): Promise<Partial<Record<PluginBotLifecycleHookName, BotLifecycleHookV1>> | undefined> {
  const hooks = def.lifecycle?.hooks
  if (!hooks || hooks.length === 0) return undefined

  if (isPythonBackedContribution(def, pluginType)) {
    const proxy = createPythonBackedProxy<
      Record<PluginBotLifecycleHookName, (ctx: BotLifecycleContextV1) => Promise<void>>
    >({
      pluginId,
      contributionId: def.id,
      methods: hooks,
      label: "Bot lifecycle",
    })
    const lifecycle: Partial<Record<PluginBotLifecycleHookName, BotLifecycleHookV1>> = {}
    for (const hook of hooks) {
      lifecycle[hook] = (ctx) => proxy[hook](ctx)
    }
    return lifecycle
  }

  const entry = def.lifecycle?.entry ?? (def.executor === "handler" ? def.entry : undefined)
  if (!entry) {
    throw new Error(
      `JS-backed bot "${def.id}" declares lifecycle hooks but no entry to load them from`
    )
  }
  const resolved = resolvePluginPath(installRoot, entry)
  const mod = await importer(resolved)
  const lifecycle: Partial<Record<PluginBotLifecycleHookName, BotLifecycleHookV1>> = {}
  for (const hook of hooks) {
    const exported = mod[hook]
    if (typeof exported !== "function") {
      throw new Error(
        `entry "${entry}" does not export a lifecycle hook named "${hook}" (got ${typeof exported})`
      )
    }
    lifecycle[hook] = exported as BotLifecycleHookV1
  }
  return lifecycle
}

/** Plugin-disable hook. Drops every Bot this plugin contributed. */
export function unregisterBotsForPlugin(pluginId: string): void {
  unregisterBotsByPlugin(pluginId)
}
