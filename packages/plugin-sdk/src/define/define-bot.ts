/**
 * Plugin SDK helper for the `bot` capability.
 *
 * A `const` generic pass-through, so the executor discriminant and the trigger
 * kinds stay literal. Widening `executor: "handler"` to `string` would defeat
 * the union that keeps `workflow`, `team`, `prompt` and `entry` from being
 * declared together.
 *
 * Usage:
 *   export const digest = defineBot({
 *     id: "daily-digest",
 *     name: "Daily digest",
 *     version: "1.0.0",
 *     executor: "handler",
 *     entry: "./bots/digest.js",
 *     triggers: [{ id: "morning", kind: "schedule", cron: "0 9 * * 1-5" }],
 *     policy: { maxAutonomy: "confirm" },
 *   })
 *
 * The handler itself is typed with {@link defineBotHandler}, which is the same
 * identity pass-through for the other half of the contract.
 */

import type { PluginBotDef } from "@/types/plugin/plugin-bot"
import type { BotHandlerV1 } from "@/types/bot/run"

export function defineBot<const T extends PluginBotDef>(def: T): T {
  return def
}

/**
 * Type a Bot's durable handler.
 *
 * The handler is re-entered from the top after a crash or a resumed wait, so
 * anything that must not happen twice belongs inside `ctx.step.run`.
 */
export function defineBotHandler(handler: BotHandlerV1): BotHandlerV1 {
  return handler
}
