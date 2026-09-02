/**
 * `ctx.commands`: the slash-command surface, for plugins whose command set is
 * only known at runtime.
 *
 * `manifest.commands[]` is the declarative path and is unchanged by this
 * module. It is the right answer when a plugin knows its commands while it is
 * being packaged. It is the wrong answer when it does not: a plugin that
 * surfaces one command per configured repository, per connected account or per
 * server-side workflow cannot write those into a manifest, and before this
 * there was no second door. The registry has always supported runtime
 * registration (`lib/slash-commands/registry.ts`) and only the plugin manager
 * could reach it.
 *
 * Namespacing, conflict handling and teardown are deliberately identical to
 * the manifest path in `lib/plugin/core/manager.ts`:
 *
 *  - ids become `<pluginId>.<id>`, so two plugins cannot collide by choosing
 *    the same short name,
 *  - aliases register as `<namespacedId>#alias:<alias>` sharing one handler,
 *  - the registry's own first-wins-across-plugins rule decides a genuine
 *    collision and reports it through `reportRegistryConflict`,
 *  - every registration is enrolled in the plugin's disposable scope, so it is
 *    removed when the plugin is disabled, uninstalled or reloaded, whether or
 *    not the plugin remembered to call the disposer it was handed.
 *
 * The custom-command half is the user's own `.claude/commands` and
 * `.cognia/commands` markdown files. It is `commands:write` and it prompts,
 * because a command file is a prompt the user later runs by name and its front
 * matter can widen the tool surface of every run of that command.
 */

import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import { getActiveWorkspaceRoot } from "@/lib/plugin/api/workspace-root"
import {
  listSlashCommands as listRegistrySlashCommands,
  registerSlashCommand as registerRegistrySlashCommand,
  unregisterSlashCommand as unregisterRegistrySlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "@/lib/slash-commands/registry"
import {
  buildCommandFile,
  assertValidCommandName,
  deleteCustomSlashCommand,
  loadCustomSlashCommands,
  projectCommandDirOf,
  saveCustomSlashCommand,
  type CustomSlashCommand,
} from "@/lib/slash-commands/custom"
import type { ProjectCommandDir } from "@/lib/slash-commands/custom-workspace"

/** What a plugin hands `registerSlashCommand`. */
export interface PluginSlashCommandInput {
  /** Short id, namespaced to `<pluginId>.<id>` by the host. */
  id: string
  /** Shown in the picker. Defaults to the short id. */
  name?: string
  description?: string
  /** Extra typeable names for the same handler. */
  aliases?: string[]
  /** Grouping bucket used by the tray and settings lists. Defaults to "plugins". */
  category?: string
  handler(
    args: string,
    context?: SlashCommandContext
  ): Promise<SlashCommandResult | void> | SlashCommandResult | void
}

/** A registry entry as a plugin may see it, with the handler removed. */
export interface PluginSlashCommandSummary {
  id: string
  name: string
  description?: string
  source?: "builtin" | "plugin"
  pluginId?: string
  category?: string
}

/** One of the user's markdown command files. */
export interface PluginCustomCommand {
  name: string
  description: string
  scope: "user" | "project"
  argumentHint?: string
  model?: string
  allowedTools?: string[]
  /** The prompt body, with its `$1..$9` / `$ARGUMENTS` placeholders intact. */
  template?: string
  /** Where the file lives. Absolute on the desktop, repo-relative otherwise. */
  filePath?: string
  /** Directory it was found in, when the host said. */
  originDir?: string
}

export interface PluginCustomCommandWriteInput {
  name: string
  /** Defaults to "project", the scope a paired browser or phone can also write. */
  scope?: "user" | "project"
  body: string
  description?: string
  argumentHint?: string
  allowedTools?: string[]
  model?: string
  /** Project directory to write into. Defaults to the file's own, then `.claude/commands`. */
  dir?: ProjectCommandDir
  /** Workspace root. Defaults to the folder the user has open. */
  cwd?: string
}

export interface PluginCommandsAPI {
  /**
   * Register a slash command for as long as this plugin is active. Returns a
   * disposer. The registration is also owned by the plugin's lifecycle scope,
   * so forgetting to call it leaks nothing.
   */
  registerSlashCommand(input: PluginSlashCommandInput): () => void
  /** Remove one of this plugin's own registrations. Ignores anything else. */
  unregisterSlashCommand(id: string): boolean
  /** Every command in the unified registry, built-in and plugin alike. */
  listSlashCommands(): PluginSlashCommandSummary[]
  /** The user's markdown command files. */
  listCustomCommands(options?: { cwd?: string }): Promise<PluginCustomCommand[]>
  getCustomCommand(
    name: string,
    options?: { cwd?: string }
  ): Promise<PluginCustomCommand | undefined>
  /** Create or overwrite a markdown command file. Prompts for consent. */
  saveCustomCommand(input: PluginCustomCommandWriteInput): Promise<{ path: string }>
  /** Delete a markdown command file. Prompts for consent. Already-gone is success. */
  deleteCustomCommand(args: {
    name: string
    scope?: "user" | "project"
    cwd?: string
    dir?: ProjectCommandDir
  }): Promise<void>
}

export interface CreateCommandsAPIDependencies {
  /**
   * Enrol a disposer in the plugin's lifecycle scope and hand back the
   * ledger-bound handle. Injected rather than resolved here so this module has
   * no opinion about how a plugin is torn down, and so a host that runs with
   * the resource ledger off still cleans up runtime registrations.
   */
  track(dispose: () => void, label: string): () => void
  /** The folder the user has open. Defaults to `getActiveWorkspaceRoot`. */
  resolveWorkspaceRoot?: () => string | undefined
}

/** `<pluginId>.<id>`, the same scheme `manifest.commands[]` uses. */
export function namespacedCommandId(pluginId: string, id: string): string {
  return `${pluginId}.${id}`
}

function normalizeAliases(input: PluginSlashCommandInput): string[] {
  const own = input.id.trim().toLowerCase()
  return [
    ...new Set(
      (input.aliases ?? [])
        .map((alias) => alias.trim().toLowerCase())
        .filter((alias) => alias.length > 0 && alias !== own)
    ),
  ]
}

function toSummary(definition: {
  id: string
  name: string
  description?: string
  source?: "builtin" | "plugin"
  pluginId?: string
  category?: string
}): PluginSlashCommandSummary {
  return {
    id: definition.id,
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.source ? { source: definition.source } : {}),
    ...(definition.pluginId ? { pluginId: definition.pluginId } : {}),
    ...(definition.category ? { category: definition.category } : {}),
  }
}

function toCustomCommand(command: CustomSlashCommand): PluginCustomCommand {
  return {
    name: command.name,
    description: command.description,
    scope: command.scope === "project" ? "project" : "user",
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    ...(command.model ? { model: command.model } : {}),
    ...(command.allowedTools ? { allowedTools: command.allowedTools } : {}),
    ...(command.template ? { template: command.template } : {}),
    ...(command.filePath ? { filePath: command.filePath } : {}),
    ...(command.originDir ? { originDir: command.originDir } : {}),
  }
}

export function createCommandsAPI(
  pluginId: string,
  deps: CreateCommandsAPIDependencies
): PluginCommandsAPI {
  const resolveRoot = deps.resolveWorkspaceRoot ?? getActiveWorkspaceRoot
  // Ids this plugin registered through THIS api, so `unregisterSlashCommand`
  // can refuse to remove a command it does not own. The registry is keyed by
  // id alone, so without this a plugin could unregister a built-in or another
  // plugin's command by naming it.
  const owned = new Map<string, string[]>()

  const readCwd = (cwd?: string): string | undefined => cwd?.trim() || resolveRoot()

  const readCommands = async (cwd?: string): Promise<PluginCustomCommand[]> => {
    const commands = await loadCustomSlashCommands(readCwd(cwd) ?? null)
    return commands.map(toCustomCommand)
  }

  const api: PluginCommandsAPI = {
    registerSlashCommand(input) {
      if (!input?.id?.trim()) throw new Error("registerSlashCommand: id is required")
      if (typeof input.handler !== "function") {
        throw new Error(`registerSlashCommand: handler for "${input.id}" must be a function`)
      }
      const shortId = input.id.trim()
      const namespacedId = namespacedCommandId(pluginId, shortId)
      const handler = async (args: string, context?: SlashCommandContext) => {
        const outcome = await input.handler(args, context)
        return outcome ?? {}
      }
      const description = input.description ?? input.name ?? shortId
      const registeredIds: string[] = []

      const accepted = registerRegistrySlashCommand({
        id: namespacedId,
        name: input.name ?? shortId,
        description,
        source: "plugin",
        pluginId,
        category: input.category ?? "plugins",
        handler,
      })
      // A rejected registration means another plugin already owns the id and
      // the registry has already reported the conflict. Registering the
      // aliases anyway would give this plugin half a command.
      if (!accepted.replaced && !isOwnedByThisPlugin(namespacedId, pluginId)) {
        return () => {}
      }
      registeredIds.push(namespacedId)

      for (const alias of normalizeAliases(input)) {
        const aliasId = `${namespacedId}#alias:${alias}`
        registerRegistrySlashCommand({
          id: aliasId,
          // The token the user types, so it must be the bare alias. See the
          // same note in `manager.ts:registerPluginSlashCommand`.
          name: alias,
          description,
          source: "plugin",
          pluginId,
          category: input.category ?? "plugins",
          handler,
        })
        if (isOwnedByThisPlugin(aliasId, pluginId)) registeredIds.push(aliasId)
      }

      owned.set(namespacedId, registeredIds)
      return deps.track(() => {
        for (const id of registeredIds) unregisterRegistrySlashCommand(id)
        owned.delete(namespacedId)
      }, `ctx.commands.registerSlashCommand:${namespacedId}`)
    },

    unregisterSlashCommand(id) {
      const namespacedId = id.startsWith(`${pluginId}.`) ? id : namespacedCommandId(pluginId, id)
      const registeredIds = owned.get(namespacedId)
      if (!registeredIds) return false
      let removed = false
      for (const registeredId of registeredIds) {
        removed = unregisterRegistrySlashCommand(registeredId) || removed
      }
      owned.delete(namespacedId)
      return removed
    },

    listSlashCommands() {
      return listRegistrySlashCommands().map(toSummary)
    },

    async listCustomCommands(options) {
      return readCommands(options?.cwd)
    },

    async getCustomCommand(name, options) {
      const commands = await readCommands(options?.cwd)
      return commands.find((command) => command.name === name)
    },

    async saveCustomCommand(input) {
      assertValidCommandName(input.name)
      const scope = input.scope ?? "project"
      const cwd = readCwd(input.cwd)
      const existing = (await readCommands(cwd)).find((command) => command.name === input.name)
      // Keep an edited command where it already lives. Writing it to the
      // default directory instead would leave two files with one name, and the
      // `.cognia` one would go on shadowing the copy the user just edited.
      const dir = input.dir ?? projectCommandDirOf(existing?.originDir)
      const path = await saveCustomSlashCommand({
        scope,
        name: input.name,
        cwd: cwd ?? null,
        dir,
        body: input.body,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.argumentHint !== undefined ? { argumentHint: input.argumentHint } : {}),
        ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
      })
      return { path }
    },

    async deleteCustomCommand(args) {
      assertValidCommandName(args.name)
      const cwd = readCwd(args.cwd)
      const existing = (await readCommands(cwd)).find((command) => command.name === args.name)
      await deleteCustomSlashCommand({
        scope: args.scope ?? (existing?.scope === "user" ? "user" : "project"),
        name: args.name,
        cwd: cwd ?? null,
        dir: args.dir ?? projectCommandDirOf(existing?.originDir),
      })
    },
  }

  return createGuardedAPI(
    pluginId,
    api,
    {
      registerSlashCommand: "commands:write",
      unregisterSlashCommand: "commands:write",
      listSlashCommands: "commands:read",
      listCustomCommands: "commands:read",
      getCustomCommand: "commands:read",
      saveCustomCommand: "commands:write",
      deleteCustomCommand: "commands:write",
    },
    {
      // `commands:write` is a dangerous permission, so it sits at the "confirm"
      // tier and every method taking it would otherwise raise a consent overlay.
      // These two touch no disk, are undone on unload, and run inside
      // `activate()`, where a modal would stall the enable and there is no user
      // gesture to attach it to. The disk writes below are the consent-worthy
      // half and they do prompt.
      consentExempt: ["registerSlashCommand", "unregisterSlashCommand"],
    }
  )
}

/** Did the registry accept `id` for this plugin, or is an incumbent holding it? */
function isOwnedByThisPlugin(id: string, pluginId: string): boolean {
  return listRegistrySlashCommands().some(
    (definition) => definition.id === id && definition.pluginId === pluginId
  )
}

/** The prompt body a `saveCustomCommand` call would write. Exposed for previews. */
export { buildCommandFile as buildCustomCommandFile }
