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
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginHandlerBotDef } from "@/types/plugin/plugin-bot"
import type { BotHandlerResultV1, BotHandlerV1, BotRunSnapshotV1 } from "@/types/bot/run"

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
      registerBot(
        def.id,
        { id: botDefinitionId(pluginId, def.id), definition: def, handler },
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
    return async (ctx) =>
      proxy.run({
        runId: ctx.runId,
        installationId: ctx.installationId,
        botId: ctx.botId,
        event: ctx.event,
        config: ctx.config,
      })
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

/** Plugin-disable hook. Drops every Bot this plugin contributed. */
export function unregisterBotsForPlugin(pluginId: string): void {
  unregisterBotsByPlugin(pluginId)
}
