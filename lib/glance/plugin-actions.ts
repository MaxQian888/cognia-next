/**
 * Running a plugin module's action (ADR-0225 §6).
 *
 * A glance consumer names an action by its module entry and the action's id.
 * The command it runs is looked up here, in what the plugin last published
 * for that module, and is always the plugin's own (`<pluginId>.<command>`):
 * a consumer cannot run anything the plugin did not offer, nor another
 * plugin's or the app's commands.
 *
 * Plugin commands live in three places. Manifest commands are registered in
 * the plugin manager's registry; `ctx.commands.registerSlashCommand` puts a
 * runtime command in the slash-command registry (stamped with its plugin);
 * a command may also sit on the app's command bus. They are tried in that
 * order. A slash command runs with no arguments and no chat session, like a
 * palette invocation.
 */

import { parsePluginEntryId, type GlancePluginEntryId } from "@/types/glance/layout"

import { glancePluginCommandId } from "./plugin-data"
import { glancePluginModules, type GlancePluginModuleRegistry } from "./plugin-registry"

/**
 * Run a plugin command by its full id. Resolves false when no such command
 * exists. With `ownerPluginId`, a slash command counts only when that plugin
 * registered it.
 */
export async function runPluginCommand(
  commandId: string,
  ownerPluginId?: string
): Promise<boolean> {
  const { getPluginManager } = await import("@/lib/plugin/core/manager")
  let manifestCommand: { execute: () => void | Promise<void> } | undefined
  try {
    manifestCommand = getPluginManager().getRegistry().getCommand(commandId)
  } catch {
    // No plugin manager in this window: nothing a plugin registered can run.
    manifestCommand = undefined
  }
  if (manifestCommand) {
    await manifestCommand.execute()
    return true
  }
  const { getSlashCommand } = await import("@/lib/slash-commands/registry")
  const slash = getSlashCommand(commandId)
  if (
    slash &&
    slash.source === "plugin" &&
    (ownerPluginId === undefined || slash.pluginId === ownerPluginId)
  ) {
    await slash.handler("")
    return true
  }
  const bus = await import("@/lib/plugin/commands/registry")
  if (!bus.getCommand(commandId)) return false
  await bus.executeCommand(commandId)
  return true
}

export interface GlancePluginActionDeps {
  registry?: GlancePluginModuleRegistry
  runCommand?: (commandId: string, ownerPluginId: string) => Promise<boolean>
}

/**
 * Run one action. Resolves to null on success, or the `glance.errors.*` key
 * the consumer shows: the module is gone (`pluginUnavailable`), the action or
 * its command is (`commandUnavailable`), or the command failed
 * (`requestFailed`).
 */
export async function runGlancePluginAction(
  entryId: GlancePluginEntryId,
  actionId: string,
  { registry = glancePluginModules, runCommand = runPluginCommand }: GlancePluginActionDeps = {}
): Promise<string | null> {
  const parsed = parsePluginEntryId(entryId)
  if (!parsed || !registry.get(entryId)) return "errors.pluginUnavailable"
  const action = registry.dataOf(entryId)?.data.actions?.find((a) => a.id === actionId)
  if (!action) return "errors.commandUnavailable"
  try {
    const ran = await runCommand(
      glancePluginCommandId(parsed.pluginId, action.command),
      parsed.pluginId
    )
    return ran ? null : "errors.commandUnavailable"
  } catch {
    return "errors.requestFailed"
  }
}
