/**
 * Creating and configuring a connector instance on a paired host (ADR-0224).
 *
 * Until now a host's connectors could only be created at that host: a paired
 * device could change an existing instance's policy (`adapter_update_policy`)
 * and nothing else, so moving a Telegram bot to an always-on host meant
 * setting it up again by hand on a machine that may have no screen.
 *
 * `adapter_instance_mutate` is the host side of that move:
 *
 *   * `create` writes a whole instance under the id it had on the sending
 *     device. Keeping the id keeps every keychain entry addressable
 *     (`<id>:<credential>`), every Bot binding that names it, and every
 *     webhook path. Replaying the same operation answers the row it created;
 *     a different instance already under that id is refused, never replaced.
 *   * `configure` patches the portable fields of an instance this host runs,
 *     with the same audit breadcrumb a settings card leaves.
 *   * `remove` deletes an instance and its keychain entries: the host's half
 *     of taking a moved instance back. Removing one that is already gone is
 *     a success, so a retried take-back finishes.
 *
 * Secrets never travel here. The instance carries `credentialsRef` (names
 * only); the values go through `connectors_keyring_set`, into the host's own
 * keychain.
 *
 * What travels is decided once, field by field, below. A field nobody
 * classified fails the build, so a new column cannot leak runtime state to a
 * host, or silently stay behind.
 */

import { z } from "zod"

import {
  createAdapterInstance,
  deleteAdapterInstance,
  getAdapterInstance,
  updateAdapterConfigSection,
  updateAdapterInstance,
  type AdapterInstanceInput,
  type AdapterInstancePatch,
} from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { getDb } from "@/lib/db/schema"
import { connectorsKeyringDelete } from "@/lib/connectors/tauri/commands"
import { assertRunsHere } from "@/lib/placement/ownership"
import { isPlatformKind } from "@/types/connectors/platform-kind"

/** Configuration that means the same thing on any host. */
export const PORTABLE_ADAPTER_FIELDS = [
  "displayName",
  "enabled",
  "transportMode",
  "settings",
  "credentialsRef",
  "trigger",
  "defaultCharacterId",
  "defaultMode",
  "webhookPath",
  "quietHours",
  "muted",
  "outboundTuning",
  "replyQuoting",
  "a2uiEnabled",
  "failoverAdapterIds",
  "balanceAdapterIds",
  "atResponseStrategy",
  "inboundActivationPolicy",
  "activeRunDispatchMode",
  "activationTtlMs",
  "chatAllowlist",
  "chatBlocklist",
  "siblingBotPolicy",
  "botInterplayBudget",
  "welcomeCardEnabled",
  "helpTriggers",
  "welcomeText",
  "controlCommands",
  "defaultTeamId",
  "defaultWorkflowId",
  "defaultModel",
  "defaultProvider",
  "defaultReasoning",
  "defaultAutonomy",
  "defaultEngagement",
  "defaultAuthority",
  "builtInSkillCeiling",
  "hostCapabilityCeiling",
  "requireHitlForWrites",
  "dispatchRules",
  "presence",
  "plugin",
  "mediaModelPolicy",
  "defaultSlaResponseMinutes",
  "defaultEscalation",
] as const satisfies readonly (keyof AdapterInstanceRow)[]

/**
 * What stays behind, and why: identity and timestamps belong to the row; the
 * public URL is this machine's address; the rest is what a running adapter
 * learned about its platform, which the host's adapter learns afresh when it
 * starts, and the two ownership fields describe this machine's copy.
 */
export const LOCAL_ADAPTER_FIELDS = [
  "id",
  "type",
  "createdAt",
  "updatedAt",
  "publicUrl",
  "lastKnownCapabilities",
  "lastKnownSkillCapabilities",
  "implMetadata",
  "deliveryReadiness",
  "lastMissingScopes",
  "presenceState",
  "lastWhoamiAt",
  "lastWhoamiResult",
  "selfIdentity",
  "owner",
  "provenance",
] as const satisfies readonly (keyof AdapterInstanceRow)[]

type ClassifiedField =
  (typeof PORTABLE_ADAPTER_FIELDS)[number] | (typeof LOCAL_ADAPTER_FIELDS)[number]
// Fails to compile when `AdapterInstanceRow` gains a field neither list names.
const everyFieldClassified: Exclude<keyof AdapterInstanceRow, ClassifiedField> extends never
  ? true
  : never = true
void everyFieldClassified

export type PortableAdapterField = (typeof PORTABLE_ADAPTER_FIELDS)[number]
export type PortableAdapterInstance = Pick<AdapterInstanceRow, "type"> &
  Partial<Pick<AdapterInstanceRow, PortableAdapterField>>

/** The part of a row that may be sent to another host. */
export function portableAdapterInstance(row: AdapterInstanceRow): PortableAdapterInstance {
  const out: Record<string, unknown> = { type: row.type }
  for (const field of PORTABLE_ADAPTER_FIELDS) {
    if (row[field] !== undefined) out[field] = row[field]
  }
  return out as PortableAdapterInstance
}

/**
 * The fields `adapter_instance_mutate`'s `create` carries. Its wire contract
 * (`protocol/companion-request-schemas.json`) admits exactly these in
 * `instance` and refuses the request otherwise, so a create sends the core
 * and the rest of the portable configuration follows in a `configure`, whose
 * patch is open.
 */
export const CREATE_INSTANCE_FIELDS = [
  "displayName",
  "enabled",
  "transportMode",
  "settings",
  "credentialsRef",
  "trigger",
  "defaultMode",
] as const satisfies readonly PortableAdapterField[]

export interface InstanceCreatePayload {
  instance: Record<string, unknown>
  /** Every other portable field the row sets, or null when there is none. */
  remainder: Record<string, unknown> | null
}

/** Split a row into a `create` the wire contract admits and the `configure` that completes it. */
export function instanceCreatePayload(
  row: AdapterInstanceRow,
  overrides: { enabled?: boolean } = {}
): InstanceCreatePayload {
  const portable = { ...portableAdapterInstance(row), ...overrides } as Record<string, unknown>
  const instance: Record<string, unknown> = {
    type: row.type,
    settings: {},
    trigger: {},
  }
  for (const field of CREATE_INSTANCE_FIELDS) {
    if (portable[field] !== undefined) instance[field] = portable[field]
  }
  const remainder: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(portable)) {
    if (field === "type" || (CREATE_INSTANCE_FIELDS as readonly string[]).includes(field)) continue
    remainder[field] = value
  }
  return { instance, remainder: Object.keys(remainder).length > 0 ? remainder : null }
}

function pickPortable(
  value: Record<string, unknown>
): Partial<Record<PortableAdapterField, unknown>> {
  const out: Partial<Record<PortableAdapterField, unknown>> = {}
  for (const field of PORTABLE_ADAPTER_FIELDS) {
    if (value[field] !== undefined) out[field] = value[field]
  }
  return out
}

const id = z.string().min(1).max(256)
const TRANSPORT_MODES = [
  "longpoll",
  "webhook",
  "reverse-ws",
  "forward-ws",
  "gateway",
  "imap-smtp",
] as const
const credentialsRef = z
  .object({ keyringService: z.string().min(1), accounts: z.array(z.string().min(1)) })
  .strict()

/**
 * The core every instance needs, checked; the other portable fields are
 * structured settings the host's own forms and runtime already validate, so
 * they pass through by name only (`pickPortable`).
 */
const instanceSchema = z
  .object({
    type: z.string().min(1).max(128),
    displayName: z.string().min(1).max(200),
    enabled: z.boolean(),
    transportMode: z.enum(TRANSPORT_MODES),
    settings: z.record(z.string(), z.unknown()),
    credentialsRef,
    trigger: z.record(z.string(), z.unknown()),
    defaultMode: z.string().min(1),
  })
  .passthrough()

const patchSchema = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    transportMode: z.enum(TRANSPORT_MODES).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    credentialsRef: credentialsRef.optional(),
  })
  .passthrough()

export const adapterInstanceMutationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("create"),
      operationId: z.string().uuid(),
      id,
      instance: instanceSchema,
      sourceLabel: z.string().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("configure"),
      operationId: z.string().uuid(),
      id,
      patch: patchSchema,
    })
    .strict(),
  z.object({ operation: z.literal("remove"), operationId: z.string().uuid(), id }).strict(),
])
export type AdapterInstanceMutation = z.infer<typeof adapterInstanceMutationSchema>

/** The row as a paired device sees it: never a secret, never this host's runtime state. */
export function projectAdapterInstanceForDevice(row: AdapterInstanceRow) {
  return {
    id: row.id,
    ...portableAdapterInstance(row),
    ...(row.owner ? { owner: row.owner } : {}),
    ...(row.provenance ? { provenance: row.provenance } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Can this host build an adapter of this type? A built-in always; a
 * plugin-contributed one only when that plugin is installed here, or the row
 * would be stored to fail at every start.
 */
async function assertTypeAvailable(instance: PortableAdapterInstance): Promise<void> {
  if (isPlatformKind(instance.type)) return
  const pluginId = instance.plugin?.pluginId
  if (!pluginId) {
    throw new Error(
      `adapter_type_unavailable: "${instance.type}" is not a connector this host knows`
    )
  }
  const plugin = await getDb().plugins.get(pluginId)
  if (!plugin) {
    throw new Error(
      `adapter_type_unavailable: "${instance.type}" comes from the plugin ${pluginId}, which is not installed on this host`
    )
  }
}

/** Fields the bridge adds to every interactive request; not part of this one. */
function withoutTransportFields(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw
  const { adminLease: _lease, admin_lease: _leaseSnake, ...rest } = raw as Record<string, unknown>
  return rest
}

export async function mutateAdapterInstanceOnHost(raw: unknown) {
  const input = adapterInstanceMutationSchema.parse(withoutTransportFields(raw))
  if (input.operation === "create") {
    const instance = {
      ...pickPortable(input.instance),
      type: input.instance.type,
    } as PortableAdapterInstance
    const existing = await getAdapterInstance(input.id)
    if (existing) {
      if (existing.provenance?.operationId === input.operationId) {
        return projectAdapterInstanceForDevice(existing)
      }
      throw new Error(
        `adapter_instance_exists: this host already has a connector with id ${input.id}`
      )
    }
    await assertTypeAvailable(instance)
    const created = await createAdapterInstance(
      {
        ...(instance as AdapterInstanceInput),
        provenance: {
          kind: "migration",
          at: Date.now(),
          operationId: input.operationId,
          ...(input.sourceLabel ? { sourceLabel: input.sourceLabel } : {}),
        },
      },
      { id: input.id }
    )
    return projectAdapterInstanceForDevice(created)
  }

  if (input.operation === "remove") {
    const existing = await getAdapterInstance(input.id)
    if (!existing) return { id: input.id, removed: true }
    assertRunsHere("connector-instance", existing.owner)
    // Disabled first, so the live runtime stops the adapter before its row
    // and secrets disappear underneath it.
    await updateAdapterInstance(input.id, { enabled: false })
    await deleteAdapterInstance(input.id)
    for (const credential of existing.credentialsRef?.accounts ?? []) {
      await connectorsKeyringDelete(input.id, credential)
    }
    return { id: input.id, removed: true }
  }

  const existing = await getAdapterInstance(input.id)
  if (!existing) throw new Error(`adapter_instance_missing: no connector with id ${input.id}`)
  const patch = pickPortable(input.patch) as AdapterInstancePatch
  // `updateAdapterConfigSection` refuses a placeholder and writes the audit
  // breadcrumb a settings card writes, so a change from a paired device is as
  // visible as one made at the host.
  await updateAdapterConfigSection(input.id, "connection", patch, "paired-device")
  const updated = await getAdapterInstance(input.id)
  if (!updated) throw new Error(`adapter_instance_missing: no connector with id ${input.id}`)
  return projectAdapterInstanceForDevice(updated)
}
