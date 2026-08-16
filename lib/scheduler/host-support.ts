/**
 * Host support matrix for scheduled-task types (spec
 * `docs/superpowers/specs/2026-08-16-scheduler-host-neutral-design.md`).
 *
 * The scheduler runs on four host shapes — the Tauri desktop, the headless
 * brain (`cognia-agent serve`), the Capacitor mobile shell and a plain
 * browser. Executors used to branch on `isTauri()` ad hoc, which silently
 * failed every chat/agent/script/backup task on the headless brain even though
 * the scheduler runtime is registered there. This module is the SINGLE source
 * of truth for "can task type X run on host H":
 *
 *   - executors call {@link assertTaskTypeSupportedOnHost} /
 *     {@link unsupportedOnHost} to fail with a structured reason instead of a
 *     free-form string;
 *   - the task form disables (never hides) types that cannot run on the host
 *     whose schedule is being edited (local or remote), with the same reason;
 *   - the docs "runnable-by-host matrix" is derived from
 *     {@link TASK_TYPE_HOST_REQUIREMENTS}.
 *
 * Requirements are expressed as platform capability ids
 * (`lib/platform/capabilities.ts`) plus two host-shape requirements the
 * capability vocabulary does not carry:
 *
 *   - `host-filesystem` — the executor reads/writes the host's own filesystem
 *     (backups, wiki rebuild). True on the desktop and the headless brain;
 *     false in a browser or the mobile webview.
 *   - `desktop-shell`   — the executor needs the Tauri desktop process itself
 *     (OS scheduler, tray, native windows). Never satisfied off-desktop.
 *
 * Pure leaf: no React, no `@/lib/tauri`. Safe to import from executors, the
 * store, UI, and docs generators.
 */

import {
  detectLocalCapabilities,
  hasCapability,
  type CapabilityId,
} from "@/lib/platform/capabilities"
import { detectPlatform, type Platform } from "@/lib/platform/detect"
import type { ScheduledTaskType, TaskExecutionTerminalReason } from "@/types/scheduler"

/** A capability id or one of the two host-shape requirements. */
export type SchedulerHostRequirement = CapabilityId | "host-filesystem" | "desktop-shell"

/** What the caller knows about the host whose schedule is being evaluated. */
export interface SchedulerHostDescriptor {
  platform: Platform
  capabilities: readonly CapabilityId[]
}

/**
 * Task types that still exist in the persisted enum but have no executor and
 * must not be created anymore. Existing rows are auto-paused at scheduler
 * init (see `TaskSchedulerImpl.pauseDeprecatedTasks`) and labelled in the UI.
 *
 * - `sync`          — never had a backing system in cognia-next; the mobile
 *                     sync orchestrator is event-driven, not scheduler-driven.
 * - `ai-generation` — fully overlapped by `chat` (a prompt + resolved options).
 */
export const DEPRECATED_TASK_TYPES: readonly ScheduledTaskType[] = Object.freeze([
  "sync",
  "ai-generation",
] as const)

/**
 * Task types that are created by their owning subsystem's settings card (or
 * programmatically) rather than from the generic task form. They stay
 * visible/pausable in the list but are not offered in the type picker.
 */
export const CARD_AUTHORED_TASK_TYPES: readonly ScheduledTaskType[] = Object.freeze([
  "twin",
  "wiki-rebuild",
  "wiki-lint",
  "radar-report",
  "provider-diagnostics-refresh",
  "connection:scheduled:digest",
  "connection:outbound:send",
  "connection:housekeeping:clock",
  "connection:housekeeping:outbound-retention",
  "connection:housekeeping:connector-retention",
  "connection:housekeeping:callback-bindings",
  "connection:housekeeping:execution-runs",
  "connection:presence:refresh",
] as const)

/** True when the type is authored by its own card / subsystem, not the form. */
export function isCardAuthoredTaskType(type: string): type is ScheduledTaskType {
  return (CARD_AUTHORED_TASK_TYPES as readonly string[]).includes(type)
}

/**
 * Per-type host requirements. A type absent from this table has no
 * requirement beyond "an executor is registered" (plugin/custom/im-push/…).
 *
 * Keep this in sync with what each executor actually touches:
 *   sidecar          → drives a Claude turn (`claude_send`) or an ACP agent
 *   shell            → spawns processes through the jobs supervisor / shell
 *   host-filesystem  → writes backups / walks the wiki root
 */
export const TASK_TYPE_HOST_REQUIREMENTS: Readonly<
  Partial<Record<ScheduledTaskType, readonly SchedulerHostRequirement[]>>
> = Object.freeze({
  chat: ["sidecar"],
  agent: ["sidecar"],
  skill: ["sidecar"],
  goal: ["sidecar"],
  plan: ["sidecar"],
  "agent-team": ["sidecar"],
  "external-agent": ["shell"],
  script: ["shell"],
  "background-command": ["shell"],
  monitor: ["shell"],
  backup: ["host-filesystem"],
  "wiki-rebuild": ["host-filesystem"],
  workflow: [],
  "im-push": ["connector-runtime"],
  test: [],
} as const)

export type TaskTypeHostSupportReason =
  "deprecated-type" | "missing-capability" | "missing-host-filesystem" | "desktop-only"

export interface TaskTypeHostSupport {
  supported: boolean
  reason?: TaskTypeHostSupportReason
  /** Requirements the host does not satisfy (empty when supported). */
  missing: readonly SchedulerHostRequirement[]
  /** Every requirement the type declares (for the docs matrix / tooltips). */
  requires: readonly SchedulerHostRequirement[]
}

const HOST_FILESYSTEM_PLATFORMS: ReadonlySet<Platform> = new Set(["tauri", "headless"])

/** Describe the local runtime (platform + capability baseline). */
export function describeLocalSchedulerHost(): SchedulerHostDescriptor {
  return { platform: detectPlatform(), capabilities: detectLocalCapabilities() }
}

/** True when the host can satisfy one requirement. */
export function hostSatisfies(
  requirement: SchedulerHostRequirement,
  host: SchedulerHostDescriptor
): boolean {
  if (requirement === "host-filesystem") return HOST_FILESYSTEM_PLATFORMS.has(host.platform)
  if (requirement === "desktop-shell") return host.platform === "tauri"
  return hasCapability(requirement, host.capabilities)
}

/** True when the type is deprecated (no executor, auto-paused, not creatable). */
export function isDeprecatedTaskType(type: string): type is ScheduledTaskType {
  return (DEPRECATED_TASK_TYPES as readonly string[]).includes(type)
}

/**
 * Evaluate whether `type` can run on `host`. Deprecation wins over every other
 * reason; otherwise the first unmet requirement decides the reason and every
 * unmet requirement is reported in `missing`.
 */
export function getTaskTypeHostSupport(
  type: ScheduledTaskType,
  host: SchedulerHostDescriptor = describeLocalSchedulerHost()
): TaskTypeHostSupport {
  const requires = TASK_TYPE_HOST_REQUIREMENTS[type] ?? []
  if (isDeprecatedTaskType(type)) {
    return { supported: false, reason: "deprecated-type", missing: [], requires }
  }
  const missing = requires.filter((requirement) => !hostSatisfies(requirement, host))
  if (missing.length === 0) return { supported: true, missing, requires }
  const first = missing[0]
  const reason: TaskTypeHostSupportReason =
    first === "host-filesystem"
      ? "missing-host-filesystem"
      : first === "desktop-shell"
        ? "desktop-only"
        : "missing-capability"
  return { supported: false, reason, missing, requires }
}

/** Human-readable (log / execution row) explanation; UI uses i18n keys instead. */
export function describeUnsupportedTaskType(
  type: ScheduledTaskType,
  support: TaskTypeHostSupport,
  host: SchedulerHostDescriptor = describeLocalSchedulerHost()
): string {
  switch (support.reason) {
    case "deprecated-type":
      return `Task type "${type}" is deprecated and has no executor; recreate it as a "chat" task or delete it.`
    case "missing-host-filesystem":
      return `Task type "${type}" needs the host filesystem, which the ${host.platform} host does not expose (run it on the desktop app or a cloud host).`
    case "desktop-only":
      return `Task type "${type}" requires the Cognia desktop app.`
    case "missing-capability":
      return `Task type "${type}" requires the ${support.missing.join(", ")} capability, which the ${host.platform} host does not provide.`
    default:
      return `Task type "${type}" is supported on this host.`
  }
}

/** Terminal reason recorded on an execution that was refused by the host gate. */
export const UNSUPPORTED_ON_HOST_TERMINAL_REASON: TaskExecutionTerminalReason =
  "unsupported-on-host"

/**
 * Structured executor result for a host-gate refusal. Executors return this
 * verbatim so the scheduler stamps `terminalReason: "unsupported-on-host"`
 * and the UI can explain the failure without parsing the error string.
 */
export function unsupportedOnHost(
  type: ScheduledTaskType,
  support: TaskTypeHostSupport,
  host: SchedulerHostDescriptor = describeLocalSchedulerHost()
): {
  success: false
  error: string
  terminalReason: TaskExecutionTerminalReason
  output: {
    hostSupport: {
      reason?: TaskTypeHostSupportReason
      missing: SchedulerHostRequirement[]
      platform: Platform
    }
  }
} {
  return {
    success: false,
    error: describeUnsupportedTaskType(type, support, host),
    terminalReason: UNSUPPORTED_ON_HOST_TERMINAL_REASON,
    output: {
      hostSupport: {
        reason: support.reason,
        missing: [...support.missing],
        platform: host.platform,
      },
    },
  }
}

/**
 * Convenience for executors: returns `null` when the type may run here, else
 * the structured refusal result. Executors call this first, before any I/O.
 */
export function assertTaskTypeSupportedOnHost(
  type: ScheduledTaskType,
  host: SchedulerHostDescriptor = describeLocalSchedulerHost()
): ReturnType<typeof unsupportedOnHost> | null {
  const support = getTaskTypeHostSupport(type, host)
  return support.supported ? null : unsupportedOnHost(type, support, host)
}
