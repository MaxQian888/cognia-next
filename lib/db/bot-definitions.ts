/**
 * Creator-authored Bot definitions.
 *
 * A plugin's definitions are NOT here. They live in the plugin registry, come
 * and go with the plugin, and copying them into a table would create a second,
 * stale answer to "what does this Bot do". An installation records which of
 * the two worlds its definition came from, and reads accordingly.
 */

import { nanoid } from "nanoid"

import { getDb } from "@/lib/db/schema"
import type { BotDefinitionRow, LocalBotExecutor } from "@/lib/db/bot-types"
import type {
  PluginBotCompositionRequestV1,
  PluginBotPolicyV1,
  PluginBotRequirementsV1,
  PluginBotTriggerDef,
} from "@/types/plugin/plugin-bot"

export interface CreateBotDefinitionInput {
  name: string
  executor: LocalBotExecutor
  triggers: PluginBotTriggerDef[]
  id?: string
  description?: string
  version?: string
  icon?: string
  character?: string
  composition?: PluginBotCompositionRequestV1
  workflow?: string
  team?: string
  prompt?: string
  requires?: PluginBotRequirementsV1
  policy?: PluginBotPolicyV1
  configSchema?: Record<string, unknown>
  workspaceId?: string
  now?: number
}

/** The one extra field each local executor requires. */
const REQUIRED_TARGET_FIELD: Record<LocalBotExecutor, "workflow" | "team" | "prompt"> = {
  workflow: "workflow",
  squad: "team",
  "agent-turn": "prompt",
}

export class BotDefinitionError extends Error {
  constructor(
    readonly code: "target_missing" | "target_conflict" | "no_trigger" | "still_installed",
    message: string
  ) {
    super(message)
    this.name = "BotDefinitionError"
  }
}

/**
 * Refuse a definition that cannot mean one thing.
 *
 * The same three rules the manifest validator applies to a plugin's
 * definitions, because a row written through Creator reaches the same runtime
 * and a second, laxer door would be the one every bad definition uses.
 */
export function assertBotDefinitionShape(input: {
  executor: LocalBotExecutor
  workflow?: string
  team?: string
  prompt?: string
  triggers: readonly PluginBotTriggerDef[]
}): void {
  const required = REQUIRED_TARGET_FIELD[input.executor]
  const values = { workflow: input.workflow, team: input.team, prompt: input.prompt }
  if (!values[required]) {
    throw new BotDefinitionError(
      "target_missing",
      `Executor "${input.executor}" requires a "${required}" value`
    )
  }
  for (const [field, value] of Object.entries(values)) {
    if (field !== required && value) {
      throw new BotDefinitionError(
        "target_conflict",
        `Executor "${input.executor}" must not declare "${field}"`
      )
    }
  }
  if (input.triggers.length === 0) {
    throw new BotDefinitionError(
      "no_trigger",
      "A Bot needs at least one trigger, or it can never start"
    )
  }
}

export async function createBotDefinition(
  input: CreateBotDefinitionInput
): Promise<BotDefinitionRow> {
  assertBotDefinitionShape(input)
  const now = input.now ?? Date.now()
  const row: BotDefinitionRow = {
    id: input.id ?? `bot_${nanoid(12)}`,
    name: input.name,
    version: input.version ?? "0.1.0",
    executor: input.executor,
    triggers: input.triggers,
    createdAt: now,
    updatedAt: now,
    ...(input.description ? { description: input.description } : {}),
    ...(input.icon ? { icon: input.icon } : {}),
    ...(input.character ? { character: input.character } : {}),
    ...(input.composition ? { composition: input.composition } : {}),
    ...(input.workflow ? { workflow: input.workflow } : {}),
    ...(input.team ? { team: input.team } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.requires ? { requires: input.requires } : {}),
    ...(input.policy ? { policy: input.policy } : {}),
    ...(input.configSchema ? { configSchema: input.configSchema } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  }
  await getDb().botDefinitions.add(row)
  return row
}

export type BotDefinitionPatch = Partial<
  Omit<BotDefinitionRow, "id" | "createdAt" | "updatedAt">
> & { now?: number }

/**
 * Apply a patch. The shape rules are re-checked against the MERGED row, not
 * the patch, because changing the executor alone is what leaves a definition
 * pointing at a target that belongs to the executor it used to have.
 */
export async function updateBotDefinition(
  id: string,
  patch: BotDefinitionPatch
): Promise<BotDefinitionRow | undefined> {
  const db = getDb()
  const existing = await db.botDefinitions.get(id)
  if (!existing) return undefined

  const { now, ...fields } = patch
  const merged: BotDefinitionRow = { ...existing, ...fields, updatedAt: now ?? Date.now() }
  // A patch that switches executor must also clear the previous target, so
  // compare against a row with the stale targets dropped.
  if (fields.executor && fields.executor !== existing.executor) {
    for (const field of ["workflow", "team", "prompt"] as const) {
      if (fields[field] === undefined) delete merged[field]
    }
  }
  assertBotDefinitionShape(merged)
  await db.botDefinitions.put(merged)
  return merged
}

export async function getBotDefinition(id: string): Promise<BotDefinitionRow | undefined> {
  return getDb().botDefinitions.get(id)
}

/**
 * Definitions visible in a workspace: the ones it owns, plus the account-wide
 * ones. Newest first.
 */
export async function listBotDefinitions(
  options: { workspaceId?: string } = {}
): Promise<BotDefinitionRow[]> {
  const rows = await getDb().botDefinitions.toArray()
  const visible = options.workspaceId
    ? rows.filter((row) => !row.workspaceId || row.workspaceId === options.workspaceId)
    : rows
  return visible.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Delete a definition, refusing while installations still point at it.
 *
 * Cascading would silently disarm Bots somebody is relying on. The caller is
 * told how many, so it can offer to uninstall them first.
 */
export async function deleteBotDefinition(id: string): Promise<void> {
  const db = getDb()
  const installed = await db.botInstallations.where("definitionId").equals(id).count()
  if (installed > 0) {
    throw new BotDefinitionError(
      "still_installed",
      `${installed} installation${installed === 1 ? " still uses" : "s still use"} this definition`
    )
  }
  await db.botDefinitions.delete(id)
}
