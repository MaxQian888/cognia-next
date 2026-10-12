/**
 * The three kinds of always-on work, each as one adapter the migration
 * service drives the same way (ADR-0224).
 *
 * Every move follows one order, so a crash at any point leaves at most one
 * running copy and the journal knows which step to resume from:
 *
 *   1. **create** the item on the host, not running (task paused, Bot and
 *      connector disabled), keyed by the operation so a resend is a no-op;
 *   2. **confirm** the host holds it;
 *   3. **fence** this machine's copy into a disabled placeholder;
 *   4. **arm** the host's copy, if it was running here.
 *
 * Fencing before arming is deliberate: between 3 and 4 nothing runs, which a
 * schedule absorbs as one late slot, whereas the opposite order would run the
 * item twice. A take-back reverses it: remove the host's copy, then restore
 * this one.
 */

import { allRootPaths } from "@/lib/workspace/roots"
import { isPathUnderRoot } from "@/lib/sandbox/policy-bridge"
import {
  CODE_SUPPLY_HOST_OPERATIONS,
  supportsHostFeatureOperation,
} from "@/lib/platform/host-feature-manifest"
import { canTransferProject, transferredProject } from "@/lib/workspace/project-transfer"
import type { Project } from "@/types"
import type { ItemMigrationCompanion } from "@/lib/db/item-migrations"
import { runsHere } from "@/lib/placement/ownership"
import { getTaskTypeHostSupport } from "@/lib/scheduler/host-support"
import { getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { BotInstallationRow } from "@/lib/db/bot-types"
import {
  classifyBotInstallation,
  classifyConnectorInstance,
  classifyScheduledTask,
  describeRemoteSchedulerHost,
  type MachineBoundVerdict,
} from "@/lib/placement/machine-bound"
import type { Platform } from "@/lib/platform/detect"
import type { Transport } from "@/lib/tauri/transport-types"
import type { ItemOwner, OwnedItemKind } from "@/types/placement/item-owner"
import type { ScheduledTask, ScheduledTaskStatus } from "@/types/scheduler"

import type { HostFacts } from "./host-facts"
import type { MigrationBlocker, MigrationItemRef, MigrationNote } from "./types"

export interface LoadedScheduledTask {
  kind: "scheduled-task"
  id: string
  label: string
  owner?: ItemOwner
  localStatus: string
  task: ScheduledTask
}

export interface LoadedBotInstallation {
  kind: "bot-installation"
  id: string
  label: string
  owner?: ItemOwner
  localStatus: string
  installation: BotInstallationRow
  /** The definition's catalog entry here, when it still resolves. */
  entry?: import("@/lib/bot/console/catalog").BotCatalogEntry
}

export interface LoadedConnectorInstance {
  kind: "connector-instance"
  id: string
  label: string
  owner?: ItemOwner
  localStatus: string
  row: AdapterInstanceRow
  /**
   * The scheduled messages set up in its chats (`/schedule`) that run here.
   * They send through this instance, so they move with it.
   */
  schedules: ScheduledTask[]
}

export type LoadedItem = LoadedScheduledTask | LoadedBotInstallation | LoadedConnectorInstance

export interface ItemChecks {
  blockers: MigrationBlocker[]
  notes: MigrationNote[]
  plugins: { pluginId: string; version: string }[]
}

export interface TransferContext {
  transport: Pick<Transport, "call">
  adminLease: string
  operationId: string
  /** How this device names itself to the host, recorded as provenance. */
  sourceLabel: string
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function loadItem(ref: MigrationItemRef): Promise<LoadedItem | undefined> {
  if (ref.kind === "scheduled-task") {
    const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
    const task = await getTaskScheduler().getTask(ref.id)
    if (!task) return undefined
    return {
      kind: ref.kind,
      id: task.id,
      label: task.name,
      ...(task.owner ? { owner: task.owner } : {}),
      localStatus: task.status,
      task,
    }
  }
  if (ref.kind === "bot-installation") {
    const [{ getBotInstallation }, { readHostBotCatalog }] = await Promise.all([
      import("@/lib/db/bot-installations"),
      import("@/lib/bot/control-writes/lifecycle-host"),
    ])
    const installation = await getBotInstallation(ref.id)
    if (!installation) return undefined
    const entry = (await readHostBotCatalog()).find(
      (candidate) => candidate.definitionId === installation.definitionId
    )
    return {
      kind: ref.kind,
      id: installation.id,
      label: entry?.name ?? installation.definitionId,
      ...(installation.owner ? { owner: installation.owner } : {}),
      localStatus: installation.status,
      installation,
      ...(entry ? { entry } : {}),
    }
  }
  const [{ getAdapterInstance }, { getTaskScheduler }] = await Promise.all([
    import("@/lib/db/adapter-instances"),
    import("@/lib/scheduler/task-scheduler"),
  ])
  const row = await getAdapterInstance(ref.id)
  if (!row) return undefined
  return {
    kind: ref.kind,
    id: row.id,
    label: row.displayName,
    ...(row.owner ? { owner: row.owner } : {}),
    localStatus: row.enabled ? "enabled" : "disabled",
    row,
    schedules: connectorSchedules(await getTaskScheduler().getAllTasks(), row.id),
  }
}

/** The connector's chat schedules among `tasks` that run on this machine. */
export function connectorSchedules(
  tasks: readonly ScheduledTask[],
  adapterId: string
): ScheduledTask[] {
  return tasks.filter(
    (task) =>
      task.type === "connection:scheduled:digest" &&
      (task.payload as { adapterId?: unknown } | undefined)?.adapterId === adapterId &&
      runsHere(task.owner)
  )
}

/** What moves with an item, frozen into its journal row when the move starts. */
export function companionsOf(item: LoadedItem): ItemMigrationCompanion[] {
  if (item.kind !== "connector-instance") return []
  return item.schedules.map((task) => ({
    kind: "scheduled-task",
    id: task.id,
    label: task.name,
    localStatus: task.status,
  }))
}

/** The id the item has on the host once moved. */
export function remoteItemIdFor(item: LoadedItem, operationId: string): string {
  // A Bot installation is keyed by the operation on the host
  // (`lifecycle-host.ts`); the other two keep their ids, which is what keeps
  // keychain entries, Bot bindings and task chains addressable.
  return item.kind === "bot-installation" ? `boti_${operationId}` : item.id
}

// ---------------------------------------------------------------------------
// Preflight checks
// ---------------------------------------------------------------------------

async function localPluginVersion(pluginId: string): Promise<string> {
  return (await getDb().plugins.get(pluginId))?.version ?? ""
}

async function pluginChecks(
  required: readonly string[],
  facts: HostFacts
): Promise<Pick<ItemChecks, "blockers" | "plugins">> {
  const blockers: MigrationBlocker[] = []
  const plugins: ItemChecks["plugins"] = []
  if (required.length === 0) return { blockers, plugins }
  const onHost = await facts.plugins()
  for (const pluginId of [...new Set(required)]) {
    const version = await localPluginVersion(pluginId)
    plugins.push({ pluginId, version })
    const hostVersion = onHost.get(pluginId)
    if (hostVersion === undefined) blockers.push({ kind: "plugin-missing", pluginId, version })
    else if (version && hostVersion !== version) {
      blockers.push({ kind: "plugin-version-mismatch", pluginId, version, hostVersion })
    }
  }
  return { blockers, plugins }
}

function machineBoundBlockers(verdict: MachineBoundVerdict): MigrationBlocker[] {
  return verdict.reasons.map((reason) => ({ kind: "machine-bound", reason }))
}

/** This machine's workspaces an item names, looked up once per check. */
interface WorkspaceLookup {
  /** Folders that bind an item here: none for a workspace that travels. */
  projectRoots(projectId: string): readonly string[]
  /** A path inside a workspace that travels with its repository. */
  portablePath(path: string): boolean
  /** The workspaces among them that travel (ADR-0224 A11). */
  travelling: Project[]
}

async function workspaceLookup(
  projectIds: readonly (string | undefined)[]
): Promise<WorkspaceLookup> {
  const projects = new Map<string, Project | undefined>()
  for (const projectId of projectIds) {
    if (!projectId || projects.has(projectId)) continue
    projects.set(projectId, await getDb().projects.get(projectId))
  }
  const travelling = [...projects.values()].filter((project): project is Project =>
    canTransferProject(project)
  )
  return {
    projectRoots: (projectId) => {
      const project = projects.get(projectId)
      return project && !canTransferProject(project) ? allRootPaths(project) : []
    },
    portablePath: (path) =>
      travelling.some((project) =>
        allRootPaths(project).some((root) => isPathUnderRoot(path, root))
      ),
    travelling,
  }
}

/** Whether the host takes a copy of a workspace (`project_mutate`). */
async function hostTakesWorkspaces(facts: HostFacts): Promise<boolean> {
  const manifest = await facts.manifest().catch(() => null)
  return (
    manifest !== null &&
    CODE_SUPPLY_HOST_OPERATIONS.every((operation) =>
      supportsHostFeatureOperation(manifest, "always-on.code-supply", operation)
    )
  )
}

/**
 * A workspace the item is bound to that the host does not have: travelling
 * with its repository when the host can take it, missing otherwise.
 */
async function workspaceChecks(
  projectId: string | undefined,
  lookup: WorkspaceLookup,
  facts: HostFacts
): Promise<Pick<ItemChecks, "blockers" | "notes">> {
  if (!projectId) return { blockers: [], notes: [] }
  const travelling = lookup.travelling.find((project) => project.id === projectId)
  if (travelling?.repository && (await hostTakesWorkspaces(facts))) {
    return {
      blockers: [],
      notes: [
        {
          kind: "workspace-travels",
          workspace: travelling.name,
          remoteUrl: travelling.repository.remoteUrl,
        },
      ],
    }
  }
  if ((await facts.ids("projects")).has(projectId)) return { blockers: [], notes: [] }
  return {
    blockers: [{ kind: "reference-missing", reference: "workspace", id: projectId }],
    notes: [],
  }
}

function stringField(
  record: Record<string, unknown> | undefined,
  field: string
): string | undefined {
  const value = record?.[field]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Everything a scheduled task names that must also exist on the host, by
 * reference kind. Only fields the task's own executor reads are followed.
 */
async function scheduledTaskChecks(
  item: LoadedScheduledTask,
  facts: HostFacts,
  platform: Platform,
  resuming: boolean
): Promise<ItemChecks> {
  const { task } = item
  const payload = task.payload as Record<string, unknown> | undefined
  const blockers: MigrationBlocker[] = []
  const notes: MigrationNote[] = []

  const mcpServerIds = Array.isArray(payload?.mcpServerIds)
    ? payload.mcpServerIds.filter((id): id is string => typeof id === "string")
    : []
  const mcpServers = new Map<string, { name: string; transport: string }>()
  for (const id of mcpServerIds) {
    const server = await getDb().mcpServers.get(id)
    if (server) mcpServers.set(id, { name: server.name, transport: server.transport })
  }
  const workspaces = await workspaceLookup([task.projectId])
  const verdict = classifyScheduledTask(task, {
    target: describeRemoteSchedulerHost(platform),
    mcpServer: (id) => mcpServers.get(id),
    projectRoots: workspaces.projectRoots,
    portablePath: workspaces.portablePath,
  })
  blockers.push(...machineBoundBlockers(verdict))

  const need = async (
    reference: Extract<MigrationBlocker, { kind: "reference-missing" }>["reference"],
    id: string | undefined,
    present: () => Promise<boolean>
  ) => {
    if (!id) return
    if (!(await present())) blockers.push({ kind: "reference-missing", reference, id })
  }
  const inTable = (table: Parameters<HostFacts["ids"]>[0], id: string) => async () =>
    (await facts.ids(table)).has(id)

  const workflowId = stringField(payload, "workflowId")
  await need("workflow", workflowId, inTable("workflows", workflowId ?? ""))
  const characterId = stringField(payload, "characterId")
  await need("character", characterId, inTable("characters", characterId ?? ""))
  const skillId = stringField(payload, "skillId")
  await need("skill", skillId, inTable("skills", skillId ?? ""))
  const teamId = stringField(payload, "teamId")
  await need("agent-team", teamId, inTable("agentTeams", teamId ?? ""))
  const planId = stringField(payload, "planId")
  await need("plan", planId, inTable("plans", planId ?? ""))
  const sessionId = stringField(payload, "sessionId")
  await need("conversation", sessionId, inTable("sessions", sessionId ?? ""))
  if (task.type === "external-agent") {
    const agentId = stringField(payload, "agentId")
    await need("external-agent", agentId, async () =>
      (await facts.externalAgentIds()).has(agentId ?? "")
    )
  }
  for (const id of mcpServerIds) {
    // A stdio server is already machine-bound; only a remote one can exist there.
    if (mcpServers.get(id)?.transport === "stdio") continue
    await need("mcp-server", id, inTable("mcpServers", id))
  }
  const workspace = await workspaceChecks(task.projectId, workspaces, facts)
  blockers.push(...workspace.blockers)
  notes.push(...workspace.notes)

  if (task.type === "im-push") {
    const conversationKey = stringField(payload, "conversationKey")
    if (conversationKey) {
      const { adapterIdOfConversationKey } = await import("@/lib/connectors/inbox-writes/local")
      const adapterId = adapterIdOfConversationKey(conversationKey)
      if (adapterId && !(await facts.ids("adapterInstances")).has(adapterId)) {
        blockers.push(await dependencyOrMissing("connector-instance", adapterId))
      }
      notes.push({ kind: "conversation-address-relearned", conversationKey })
    }
  }

  if (!resuming && (await facts.hasScheduledTask(task.id))) {
    blockers.push({ kind: "id-conflict", id: task.id })
  }

  const pluginId = task.type === "plugin" ? stringField(payload, "pluginId") : undefined
  const plugins = await pluginChecks(pluginId ? [pluginId] : [], facts)
  return {
    blockers: [...blockers, ...plugins.blockers],
    notes,
    plugins: plugins.plugins,
  }
}

/**
 * A connector instance the item needs that the host does not have: either one
 * of this machine's, which can move first, or one that exists nowhere here.
 */
async function dependencyOrMissing(
  kind: "connector-instance",
  id: string
): Promise<MigrationBlocker> {
  const { getAdapterInstance } = await import("@/lib/db/adapter-instances")
  const local = await getAdapterInstance(id)
  return local
    ? { kind: "depends-on", item: { kind, id }, label: local.displayName }
    : { kind: "reference-missing", reference: "connector-instance", id }
}

async function botInstallationChecks(
  item: LoadedBotInstallation,
  facts: HostFacts
): Promise<ItemChecks> {
  const { installation, entry } = item
  const blockers: MigrationBlocker[] = []
  const notes: MigrationNote[] = []
  const workspaces = await workspaceLookup([installation.projectId, installation.workspaceId])
  const verdict = classifyBotInstallation(installation, entry?.triggers ?? [], {
    projectRoots: workspaces.projectRoots,
    portablePath: workspaces.portablePath,
  })
  blockers.push(...machineBoundBlockers(verdict))

  const version = entry?.version ?? installation.pinnedVersion
  const pluginId = entry?.pluginId
  const plugins = await pluginChecks(pluginId ? [pluginId] : [], facts)
  const hostEntry = (await facts.botCatalog()).get(installation.definitionId)
  // A plugin-contributed definition arrives with its plugin; only a definition
  // authored on this machine, or one the plugin no longer ships, is missing
  // in its own right.
  if ((!hostEntry || hostEntry.version !== version) && plugins.blockers.length === 0) {
    blockers.push({
      kind: "bot-definition-missing",
      definitionId: installation.definitionId,
      version,
      ...(pluginId ? { pluginId } : {}),
    })
  }

  const workspace = await workspaceChecks(
    installation.workspaceId ?? installation.projectId,
    workspaces,
    facts
  )
  blockers.push(...workspace.blockers)
  notes.push(...workspace.notes)

  const credentials = await facts.botCredentialIds()
  for (const binding of Object.values(installation.credentialBindings ?? {})) {
    if (binding.adapterId && !credentials.has(binding.adapterId)) {
      blockers.push(await dependencyOrMissing("connector-instance", binding.adapterId))
    }
    if (binding.integrationAccountId && !credentials.has(binding.integrationAccountId)) {
      blockers.push({
        kind: "reference-missing",
        reference: "integration-account",
        id: binding.integrationAccountId,
      })
    }
  }
  return { blockers: [...blockers, ...plugins.blockers], notes, plugins: plugins.plugins }
}

async function connectorInstanceChecks(
  item: LoadedConnectorInstance,
  facts: HostFacts,
  platform: Platform,
  resuming: boolean
): Promise<ItemChecks> {
  const { row } = item
  const blockers: MigrationBlocker[] = machineBoundBlockers(classifyConnectorInstance(row))
  const notes: MigrationNote[] = []
  if (!resuming && (await facts.ids("adapterInstances")).has(row.id)) {
    blockers.push({ kind: "id-conflict", id: row.id })
  }
  // Its chat schedules travel with it, so the host must be able to run each.
  if (item.schedules.length > 0) {
    notes.push({ kind: "schedules-travel", count: item.schedules.length })
    const host = describeRemoteSchedulerHost(platform)
    const characters = await facts.ids("characters")
    for (const task of item.schedules) {
      const support = getTaskTypeHostSupport(task.type, host)
      if (!support.supported) {
        blockers.push({
          kind: "machine-bound",
          reason: {
            kind: "task-type-unsupported",
            taskType: task.type,
            reason: support.reason ?? "missing-capability",
            missing: support.missing,
          },
        })
      }
      const characterId = stringField(task.payload as Record<string, unknown>, "characterId")
      if (characterId && !characters.has(characterId)) {
        blockers.push({ kind: "reference-missing", reference: "character", id: characterId })
      }
      if (!resuming && (await facts.hasScheduledTask(task.id))) {
        blockers.push({ kind: "id-conflict", id: task.id })
      }
    }
  }
  const { connectorsKeyringGet } = await import("@/lib/connectors/tauri/commands")
  for (const name of row.credentialsRef?.accounts ?? []) {
    try {
      if ((await connectorsKeyringGet(row.id, name)) !== null) {
        notes.push({ kind: "secret-transferred", name })
      }
    } catch {
      blockers.push({ kind: "secret-unreadable", name })
    }
  }
  const plugins = await pluginChecks(row.plugin ? [row.plugin.pluginId] : [], facts)
  return { blockers: [...blockers, ...plugins.blockers], notes, plugins: plugins.plugins }
}

/** Kind-specific checks; the shared ones live in the preflight. */
export function checkItem(
  item: LoadedItem,
  facts: HostFacts,
  platform: Platform,
  resuming: boolean
): Promise<ItemChecks> {
  if (item.kind === "scheduled-task") return scheduledTaskChecks(item, facts, platform, resuming)
  if (item.kind === "bot-installation") return botInstallationChecks(item, facts)
  return connectorInstanceChecks(item, facts, platform, resuming)
}

// ---------------------------------------------------------------------------
// Transfer steps
// ---------------------------------------------------------------------------

function isoOrUndefined(value: Date | undefined): string | undefined {
  return value ? new Date(value).toISOString() : undefined
}

/** A task as `scheduled_task_import` takes it: dates as strings, this machine's fields left behind. */
export function portableScheduledTask(task: ScheduledTask, status: ScheduledTaskStatus) {
  const {
    owner: _owner,
    promotion: _promotion,
    provenance: _provenance,
    nextRunAt: _nextRunAt,
    lastRunAt: _lastRunAt,
    lastTerminalAt: _lastTerminalAt,
    ...rest
  } = task
  return {
    ...rest,
    status,
    trigger: {
      ...task.trigger,
      ...(task.trigger.runAt ? { runAt: isoOrUndefined(task.trigger.runAt) } : {}),
    },
    ...(task.endAt ? { endAt: isoOrUndefined(task.endAt) } : {}),
    createdAt: new Date(task.createdAt).toISOString(),
    updatedAt: new Date(task.updatedAt).toISOString(),
  }
}

interface ImportResult {
  imported?: number
  skipped?: number
  errors?: string[]
}

/**
 * Give the host its copy of the workspace an item is bound to, when that
 * workspace travels with its repository (ADR-0224 A11). Idempotent: a resend
 * brings the copy up to date.
 */
async function sendWorkspace(
  projectId: string | undefined,
  context: TransferContext
): Promise<void> {
  if (!projectId) return
  const project = await getDb().projects.get(projectId)
  const copy = project ? transferredProject(project) : null
  if (!copy) return
  await context.transport.call("project_mutate", {
    operation: "upsert",
    operationId: context.operationId,
    project: copy,
    adminLease: context.adminLease,
  })
}

async function createScheduledTask(
  item: LoadedScheduledTask,
  context: TransferContext
): Promise<void> {
  await sendWorkspace(item.task.projectId, context)
  // Arrives paused when it ran here, so nothing fires before this machine's
  // copy is fenced; `arm` resumes it.
  const status: ScheduledTaskStatus = item.task.status === "active" ? "paused" : item.task.status
  const result = await context.transport.call<ImportResult>("scheduled_task_import", {
    data: { version: 1, tasks: [portableScheduledTask(item.task, status)] },
    mode: "merge",
    provenance: {
      kind: "migration",
      operationId: context.operationId,
      sourceLabel: context.sourceLabel,
    },
    adminLease: context.adminLease,
  })
  if ((result?.imported ?? 0) > 0) return
  if (result?.errors?.length) throw new Error(result.errors[0])
  // Skipped: it already exists. Ours from an earlier attempt of this
  // operation is a replay; anything else is a conflict nobody may overwrite.
  const existing = await context.transport.call<ScheduledTask | null>("scheduled_task_get", {
    taskId: item.task.id,
  })
  if (existing?.provenance?.operationId !== context.operationId) {
    throw new Error(
      `item_id_conflict: the host already has a scheduled task with id ${item.task.id}`
    )
  }
}

async function createBotInstallation(
  item: LoadedBotInstallation,
  context: TransferContext
): Promise<void> {
  if (!item.entry) {
    throw new Error(
      `bot_definition_missing: ${item.installation.definitionId} no longer resolves here`
    )
  }
  const { botInstallMutation, botPolicyGrantSchema } =
    await import("@/lib/bot/control-writes/lifecycle")
  const { installation } = item
  await sendWorkspace(installation.workspaceId ?? installation.projectId, context)
  // The wire grant is the complete triple; a partial stored ceiling stays
  // behind and the host applies its own defaults, which only narrow.
  const grant = botPolicyGrantSchema.safeParse(installation.policyGrant)
  await context.transport.call("bot_installation_mutate", {
    ...botInstallMutation(
      {
        entry: item.entry,
        scope: installation.scope,
        config: installation.config,
        credentialBindings: installation.credentialBindings,
        // Arrives switched off; `arm` enables it after this copy is fenced.
        enabled: false,
        ...(installation.triggerOverrides
          ? { triggerOverrides: installation.triggerOverrides }
          : {}),
        ...(grant.success ? { policyGrant: grant.data } : {}),
      },
      context.operationId
    ),
    // Interactive on the host (ADR-0224 A6), like every write a move makes.
    adminLease: context.adminLease,
  })
  // The model lane is the user's own choice, so it moves with the Bot; it is
  // a separate operation because the install shape is the catalog's.
  if (installation.executionRoute) {
    await context.transport.call("bot_installation_mutate", {
      operation: "execution_route",
      operationId: crypto.randomUUID(),
      installationId: `boti_${context.operationId}`,
      route: installation.executionRoute,
      adminLease: context.adminLease,
    })
  }
}

async function createConnectorInstance(
  item: LoadedConnectorInstance,
  context: TransferContext
): Promise<void> {
  const { portableAdapterInstance } = await import("@/lib/connectors/instance-transfer")
  const { connectorsKeyringGet } = await import("@/lib/connectors/tauri/commands")
  await context.transport.call("adapter_instance_mutate", {
    operation: "create",
    operationId: context.operationId,
    id: item.row.id,
    instance: { ...portableAdapterInstance(item.row), enabled: false },
    sourceLabel: context.sourceLabel,
    adminLease: context.adminLease,
  })
  // Secrets go to the host's keychain over the paired channel, one name at a
  // time; the instance row only ever names them.
  for (const credential of item.row.credentialsRef?.accounts ?? []) {
    const value = await connectorsKeyringGet(item.row.id, credential)
    if (value === null) continue
    await context.transport.call("connectors_keyring_set", {
      adapterId: item.row.id,
      credential,
      value,
      adminLease: context.adminLease,
    })
  }
}

export function createOnHost(item: LoadedItem, context: TransferContext): Promise<void> {
  if (item.kind === "scheduled-task") return createScheduledTask(item, context)
  if (item.kind === "bot-installation") return createBotInstallation(item, context)
  return createConnectorInstance(item, context)
}

/**
 * The status of the item on the host, in this machine's vocabulary for that
 * kind, or `null` when the host does not hold it.
 */
export async function remoteStatus(
  kind: OwnedItemKind,
  remoteItemId: string,
  transport: Pick<Transport, "call">
): Promise<string | null> {
  if (kind === "scheduled-task") {
    const task = await transport.call<ScheduledTask | null>("scheduled_task_get", {
      taskId: remoteItemId,
    })
    return task ? task.status : null
  }
  if (kind === "bot-installation") {
    const answer = await transport.call<{ rows?: Array<{ id?: unknown; status?: unknown }> }>(
      "bot_console_read",
      { view: "installations" }
    )
    const row = answer?.rows?.find((candidate) => candidate.id === remoteItemId)
    return row && typeof row.status === "string" ? row.status : null
  }
  const delta = await transport.call<{ rows?: Array<{ id?: unknown; enabled?: unknown }> }>(
    "sync_pull",
    { table: "adapterInstances", since: 0, content_protocol_version: 1 }
  )
  const row = delta?.rows?.find((candidate) => candidate.id === remoteItemId)
  if (!row) return null
  return row.enabled === true ? "enabled" : "disabled"
}

/** Start the host's copy, when it was running here. */
export async function armOnHost(
  item: Pick<LoadedItem, "kind" | "localStatus">,
  remoteItemId: string,
  context: TransferContext
): Promise<void> {
  if (item.kind === "scheduled-task") {
    if (item.localStatus !== "active") return
    await context.transport.call("scheduled_task_resume", { taskId: remoteItemId })
    return
  }
  if (item.kind === "bot-installation") {
    if (item.localStatus === "disabled") return
    // A Bot that needed setup here asks to be enabled too: the host answers
    // `needs_setup` itself if its slots are still unbound there.
    await context.transport.call("bot_installation_mutate", {
      operation: "set_enabled",
      operationId: crypto.randomUUID(),
      installationId: remoteItemId,
      enabled: true,
      adminLease: context.adminLease,
    })
    return
  }
  if (item.localStatus !== "enabled") return
  await context.transport.call("adapter_instance_mutate", {
    operation: "configure",
    operationId: crypto.randomUUID(),
    id: remoteItemId,
    patch: { enabled: true },
    adminLease: context.adminLease,
  })
}

/** Remove the host's copy. Already gone is done. */
export async function removeFromHost(
  kind: OwnedItemKind,
  remoteItemId: string,
  context: Omit<TransferContext, "sourceLabel">
): Promise<void> {
  if (kind === "scheduled-task") {
    await context.transport.call("scheduled_task_delete", {
      taskId: remoteItemId,
      adminLease: context.adminLease,
    })
    return
  }
  if (kind === "bot-installation") {
    await context.transport.call("bot_installation_mutate", {
      operation: "uninstall",
      operationId: crypto.randomUUID(),
      installationId: remoteItemId,
      adminLease: context.adminLease,
    })
    return
  }
  await context.transport.call("adapter_instance_mutate", {
    operation: "remove",
    operationId: crypto.randomUUID(),
    id: remoteItemId,
    adminLease: context.adminLease,
  })
}

/** Write the owner on this machine's copy (the fence, a pin, or a take-back). */
export async function setLocalOwner(
  kind: OwnedItemKind,
  id: string,
  owner: ItemOwner | undefined,
  status?: string
): Promise<void> {
  if (kind === "scheduled-task") {
    const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
    const updated = await getTaskScheduler().setTaskOwner(id, owner, {
      ...(status ? { status: taskStatusFrom(status) } : {}),
    })
    if (!updated) throw new Error(`item_missing: scheduled task ${id} is gone from this machine`)
    return
  }
  if (kind === "bot-installation") {
    const [{ setBotInstallationOwner, getBotInstallation }, { resolveInstalledBot }] =
      await Promise.all([import("@/lib/db/bot-installations"), import("@/lib/bot/installed-bot")])
    const installation = await getBotInstallation(id)
    if (!installation)
      throw new Error(`item_missing: Bot installation ${id} is gone from this machine`)
    const resolved = await resolveInstalledBot(installation).catch(() => undefined)
    await setBotInstallationOwner(id, owner, {
      ...(status ? { status: botStatusFrom(status) } : {}),
      ...(resolved ? { requiredCredentials: resolved.definition.requires?.credentials ?? [] } : {}),
    })
    return
  }
  const { setAdapterInstanceOwner } = await import("@/lib/db/adapter-instances")
  const updated = await setAdapterInstanceOwner(id, owner, {
    ...(status ? { enabled: status === "enabled" } : {}),
  })
  if (!updated) throw new Error(`item_missing: connector ${id} is gone from this machine`)
}

// ---------------------------------------------------------------------------
// Companions: what moves with an item (a connector's chat schedules)
// ---------------------------------------------------------------------------

async function localTask(id: string): Promise<ScheduledTask | undefined> {
  const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
  return (await getTaskScheduler().getTask(id)) ?? undefined
}

/**
 * Create a companion on the host, paused when it ran here. One deleted here
 * since the move started is no longer the user's, and is left behind.
 */
export async function createCompanionOnHost(
  companion: ItemMigrationCompanion,
  context: TransferContext
): Promise<void> {
  const task = await localTask(companion.id)
  if (!task) return
  await createScheduledTask(
    { kind: "scheduled-task", id: task.id, label: task.name, localStatus: task.status, task },
    context
  )
}

/** Fence or restore a companion here. One deleted here is already out of the way. */
export async function setCompanionOwner(
  companion: ItemMigrationCompanion,
  owner: ItemOwner | undefined,
  status?: string
): Promise<void> {
  const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
  await getTaskScheduler().setTaskOwner(companion.id, owner, {
    ...(status ? { status: taskStatusFrom(status) } : {}),
  })
}

/** Start the host's copy of a companion that was running here. */
export async function armCompanionOnHost(
  companion: ItemMigrationCompanion,
  context: Pick<TransferContext, "transport">
): Promise<void> {
  if (companion.localStatus !== "active") return
  if ((await remoteStatus("scheduled-task", companion.id, context.transport)) === null) return
  await context.transport.call("scheduled_task_resume", { taskId: companion.id })
}

/** The host's status for a companion, then remove its copy; `null` when it had none. */
export async function removeCompanionFromHost(
  companion: ItemMigrationCompanion,
  context: Omit<TransferContext, "sourceLabel">
): Promise<string | null> {
  const status = await remoteStatus("scheduled-task", companion.id, context.transport)
  if (status !== null) await removeFromHost("scheduled-task", companion.id, context)
  return status
}

function taskStatusFrom(status: string): ScheduledTaskStatus {
  return status === "active" || status === "paused" || status === "disabled" || status === "expired"
    ? status
    : "paused"
}

function botStatusFrom(status: string): BotInstallationRow["status"] {
  return status === "enabled" || status === "needs_setup" ? status : "disabled"
}
