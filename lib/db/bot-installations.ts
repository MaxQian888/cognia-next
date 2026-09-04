/**
 * Bot installations: "this Bot, here, as this identity, with these
 * credentials, under this ceiling".
 *
 * The row deliberately never stores a secret. A credential slot binds to an
 * integration account id and an auth session id, and the Integration action
 * broker resolves the actual credential at call time without the Bot, its
 * handler, or this table ever seeing it.
 */

import { nanoid } from "nanoid"

import { getDb } from "@/lib/db/schema"
import type {
  BotCredentialBinding,
  BotDefinitionSource,
  BotInstallationRow,
  BotInstallationScope,
  BotInstallationStatus,
  BotTriggerRuntimeState,
} from "@/lib/db/bot-types"
import type { PluginBotCredentialSlot, PluginBotPolicyV1 } from "@/types/plugin/plugin-bot"

export interface InstallBotInput {
  definitionId: string
  definitionSource: BotDefinitionSource
  pinnedVersion: string
  scope: BotInstallationScope
  id?: string
  config?: Record<string, unknown>
  credentialBindings?: Record<string, BotCredentialBinding>
  triggerOverrides?: Record<string, boolean>
  policyGrant?: PluginBotPolicyV1
  placementRef?: string
  /** Slots the definition requires, so the initial status is honest. */
  requiredCredentials?: readonly PluginBotCredentialSlot[]
  now?: number
}

/**
 * Which required credential slots are still unbound.
 *
 * A binding counts only when it names something the broker can resolve. An
 * empty object under a slot id is what a half-finished setup wizard leaves
 * behind, and treating it as bound is how an installation arms itself into a
 * guaranteed failure at the first external call.
 */
export function unboundCredentialSlots(
  required: readonly PluginBotCredentialSlot[] | undefined,
  bindings: Record<string, BotCredentialBinding> | undefined
): string[] {
  if (!required || required.length === 0) return []
  return required
    .filter((slot) => {
      if (slot.optional) return false
      const binding = bindings?.[slot.id]
      return !binding?.integrationAccountId && !binding?.authSessionId
    })
    .map((slot) => slot.id)
}

/**
 * The status an installation should carry.
 *
 * `needs_setup` outranks a requested `enabled`: an installation missing a
 * credential cannot run, and saying "enabled" would put the failure at the
 * first external call instead of on the row the user is looking at.
 * A deliberate `disabled` outranks everything, because turning something off
 * is an answer, not a gap.
 */
export function resolveInstallationStatus(input: {
  requested: BotInstallationStatus
  requiredCredentials?: readonly PluginBotCredentialSlot[]
  credentialBindings?: Record<string, BotCredentialBinding>
}): BotInstallationStatus {
  if (input.requested === "disabled") return "disabled"
  return unboundCredentialSlots(input.requiredCredentials, input.credentialBindings).length > 0
    ? "needs_setup"
    : "enabled"
}

export async function installBot(input: InstallBotInput): Promise<BotInstallationRow> {
  const now = input.now ?? Date.now()
  const credentialBindings = input.credentialBindings ?? {}
  const row: BotInstallationRow = {
    id: input.id ?? `boti_${nanoid(12)}`,
    definitionId: input.definitionId,
    definitionSource: input.definitionSource,
    pinnedVersion: input.pinnedVersion,
    scope: input.scope,
    status: resolveInstallationStatus({
      requested: "enabled",
      requiredCredentials: input.requiredCredentials,
      credentialBindings,
    }),
    config: input.config ?? {},
    credentialBindings,
    createdAt: now,
    updatedAt: now,
    ...(input.scope.workspaceId ? { workspaceId: input.scope.workspaceId } : {}),
    ...(input.scope.projectId ? { projectId: input.scope.projectId } : {}),
    ...(input.triggerOverrides ? { triggerOverrides: input.triggerOverrides } : {}),
    ...(input.policyGrant ? { policyGrant: input.policyGrant } : {}),
    ...(input.placementRef ? { placementRef: input.placementRef } : {}),
  }
  await getDb().botInstallations.add(row)
  return row
}

export type BotInstallationPatch = Partial<
  Omit<BotInstallationRow, "id" | "createdAt" | "updatedAt" | "workspaceId" | "projectId">
> & {
  /** Re-evaluated against the merged row when bindings or status change. */
  requiredCredentials?: readonly PluginBotCredentialSlot[]
  now?: number
}

export async function updateBotInstallation(
  id: string,
  patch: BotInstallationPatch
): Promise<BotInstallationRow | undefined> {
  const db = getDb()
  const existing = await db.botInstallations.get(id)
  if (!existing) return undefined

  const { now, requiredCredentials, ...fields } = patch
  const merged: BotInstallationRow = { ...existing, ...fields, updatedAt: now ?? Date.now() }
  if (fields.scope) {
    // The denormalized copies exist only so the index can answer per-workspace
    // queries. Letting them drift from `scope` would hide an installation from
    // the workspace that owns it.
    delete merged.workspaceId
    delete merged.projectId
    if (fields.scope.workspaceId) merged.workspaceId = fields.scope.workspaceId
    if (fields.scope.projectId) merged.projectId = fields.scope.projectId
  }
  if (requiredCredentials || fields.credentialBindings || fields.status) {
    merged.status = resolveInstallationStatus({
      requested: merged.status,
      requiredCredentials,
      credentialBindings: merged.credentialBindings,
    })
  }
  await db.botInstallations.put(merged)
  return merged
}

export async function getBotInstallation(id: string): Promise<BotInstallationRow | undefined> {
  return getDb().botInstallations.get(id)
}

export interface ListBotInstallationsQuery {
  definitionId?: string
  status?: BotInstallationStatus
  workspaceId?: string
  projectId?: string
}

/**
 * Installations matching a query, newest first.
 *
 * A workspace query returns the workspace's own installations PLUS the
 * account-wide ones, because an account-scoped Bot is armed everywhere and
 * omitting it would tell a user it is not running when it is.
 */
export async function listBotInstallations(
  query: ListBotInstallationsQuery = {}
): Promise<BotInstallationRow[]> {
  const rows = await getDb().botInstallations.toArray()
  return rows
    .filter((row) => {
      if (query.definitionId && row.definitionId !== query.definitionId) return false
      if (query.status && row.status !== query.status) return false
      if (query.projectId && row.projectId && row.projectId !== query.projectId) return false
      if (query.workspaceId && row.workspaceId && row.workspaceId !== query.workspaceId) {
        return false
      }
      return true
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function uninstallBot(id: string): Promise<void> {
  await getDb().botInstallations.delete(id)
}

/**
 * Is this trigger armed for this installation?
 *
 * The override wins when present. Otherwise the definition's own default
 * applies, and a definition that says nothing means armed: a trigger that
 * writes to the outside world is expected to ship `enabledByDefault: false`
 * rather than relying on the reader to be cautious.
 */
export function isBotTriggerArmed(
  installation: Pick<BotInstallationRow, "triggerOverrides">,
  trigger: { id: string; enabledByDefault?: boolean }
): boolean {
  const override = installation.triggerOverrides?.[trigger.id]
  if (typeof override === "boolean") return override
  return trigger.enabledByDefault !== false
}

/**
 * Merge one trigger's runtime state.
 *
 * Read-modify-write inside a transaction: a poll cursor and a debounce window
 * are written from different callers, and a whole-row put outside a
 * transaction is how one of them silently reverts the other.
 */
export async function writeBotTriggerState(
  installationId: string,
  triggerId: string,
  patch: Partial<BotTriggerRuntimeState>,
  now = Date.now()
): Promise<BotTriggerRuntimeState | undefined> {
  const db = getDb()
  return db.transaction("rw", db.botInstallations, async () => {
    const row = await db.botInstallations.get(installationId)
    if (!row) return undefined
    const next: BotTriggerRuntimeState = { ...(row.triggerState?.[triggerId] ?? {}), ...patch }
    await db.botInstallations.put({
      ...row,
      triggerState: { ...(row.triggerState ?? {}), [triggerId]: next },
      updatedAt: now,
    })
    return next
  })
}

export async function readBotTriggerState(
  installationId: string,
  triggerId: string
): Promise<BotTriggerRuntimeState | undefined> {
  const row = await getDb().botInstallations.get(installationId)
  return row?.triggerState?.[triggerId]
}
