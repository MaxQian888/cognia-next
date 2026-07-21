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
/**
 * The token a user actually types for a plugin command.
 *
 * This used to be `def.id` verbatim, which made every declared `name` inert:
 * a plugin registering `{ id: "screenshot.capture", name: "/screenshot" }` was
 * only reachable as `/screenshot.capture`, and a manifest-declared command
 * (which the manager namespaces to `<pluginId>.<commandId>`) would have been
 * reachable only as `/cognia-screenshot.screenshot`. `makePluginHandler`
 * dispatches by `def.id` internally, so the projected name is free to be the
 * friendly one — the id still does the resolving.
 */
export function slashCommandToken(def: SlashCommandDefinition): string {
  const declared = def.name?.trim().replace(/^\/+/, "") ?? ""
  // A name with whitespace isn't typeable as a single `/token`, so fall back.
  return declared.length > 0 && !/\s/.test(declared) ? declared : def.id
}

export function pluginSlashCommandsToSlashCommands(
  defs: readonly SlashCommandDefinition[]
): SlashCommand[] {
  // First-wins on a colliding token, mirroring the registry's own conflict
  // policy. The loser keeps its (unique) id as the token so it stays reachable
  // rather than silently vanishing from the picker's name-keyed map.
  const taken = new Set<string>()
  return defs
    .filter((def) => def.source === "plugin")
    .map((def) => {
      const preferred = slashCommandToken(def)
      const name = taken.has(preferred) ? def.id : preferred
      taken.add(name)
      return { def, name }
    })
    .map(({ def, name }) => ({
      name,
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
