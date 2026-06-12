/**
 * Pure builder for `/compact`.
 *
 * Manual compaction works on BOTH dispatch paths — it is a control message the
 * sidecar host routes to the live session's `requestCompact` (the generic
 * AI-SDK session summarizes older turns now; the Anthropic Agent SDK pushes a
 * `/compact` turn it intercepts). The App turns this `compact` effect into
 * `agent.compact(focus)`, which sends the control message and renders the
 * resulting `compact_boundary`. The optional argument is the compact-focus
 * instruction (Claude Code's `# Compact instructions` parity), e.g.
 * `/compact keep the file paths`.
 */
import type { CommandContext, CommandEffect } from "./types"

export function buildCompactEffect(ctx: CommandContext): CommandEffect {
  const focus = ctx.args.trim()
  return { kind: "compact", focus: focus || undefined }
}
