/**
 * `/vim` — toggle the composer's vim editing mode (Claude Code parity).
 *
 * `/vim` (bare) toggles; `/vim on|off` sets explicitly. The flag is persisted
 * to config.json and live-merged, so the composer switches modal editing on
 * immediately. See `input/vim.ts` for the supported motion/operator subset.
 */
import type { CommandDescriptor, CommandEffect } from "./types"

function set(value: boolean): CommandEffect {
  return { kind: "flag", key: "vim", value }
}

export const vimCommand: CommandDescriptor = {
  name: "vim",
  description: "toggle vim editing mode in the composer",
  category: "config",
  argumentHint: "[on|off]",
  handler: (ctx) => {
    const arg = ctx.args.trim().toLowerCase()
    if (arg === "on" || arg === "true" || arg === "enable") return set(true)
    if (arg === "off" || arg === "false" || arg === "disable") return set(false)
    if (arg === "") return set(ctx.config.vim !== true)
    return { kind: "notice", message: "Usage: /vim [on|off]" }
  },
}
