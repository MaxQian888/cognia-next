/**
 * Bot lifecycle hooks.
 *
 * A plugin Bot may declare `onInstall`, `onConfigure`, `onArm` and
 * `onUninstall` (decision D14, `PluginBotLifecycleDef`). They are host-
 * resolved exports/methods — not events — invoked synchronously inside the
 * administrative mutation that triggered them, on the host that owns the
 * installation. Remote callers reach them through
 * `mutateBotInstallationOnHost`, so each hook fires exactly once, never once
 * per peer.
 *
 * Semantics (Q3): the first three veto — a throw aborts the mutation before
 * its write. `onUninstall` can never veto; the installation is going away
 * regardless and a failing hook must not strand it, so its failure is only
 * logged.
 *
 * Hooks are not runs: no `runId`, no step memoization, no journal events.
 * Their only log line is a manager log (bounded cardinality), and the only
 * thing a hook receives is the same projected `BotInstallationSnapshot`
 * `ctx.bots.getInstallation` returns — never the raw row, which carries
 * credential binding ids the plugin must not see.
 */

import type { PluginBotLifecycleHookName } from "@/types/plugin/plugin-bot"
import type { BotLifecycleContextV1 } from "@/types/bot/run"
import type { BotInstallationRow } from "@/lib/db/bot-types"
import type { ResolvedBotDefinition } from "@/lib/bot/installed-bot"
import { getBot } from "@/lib/plugin/registries/bot-registry"
import { projectBotInstallationSnapshot } from "@/lib/bot/installation-snapshot"
import { loggers } from "@/lib/plugin/core/logger"

/** A hook that does not finish within this window counts as failed. */
export const BOT_LIFECYCLE_HOOK_TIMEOUT_MS = 30_000

/** A hook's failure, attributed to the phase that vetoed or errored. */
export class BotLifecycleHookError extends Error {
  constructor(
    readonly phase: PluginBotLifecycleHookName,
    readonly botId: string,
    cause: unknown
  ) {
    super(
      `Bot lifecycle hook "${phase}" failed for "${botId}": ` +
        (cause instanceof Error ? cause.message : String(cause)),
      cause instanceof Error ? { cause } : undefined
    )
    this.name = "BotLifecycleHookError"
  }
}

export interface RunBotLifecycleHookInput {
  /** The installation row as the hook should see it (pre-write for vetoes). */
  installation: BotInstallationRow
  /** The same installation's resolved definition. `source` gates everything. */
  definition: ResolvedBotDefinition
  phase: PluginBotLifecycleHookName
  /** `onConfigure` only: the config blob about to be replaced. */
  previousConfig?: Record<string, unknown>
  /** `onArm` only: the trigger and the armed state being written. */
  trigger?: { id: string; armed: boolean }
  /** Clock injection for tests; also bounds the timeout measurement. */
  now?: () => number
}

/**
 * Invoke one declared lifecycle hook, or return immediately when there is
 * nothing to invoke.
 *
 * Throws `BotLifecycleHookError` for `onInstall`, `onConfigure` and `onArm`
 * on hook failure or timeout — the caller lets it propagate so the mutation
 * aborts. For `onUninstall` the same failure is logged and swallowed.
 */
export async function runBotLifecycleHook(input: RunBotLifecycleHookInput): Promise<void> {
  const { installation, definition, phase } = input
  // Local definitions have no module to load hooks from.
  if (definition.source !== "plugin") return
  // `definition.id` is the namespaced `<pluginId>:<botId>` registry key —
  // the same spelling `installation.definitionId` stores.
  const hook = getBot(definition.id)?.lifecycle?.[phase]
  if (!hook) return
  const pluginId = definition.id.split(":")[0]
  const now = input.now ?? Date.now

  const context: BotLifecycleContextV1 = {
    installation: await projectBotInstallationSnapshot(installation, definition),
    ...(input.previousConfig !== undefined ? { previousConfig: input.previousConfig } : {}),
    ...(input.trigger ? { trigger: input.trigger } : {}),
  }

  const started = now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(() => hook(context)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`lifecycle hook exceeded ${BOT_LIFECYCLE_HOOK_TIMEOUT_MS}ms`)),
          BOT_LIFECYCLE_HOOK_TIMEOUT_MS
        )
      }),
    ])
    loggers.manager.info("[bot-lifecycle]", {
      pluginId,
      botId: definition.id,
      phase,
      durationMs: now() - started,
      outcome: "ok",
    })
  } catch (err) {
    loggers.manager.error(`[bot-lifecycle] ${phase} failed for ${definition.id}`, err)
    loggers.manager.info("[bot-lifecycle]", {
      pluginId,
      botId: definition.id,
      phase,
      durationMs: now() - started,
      outcome: "error",
    })
    // onUninstall is advisory: the row is already being removed, and a
    // broken hook must not strand the installation behind it.
    if (phase === "onUninstall") return
    throw new BotLifecycleHookError(phase, definition.id, err)
  } finally {
    clearTimeout(timer)
  }
}
