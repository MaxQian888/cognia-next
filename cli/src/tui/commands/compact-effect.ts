/**
 * Pure builder for `/compact`.
 *
 * On the Anthropic provider, compaction is a manual user-driven action: the
 * Claude Agent SDK intercepts a literal `/compact` user message, summarizes the
 * transcript, and emits a `compact_boundary` (matching the desktop's
 * `lib/slash-commands/builtin.ts` `/compact` template). On every other provider
 * compaction happens automatically in-stream inside the sidecar when the context
 * window fills, so sending `/compact` would only post a confusing no-op user
 * message — we explain that instead.
 */
import type { CommandContext, CommandEffect } from "./types"

export function buildCompactEffect(ctx: CommandContext): CommandEffect {
  if (ctx.config.provider !== "anthropic") {
    return {
      kind: "notice",
      message:
        "Compaction runs automatically for this provider once the context window fills. " +
        "Manual /compact is only available on the Anthropic provider.",
    }
  }
  const focus = ctx.args.trim()
  return { kind: "send", prompt: focus ? `/compact ${focus}` : "/compact" }
}
