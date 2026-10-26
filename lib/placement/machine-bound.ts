/**
 * Which always-on work cannot leave this machine, and why (ADR-0224).
 *
 * Moving a scheduled task, bot installation or connector instance to a paired
 * host only makes sense when the host can do the same job. Some work is about
 * THIS machine: its disk, its OS timer, its desktop events, a local process,
 * a stdio MCP server it launches, a secret in its keychain. Moved, it would
 * either fail on the host or quietly do something else there (a backup task
 * would back up the host instead of this desktop).
 *
 * One classifier, used by the migration preflight, the guided flow and the
 * default-placement rule for new items, so all three give the same answer and
 * the same reason. Pure and synchronous: callers gather the local facts it
 * needs (MCP servers, project roots) and the target's descriptor first.
 *
 * Reasons are listed, never collapsed: the user sees every one, and an item
 * with none is movable.
 */

import { capabilitiesForPlatform } from "@/lib/platform/capabilities"
import type { Platform } from "@/lib/platform/detect"
import {
  getTaskTypeHostSupport,
  type SchedulerHostDescriptor,
  type TaskTypeHostSupportReason,
} from "@/lib/scheduler/host-support"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { BotInstallationRow } from "@/lib/db/bot-types"
import type { PluginBotTriggerDef } from "@/types/plugin/plugin-bot"
import type { ScheduledTask, ScheduledTaskType } from "@/types/scheduler"

export type MachineBoundReason =
  /** Promoted to this machine's OS scheduler: the timer is this machine's. */
  | { kind: "os-promotion" }
  /** The target host cannot run this task type at all. */
  | {
      kind: "task-type-unsupported"
      taskType: string
      reason: TaskTypeHostSupportReason
      missing: readonly string[]
    }
  /** Maintains this machine's own data (backups, archive, Trash, wiki, twin…). */
  | { kind: "machine-maintenance"; taskType: string }
  /** Watches a process that runs on this machine. */
  | { kind: "local-process"; taskType: string }
  /** Belongs to another item and moves with it, never on its own. */
  | { kind: "managed-by"; manager: "bot-installation" | "connector-instance" }
  /** Fires on an event only this machine's own activity emits. */
  | { kind: "local-event"; eventType: string }
  /** A Bot trigger on desktop or pet events, which only a desktop emits. */
  | { kind: "desktop-trigger"; triggerId: string }
  /** Names a directory or file on this machine's disk. */
  | { kind: "local-path"; field: string; path: string }
  /** Bound to a workspace whose roots are directories on this machine. */
  | { kind: "local-project-root"; projectId: string; path: string }
  /** Uses an MCP server this machine launches as a local process. */
  | { kind: "stdio-mcp"; serverId: string; name: string }
  /** Reads a secret from this machine's keychain, which phase A cannot carry. */
  | { kind: "keyring-reference"; ref: string }
  /** Talks to a service on this machine's loopback interface. */
  | { kind: "loopback-endpoint"; field: string; url: string }
  /** Receives through this machine's public webhook URL. */
  | { kind: "webhook-endpoint"; publicUrl?: string }

export type MachineBoundReasonKind = MachineBoundReason["kind"]

export interface MachineBoundVerdict {
  /** True when nothing ties the item to this machine. */
  movable: boolean
  reasons: MachineBoundReason[]
}

function verdict(reasons: MachineBoundReason[]): MachineBoundVerdict {
  return { movable: reasons.length === 0, reasons }
}

/**
 * The scheduler-facing description of a paired host, from the `platform` its
 * feature manifest reports. The capability baseline is the platform's, the
 * same table the host itself starts from.
 */
export function describeRemoteSchedulerHost(platform: Platform): SchedulerHostDescriptor {
  return { platform, capabilities: capabilitiesForPlatform(platform) }
}

/**
 * Task types whose whole job is this machine's own state. A host can run its
 * own copy of each, but moving this one would change what it does.
 */
const MACHINE_MAINTENANCE_TASK_TYPES: ReadonlySet<ScheduledTaskType> = new Set([
  "backup",
  "conversation-auto-archive",
  "files-trash-purge",
  "harness-evolution-sweep",
  "wiki-rebuild",
  "wiki-lint",
  "twin",
  "radar-report",
  "provider-diagnostics-refresh",
  "github-issue-sync",
  "issue-wakeup",
  "connection:housekeeping:clock",
  "connection:housekeeping:outbound-retention",
  "connection:housekeeping:connector-retention",
  "connection:housekeeping:callback-bindings",
  "connection:housekeeping:execution-runs",
  "connection:housekeeping:attachment-cache",
  "connection:presence:refresh",
])

/** A Bot's timed triggers become `bot` tasks; a connector's sends become these. */
const MANAGED_TASK_TYPES: ReadonlyMap<
  ScheduledTaskType,
  "bot-installation" | "connector-instance"
> = new Map([
  ["bot", "bot-installation"],
  ["connection:scheduled:digest", "connector-instance"],
  ["connection:outbound:send", "connector-instance"],
])

/**
 * The item a task belongs to when it is one of a Bot's or a connector's own
 * tasks. Such a task moves with that item and is never offered on its own.
 */
export function managedTaskOwner(
  type: ScheduledTaskType
): "bot-installation" | "connector-instance" | undefined {
  return MANAGED_TASK_TYPES.get(type)
}

/** `monitor` watches a background job of this machine's. */
const LOCAL_PROCESS_TASK_TYPES: ReadonlySet<ScheduledTaskType> = new Set(["monitor"])

/**
 * Scheduler events emitted by this machine's own activity. A host emits its
 * own `session:completed`, never this desktop's, so a task listening for one
 * here would wait forever there. `connection:*` events come from connectors,
 * which move with their instances, and `custom` is emitted on request to
 * whichever host is asked.
 */
const LOCAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session:created",
  "session:completed",
  "session:deleted",
  "sync:started",
  "sync:completed",
  "sync:failed",
  "backup:needed",
  "backup:completed",
  "workflow:completed",
  "agent:completed",
  "chat:completed",
  "goal:completed",
  "agent-team:completed",
  "plan:completed",
  "job:exited",
  "monitor:fired",
  "issue:activity",
])

/** Payload fields that name a location on this machine's disk. */
const PATH_FIELDS = ["cwd", "rootDir", "workingDirectory", "path"] as const
const PATH_LIST_FIELDS = ["additionalDirectories"] as const

const ABSOLUTE_PATH = /^(?:\/|~(?:[\\/]|$)|[A-Za-z]:[\\/]|\\\\)/
const KEYRING_REF = /^keyring:[^:\s]+:\S+$/

/** True for a string that names a filesystem location rather than a relative name. */
export function isLocalPath(value: string): boolean {
  return ABSOLUTE_PATH.test(value.trim())
}

/** True for a URL whose host is this machine's loopback interface. */
export function isLoopbackUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return false
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  )
}

/** Every `keyring:<namespace>:<key>` string anywhere in a JSON-shaped value. */
export function collectKeyringRefs(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    if (KEYRING_REF.test(value)) into.add(value)
  } else if (Array.isArray(value)) {
    for (const item of value) collectKeyringRefs(item, into)
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectKeyringRefs(item, into)
  }
  return into
}

function pathReasons(
  record: Record<string, unknown> | undefined,
  portable: (path: string) => boolean = () => false
): MachineBoundReason[] {
  if (!record) return []
  const reasons: MachineBoundReason[] = []
  const bound = (value: unknown): value is string =>
    typeof value === "string" && isLocalPath(value) && !portable(value)
  for (const field of PATH_FIELDS) {
    const value = record[field]
    if (bound(value)) reasons.push({ kind: "local-path", field, path: value })
  }
  for (const field of PATH_LIST_FIELDS) {
    const value = record[field]
    if (!Array.isArray(value)) continue
    for (const item of value) {
      if (bound(item)) reasons.push({ kind: "local-path", field, path: item })
    }
  }
  return reasons
}

function keyringReasons(value: unknown): MachineBoundReason[] {
  return [...collectKeyringRefs(value)].map((ref) => ({ kind: "keyring-reference", ref }))
}

/** What the classifier needs to know about this machine, gathered by the caller. */
export interface MachineBoundContext {
  /** The host the item would move to. */
  target: SchedulerHostDescriptor
  /** This machine's MCP server by id, when it has one. */
  mcpServer?: (id: string) => { name: string; transport: string } | undefined
  /**
   * Absolute root directories of one of this machine's workspaces. A
   * workspace that travels with its repository (ADR-0224 A11) answers none:
   * the host clones it rather than needing these folders.
   */
  projectRoots?: (projectId: string) => readonly string[]
  /**
   * True for a path inside such a workspace's folders: it maps into the
   * host's clone, so it does not bind the item here.
   */
  portablePath?: (path: string) => boolean
}

function projectReasons(
  projectId: string | undefined,
  projectRoots: MachineBoundContext["projectRoots"]
): MachineBoundReason[] {
  if (!projectId || !projectRoots) return []
  return projectRoots(projectId)
    .filter(isLocalPath)
    .map((path) => ({ kind: "local-project-root", projectId, path }))
}

export function classifyScheduledTask(
  task: Pick<ScheduledTask, "type" | "trigger" | "payload" | "promotion" | "projectId">,
  context: MachineBoundContext
): MachineBoundVerdict {
  const reasons: MachineBoundReason[] = []
  if (task.promotion) reasons.push({ kind: "os-promotion" })

  const manager = MANAGED_TASK_TYPES.get(task.type)
  if (manager) reasons.push({ kind: "managed-by", manager })
  if (MACHINE_MAINTENANCE_TASK_TYPES.has(task.type)) {
    reasons.push({ kind: "machine-maintenance", taskType: task.type })
  }
  if (LOCAL_PROCESS_TASK_TYPES.has(task.type)) {
    reasons.push({ kind: "local-process", taskType: task.type })
  }

  const support = getTaskTypeHostSupport(task.type, context.target)
  if (!support.supported && support.reason) {
    reasons.push({
      kind: "task-type-unsupported",
      taskType: task.type,
      reason: support.reason,
      missing: support.missing,
    })
  }

  if (task.trigger.type === "event" && task.trigger.eventType) {
    if (LOCAL_EVENT_TYPES.has(task.trigger.eventType)) {
      reasons.push({ kind: "local-event", eventType: task.trigger.eventType })
    }
  }

  const payload = task.payload as Record<string, unknown> | undefined
  reasons.push(...pathReasons(payload, context.portablePath))
  const mcpServerIds = payload?.mcpServerIds
  if (Array.isArray(mcpServerIds) && context.mcpServer) {
    for (const id of mcpServerIds) {
      if (typeof id !== "string") continue
      const server = context.mcpServer(id)
      if (server?.transport === "stdio") {
        reasons.push({ kind: "stdio-mcp", serverId: id, name: server.name })
      }
    }
  }
  reasons.push(...keyringReasons(payload))
  reasons.push(...projectReasons(task.projectId, context.projectRoots))
  return verdict(reasons)
}

export function classifyBotInstallation(
  installation: Pick<BotInstallationRow, "config" | "projectId">,
  triggers: readonly PluginBotTriggerDef[],
  context: Pick<MachineBoundContext, "projectRoots" | "portablePath"> = {}
): MachineBoundVerdict {
  const reasons: MachineBoundReason[] = []
  for (const trigger of triggers) {
    if (trigger.kind === "event" && trigger.source === "desktop") {
      reasons.push({ kind: "desktop-trigger", triggerId: trigger.id })
    }
  }
  reasons.push(...pathReasons(installation.config, context.portablePath))
  reasons.push(...keyringReasons(installation.config))
  reasons.push(...projectReasons(installation.projectId, context.projectRoots))
  return verdict(reasons)
}

export function classifyConnectorInstance(
  row: Pick<AdapterInstanceRow, "transportMode" | "publicUrl" | "settings">
): MachineBoundVerdict {
  const reasons: MachineBoundReason[] = []
  if (row.transportMode === "webhook") {
    reasons.push({
      kind: "webhook-endpoint",
      ...(row.publicUrl ? { publicUrl: row.publicUrl } : {}),
    })
  }
  for (const [field, value] of Object.entries(row.settings ?? {})) {
    if (typeof value !== "string") continue
    if (isLoopbackUrl(value)) reasons.push({ kind: "loopback-endpoint", field, url: value })
    else if (isLocalPath(value)) reasons.push({ kind: "local-path", field, path: value })
  }
  reasons.push(...keyringReasons(row.settings))
  return verdict(reasons)
}
