/**
 * Read an installation back as the thing the runtime needs: a definition, a
 * resolved policy ceiling, and (for a handler Bot) the function to call.
 *
 * The two definition worlds are joined here and nowhere else. A plugin's
 * definitions live in the registry and come and go with the plugin. A person's
 * live in `botDefinitions`. Every caller that had to know which was which
 * would be a place the two could drift.
 */

import { getBotDefinition } from "@/lib/db/bot-definitions"
import type { BotInstallationRow } from "@/lib/db/bot-types"
import { getBot } from "@/lib/plugin/registries/bot-registry"
import { resolveBotPolicy, type BotPolicyLayer } from "@/lib/bot/policy/ceilings"
import type { BotHandlerV1 } from "@/types/bot/run"
import type {
  PluginBotCompositionRequestV1,
  PluginBotExecutor,
  PluginBotPolicyV1,
  PluginBotRequirementsV1,
  PluginBotTriggerDef,
} from "@/types/plugin/plugin-bot"

/** One definition shape, whichever world it came from. */
export interface ResolvedBotDefinition {
  id: string
  name: string
  version: string
  executor: PluginBotExecutor
  triggers: PluginBotTriggerDef[]
  source: "plugin" | "local"
  description?: string
  character?: string
  composition?: PluginBotCompositionRequestV1
  workflow?: string
  team?: string
  prompt?: string
  requires?: PluginBotRequirementsV1
  policy?: PluginBotPolicyV1
  configSchema?: Record<string, unknown>
  /** Present only for a plugin `handler` Bot whose module resolved. */
  handler?: BotHandlerV1
}

export type BotResolutionProblem =
  /** The plugin is disabled or uninstalled, so its definitions are gone. */
  | { kind: "definition_missing"; definitionId: string }
  /**
   * The definition exists but at a different version than the installation
   * pinned. The Bot still runs, on the version that exists, because refusing
   * would silently stop a Bot after an ordinary plugin update. The drift is
   * reported so a user can see what changed under them.
   */
  | { kind: "version_drift"; pinned: string; available: string }
  /** A `handler` executor whose module never resolved. */
  | { kind: "handler_missing"; definitionId: string }

export interface InstalledBot {
  installation: BotInstallationRow
  definition: ResolvedBotDefinition
  /** The intersected ceiling. Never a grant. */
  policy: PluginBotPolicyV1
  problems: BotResolutionProblem[]
}

export interface ResolveInstalledBotOptions {
  /** Ceiling the organisation imposes on every Bot, outermost layer. */
  organizationPolicy?: PluginBotPolicyV1
  /** Ceiling the owning plugin's grants impose. */
  pluginPolicy?: PluginBotPolicyV1
  /** Ceiling this particular run asked for. */
  requestPolicy?: PluginBotPolicyV1
}

/**
 * Resolve one installation, or `null` when its definition is gone entirely.
 *
 * `null` and a `problems` entry are different answers on purpose: a missing
 * definition means there is nothing to run at all, while every other problem
 * still leaves something a user can look at.
 */
export async function resolveInstalledBot(
  installation: BotInstallationRow,
  options: ResolveInstalledBotOptions = {}
): Promise<InstalledBot | null> {
  const problems: BotResolutionProblem[] = []
  const definition =
    installation.definitionSource === "plugin"
      ? resolvePluginDefinition(installation)
      : await resolveLocalDefinition(installation)

  if (!definition) return null

  if (definition.version !== installation.pinnedVersion) {
    problems.push({
      kind: "version_drift",
      pinned: installation.pinnedVersion,
      available: definition.version,
    })
  }
  if (definition.executor === "handler" && !definition.handler) {
    problems.push({ kind: "handler_missing", definitionId: definition.id })
  }

  const layers: BotPolicyLayer[] = [
    { name: "organization", policy: options.organizationPolicy },
    { name: "plugin", policy: options.pluginPolicy },
    { name: "definition", policy: definition.policy },
    { name: "installation", policy: installation.policyGrant },
    { name: "request", policy: options.requestPolicy },
  ]

  return {
    installation,
    definition,
    policy: resolveBotPolicy(layers).policy,
    problems,
  }
}

function resolvePluginDefinition(installation: BotInstallationRow): ResolvedBotDefinition | null {
  const registered = getBot(installation.definitionId)
  if (!registered) return null
  const def = registered.definition
  return {
    id: registered.id,
    name: def.name,
    version: def.version,
    executor: def.executor,
    triggers: def.triggers,
    source: "plugin",
    ...(def.description ? { description: def.description } : {}),
    ...(def.character ? { character: def.character } : {}),
    ...(def.composition ? { composition: def.composition } : {}),
    ...(def.executor === "workflow" ? { workflow: def.workflow } : {}),
    ...(def.executor === "squad" ? { team: def.team } : {}),
    ...(def.executor === "agent-turn" ? { prompt: def.prompt } : {}),
    ...(def.requires ? { requires: def.requires } : {}),
    ...(def.policy ? { policy: def.policy } : {}),
    ...(def.configSchema ? { configSchema: def.configSchema } : {}),
    ...(registered.handler ? { handler: registered.handler } : {}),
  }
}

async function resolveLocalDefinition(
  installation: BotInstallationRow
): Promise<ResolvedBotDefinition | null> {
  const row = await getBotDefinition(installation.definitionId)
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    executor: row.executor,
    triggers: row.triggers,
    source: "local",
    ...(row.description ? { description: row.description } : {}),
    ...(row.character ? { character: row.character } : {}),
    ...(row.composition ? { composition: row.composition } : {}),
    ...(row.workflow ? { workflow: row.workflow } : {}),
    ...(row.team ? { team: row.team } : {}),
    ...(row.prompt ? { prompt: row.prompt } : {}),
    ...(row.requires ? { requires: row.requires } : {}),
    ...(row.policy ? { policy: row.policy } : {}),
    ...(row.configSchema ? { configSchema: row.configSchema } : {}),
  }
}

/** Can this resolution actually run, or only be looked at? */
export function isRunnableBot(resolved: InstalledBot): boolean {
  if (resolved.installation.status !== "enabled") return false
  return !resolved.problems.some((problem) => problem.kind === "handler_missing")
}
