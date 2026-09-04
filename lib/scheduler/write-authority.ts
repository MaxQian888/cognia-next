/**
 * The one gate every non-user write to the schedule passes through.
 *
 * `SchedulerPermissionPolicy` has existed, been editable in settings, and been
 * persisted for a long time. Its enforcement function had ZERO callers, so
 * `agentAutoCreate`, `confirmationRequired`, `maxTasksPerSource` and
 * `scriptTasksEnabled` were four switches the user could set that changed
 * nothing at all. Meanwhile the agent-facing MCP tools enforced a hardcoded
 * quota of 8 that no setting could reach, and the plugin API documented in a
 * comment that callers "MUST consult this first" while doing nothing to make
 * that true.
 *
 * This module is that enforcement, and every write path calls it:
 *   - `stores/scheduler/scheduler-store.ts` (the UI and everything behind it)
 *   - `lib/skills/built-in/scheduler/` (the agent's built-in skills)
 *   - `lib/external-bridge/handlers/scheduling.ts` (the IM-facing MCP tools)
 *   - `lib/plugin/api/scheduler-tasks.ts` (plugin authors)
 *
 * It reads `AppSettings` at check time rather than a store snapshot, so a
 * long-lived tab cannot enforce a policy the user has since tightened, and so
 * this works in a headless host with no store mounted.
 */

import type { ScheduledTaskType, SchedulerPermissionPolicy } from "@/types/scheduler"
import { DEFAULT_PERMISSION_POLICY } from "@/types/scheduler"
import {
  assertTaskTypeSupportedOnHost,
  describeUnsupportedTaskType,
  getTaskTypeHostSupport,
} from "./host-support"

/** Who is asking. `user` is a person acting in the UI and is never gated. */
export type TaskWriteSource = "user" | "agent" | "plugin" | "system"

/** Machine-readable refusal, so every surface can render the same reasons. */
export type TaskWriteRefusalReason =
  /** `scriptTasksEnabled` is off and the type is `script`. */
  | "script-tasks-disabled"
  /** `maxTasksPerSource` reached for this source. */
  | "quota-exceeded"
  /** `agentAutoCreate` is off and this type is not on `confirmationRequired`. */
  | "agent-auto-create-disabled"
  /** The host cannot run this task type at all (`host-support.ts`). */
  | "unsupported-on-host"

export type TaskWriteVerdict =
  | { allowed: true }
  /**
   * The policy permits the write, but only with a human in the loop. The
   * caller decides what that looks like: `TaskConfirmationDialog` on the
   * desktop, an A2UI confirm card in IM and the built-in skills.
   */
  | { allowed: true; requiresConfirmation: true; reason: "confirmation-required"; message: string }
  | { allowed: false; reason: TaskWriteRefusalReason; message: string }

export interface TaskWriteRequest {
  taskType: ScheduledTaskType
  source: TaskWriteSource
  /** Owning chat session, for an agent write. */
  sessionId?: string
  /** Owning plugin, for a plugin write. */
  pluginId?: string
}

export interface TaskWriteAuthorityDeps {
  /** Injected in tests. Defaults to reading `AppSettings`. */
  loadPolicy?: () => Promise<SchedulerPermissionPolicy>
  /** Injected in tests. Defaults to an indexed count over `scheduledTasks`. */
  countTasksBySource?: (source: TaskWriteSource) => Promise<number>
}

/**
 * The user's policy, merged over the defaults.
 *
 * Exported because the execution cap in `concurrency-limit.ts` is enforced by
 * the scheduler rather than by this gate, and both must read the policy the
 * same way. A second loader would be a second answer to "what did the user
 * actually set", and the merge below is the part that is easy to get wrong.
 */
export async function loadSchedulerPolicy(): Promise<SchedulerPermissionPolicy> {
  const { getSettings } = await import("@/lib/db/settings")
  const stored = await getSettings()
    .then((settings) => settings.schedulerPermissionPolicy)
    .catch(() => undefined)
  // Merge over the defaults rather than replacing them: a policy persisted
  // before a field existed must not surface that field as `undefined`, which
  // would read as "no limit" for the quota and fail OPEN.
  return { ...DEFAULT_PERMISSION_POLICY, ...(stored ?? {}) }
}

/**
 * How many tasks this source already owns.
 *
 * Uses the `[createdBySource+status]` index added in schema v219. The previous
 * implementation counted `tasks.filter(() => true).length` behind a comment
 * admitting there was "no per-source tracking yet", which made the limit apply
 * to the user's own schedules as much as to an agent's and meant a busy user
 * locked their own agents out.
 *
 * `disabled` rows count. They are still occupying the user's schedule and can
 * be re-enabled without passing this gate again.
 */
async function countTasksBySourceFromDb(source: TaskWriteSource): Promise<number> {
  const { getDb } = await import("@/lib/db/schema")
  return getDb().scheduledTasks.where("createdBySource").equals(source).count()
}

/**
 * Decide whether `request` may write to the schedule.
 *
 * Order matters and is deliberate: the host gate runs FIRST, because a task
 * type this host cannot run is refused for everyone including the user, and
 * telling an agent "quota reached" for a task that could never have run is a
 * misleading answer.
 */
export async function authorizeTaskWrite(
  request: TaskWriteRequest,
  deps: TaskWriteAuthorityDeps = {}
): Promise<TaskWriteVerdict> {
  const support = getTaskTypeHostSupport(request.taskType)
  if (!support.supported) {
    return {
      allowed: false,
      reason: "unsupported-on-host",
      message: describeUnsupportedTaskType(request.taskType, support),
    }
  }

  // A person acting in the UI is the authority the policy protects, not a
  // subject of it. Gating them would mean the user could lock themselves out
  // of their own scheduler by tightening a setting.
  if (request.source === "user") return { allowed: true }

  const policy = await (deps.loadPolicy ?? loadSchedulerPolicy)()

  if (request.taskType === "script" && !policy.scriptTasksEnabled) {
    return {
      allowed: false,
      reason: "script-tasks-disabled",
      message: "Script tasks are turned off in the scheduler settings.",
    }
  }

  const owned = await (deps.countTasksBySource ?? countTasksBySourceFromDb)(request.source)
  if (owned >= policy.maxTasksPerSource) {
    return {
      allowed: false,
      reason: "quota-exceeded",
      message: `This ${request.source} already owns ${owned} scheduled tasks, which is the configured limit of ${policy.maxTasksPerSource}.`,
    }
  }

  // `confirmationRequired` is the narrower rule and is checked first, so a type
  // on that list asks for a human rather than being refused outright even when
  // `agentAutoCreate` is off. That is the whole point of having two settings:
  // one says "may they act unattended", the other says "which kinds always need
  // me". Without this ordering the second list would be unreachable.
  if (policy.confirmationRequired.includes(request.taskType)) {
    return {
      allowed: true,
      requiresConfirmation: true,
      reason: "confirmation-required",
      message: `Scheduling a "${request.taskType}" task needs your confirmation.`,
    }
  }

  if (request.source === "agent" && !policy.agentAutoCreate) {
    return {
      allowed: false,
      reason: "agent-auto-create-disabled",
      message:
        "Agents are not allowed to add to your schedule on their own. Turn on automatic creation in the scheduler settings, or add this task yourself.",
    }
  }

  return { allowed: true }
}

/** True when a verdict asks for a human before the write lands. */
export function verdictNeedsConfirmation(
  verdict: TaskWriteVerdict
): verdict is Extract<TaskWriteVerdict, { requiresConfirmation: true }> {
  return verdict.allowed && "requiresConfirmation" in verdict
}

/**
 * Throwing wrapper for callers with no confirmation surface of their own.
 *
 * A `requiresConfirmation` verdict is a REFUSAL here, not an approval: a caller
 * that cannot ask the user must not decide on their behalf. It carries a
 * distinct message so the caller can tell the user to add the task from the
 * scheduler panel instead.
 */
export async function assertTaskWriteAllowed(
  request: TaskWriteRequest,
  deps: TaskWriteAuthorityDeps = {}
): Promise<void> {
  const verdict = await authorizeTaskWrite(request, deps)
  if (verdict.allowed && !verdictNeedsConfirmation(verdict)) return
  if (verdictNeedsConfirmation(verdict)) {
    throw new Error(
      `${verdict.message} This caller has no way to ask, so add it from the scheduler panel instead.`
    )
  }
  throw new Error(verdict.message)
}

/** Re-exported so callers gate on one import rather than two. */
export { assertTaskTypeSupportedOnHost }
