/**
 * What every Bot executor is handed, and what it may return.
 *
 * Four executors, one shape. Three of them delegate to an engine that already
 * exists and is already governed (the workflow deployment authority, the Squad
 * start primitive, the agent turn send path), and the fourth calls a function
 * the plugin shipped. None of them is a new execution engine, which is the
 * whole premise: a Bot is a binding.
 */

import type { BotInstallationRow } from "@/lib/db/bot-types"
import type { BotComposition } from "@/lib/bot/composition/project-bot-composition"
import type { ResolvedBotDefinition } from "@/lib/bot/installed-bot"
import type { BotHandlerResultV1, BotRunContextV1 } from "@/types/bot/run"
import type { PluginBotExecutor, PluginBotPolicyV1 } from "@/types/plugin/plugin-bot"

/**
 * A superset of {@link BotRunContextV1}: everything a plugin handler gets,
 * plus what a host-side executor needs to reach its engine. A handler executor
 * can therefore pass the context straight through.
 */
export interface BotExecutorContext extends BotRunContextV1 {
  installation: BotInstallationRow
  definition: ResolvedBotDefinition
  composition: BotComposition
  /** The already-intersected ceiling. Never a grant. */
  policy: PluginBotPolicyV1
  /** Working directory the run resolved to, when it has one. */
  cwd?: string
}

export type BotExecutorFn = (
  ctx: BotExecutorContext
) => Promise<BotHandlerResultV1 | void> | BotHandlerResultV1 | void

/**
 * Raised when an executor cannot run at all, as opposed to running and
 * failing. Kept apart because only the second is worth retrying.
 */
export class BotExecutorUnavailableError extends Error {
  constructor(
    readonly executor: PluginBotExecutor,
    message: string
  ) {
    super(message)
    this.name = "BotExecutorUnavailableError"
  }
}
