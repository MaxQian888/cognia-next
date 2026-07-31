/**
 * Shared factory for command handlers that emit a `runtime` {@link CommandEffect}
 * — used by every feature-command cluster (cognia / mcp / plugin / skill).
 */
import type { CommandHandler, RuntimeRequest } from "./types"

/** A handler that emits a runtime request carrying the trimmed args (if any). */
export function rt(feature: RuntimeRequest["feature"], action: string): CommandHandler {
  return (ctx) => ({
    kind: "runtime",
    runtime: { feature, action, ...(ctx.args.trim() ? { arg: ctx.args.trim() } : {}) },
  })
}
