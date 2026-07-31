/**
 * `/agent-mode` — switch the active agent mode (built-in or custom), the CLI
 * counterpart of the desktop's mode dropdown.
 *
 *   /agent-mode                open the mode picker (built-in + custom)
 *   /agent-mode <id>           switch to a mode by id (e.g. plan, build, code-gen)
 *   /agent-mode none|off       clear the mode → plain chat (the `general` mode)
 *
 * A mode's system prompt, tool allow-list, model override, and permission
 * ruleset are applied by the SHARED `resolveSendOptions` (it reads the resolved
 * `AgentModeConfig` from `BuildOptionsContext.agentMode`) — no CLI-specific
 * behaviour. The bare form routes to the runtime controller so the picker can
 * enumerate disk custom modes; an explicit id returns an `agentMode` effect the
 * App persists + applies on the next turn. Pure handler.
 */
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

/** Words that clear the active mode (maps to the no-op built-in `general`). */
const CLEAR_WORDS = new Set(["none", "off", "clear", "default"])

function handle(ctx: CommandContext): CommandEffect {
  const value = ctx.args.trim()
  if (!value) {
    // Disk-backed list → runtime controller (a pure handler can't read fs).
    return { kind: "runtime", runtime: { feature: "agentMode", action: "list" } }
  }
  const modeId = CLEAR_WORDS.has(value.toLowerCase()) ? "general" : value
  return { kind: "agentMode", modeId }
}

export const agentModeCommand: CommandDescriptor = {
  name: "agent-mode",
  aliases: ["agentmode"],
  description: "switch the agent mode (plan / build / code-gen / custom …)",
  category: "config",
  argumentHint: "[<id> | none]",
  handler: handle,
}
