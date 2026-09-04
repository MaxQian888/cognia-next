/**
 * Run the durable handler a plugin shipped.
 *
 * The thinnest executor by design. The context a handler receives IS the
 * executor context, so there is nothing to translate, and everything that
 * makes the handler safe to re-enter lives in `step`, not here.
 */

import { BotExecutorUnavailableError, type BotExecutorFn } from "./types"

export const runHandlerBot: BotExecutorFn = async (ctx) => {
  const handler = ctx.definition.handler
  if (!handler) {
    // Unavailable, not failed: the plugin is disabled or its module never
    // resolved, and retrying the same delivery will not change that.
    throw new BotExecutorUnavailableError(
      "handler",
      `Bot "${ctx.definition.id}" declares a handler its plugin did not provide`
    )
  }
  return handler(ctx)
}
