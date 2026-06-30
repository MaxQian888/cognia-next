// Adapter: project plugin-contributed slash commands (registered in the unified
// `registry.ts` as `SlashCommandDefinition`) into the `SlashCommand` shape the
// chat composer's `/` picker + submit pipeline understand.
//
// Why an adapter: the two handler signatures are incompatible. The registry's
// handler is `(args, ctx?) => Promise<{message?}>`; the composer's is
// `(ctx: SlashContext) => void` whose output is surfaced via
// `ctx.pushSystemMessage`. We wrap the registry handler so picking/running a
// plugin command in the composer runs it through `dispatchSlashCommand` (which
// preserves lazy `onCommand:<id>` plugin activation) and pushes any returned
// message into the chat.

import type { SlashCommand, SlashContext } from "./builtin"
import { dispatchSlashCommand, listSlashCommands, type SlashCommandDefinition } from "./registry"

/** Build the composer-side action handler for one plugin command def. */
function makePluginHandler(def: SlashCommandDefinition): (ctx: SlashContext) => Promise<void> {
  return async (ctx: SlashContext) => {
    const line = `/${def.id}${ctx.args ? ` ${ctx.args}` : ""}`
    const res = await dispatchSlashCommand(line, {
      sessionId: ctx.activeSessionId ?? undefined,
    })
    if (res?.message) ctx.pushSystemMessage(res.message)
  }
}

/**
 * Map plugin-source registry definitions to composer `SlashCommand`s. ONLY
 * `source === "plugin"` entries are mapped — builtins self-seed into the
 * registry (`seedBuiltinSlashCommands`) and are already present in the
 * composer via `BUILTIN_SLASH_COMMANDS`, so including them would duplicate
 * every builtin.
 */
export function pluginSlashCommandsToSlashCommands(
  defs: readonly SlashCommandDefinition[]
): SlashCommand[] {
  return defs
    .filter((def) => def.source === "plugin")
    .map((def) => ({
      name: def.id,
      description: def.description ?? "",
      scope: "plugin" as const,
      category: def.category ?? "plugins",
      argumentHint: def.shortcut ?? undefined,
      handler: makePluginHandler(def),
    }))
}

/** Convenience snapshot for non-reactive callers (tests, submit-time map). */
export function getPluginSlashCommands(): SlashCommand[] {
  return pluginSlashCommandsToSlashCommands(listSlashCommands())
}
