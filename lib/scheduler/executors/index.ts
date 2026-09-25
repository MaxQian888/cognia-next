/**
 * Task executor registry for the app scheduler.
 *
 * `registerBuiltInExecutors()` registers every executor that lives in this
 * directory. Which of them may run on the current host is decided by
 * `lib/scheduler/host-support.ts` (capability-based; executors do NOT branch
 * on `isTauri()`), so the same registry runs on the Tauri desktop, the
 * headless brain, the mobile shell and a plain browser and fails with a
 * structured `unsupported-on-host` reason where the host lacks a capability.
 *
 *   - chat            → drives a Claude session via lib/claude/ipc.sendPrompt,
 *                       feeding the SAME `resolveSendOptions` pipeline the
 *                       interactive composer uses (character / agent mode /
 *                       skills / allowed tools / MCP / built-in tools / …).
 *   - agent           → chat + bound character (a.k.a. agent persona).
 *   - skill           → chat + one ad-hoc skill on top of the character set.
 *   - external-agent  → drives an ACP agent (Claude Desktop, Cursor, …) via
 *                       lib/ai/agent/external/manager:executeOnExternalAgent.
 *   - script          → runs an inline script through the host shell.
 *   - background-command / monitor → jobs supervisor (host-neutral RPC).
 *   - backup          → builds & writes an encrypted backup (local / WebDAV /
 *                       GitHub / Google Drive).
 *   - workflow        → runs a published visual workflow (`workflow-executor.ts`).
 *   - im-push         → pushes a message into a bound IM conversation.
 *   - test            → diagnostic echo executor (`test-executor.ts`).
 *   - plugin          → routes to the registered plugin handler.
 *   - custom          → user/plugin-supplied executor registered at runtime
 *                       under the "custom" type; fails with EXECUTOR_NOT_FOUND
 *                       when nothing is registered (never a silent no-op).
 *   - twin / wiki-rebuild / wiki-lint / radar-report / agent-team / goal / plan
 *                     → subsystem executors registered here as well.
 *
 * `initSchedulerSystem` calls `registerBuiltInExecutors()` at boot. A scheduler
 * started without it (a lifecycle write that lands before the initializer
 * mounts) loads this module on demand through `../executor-owners.ts` when a
 * built-in task comes due, which is why the registered types are declared
 * there as `BUILT_IN_EXECUTOR_TASK_TYPES`.
 *
 * Connector task types (`connection:*`) are registered by the `integrations`
 * boot bundle. `provider-diagnostics-refresh` is registered by
 * `lib/provider-diagnostics/refresh.ts`, which the scheduler also loads on
 * demand through `../executor-owners.ts` when the boot that installs it never
 * ran.
 */

import type {
  AgentTaskPayload,
  ChatLikeTaskPayload,
  ExternalAgentTaskPayload,
  ScheduledTask,
  SkillTaskPayload,
  TaskExecution,
  TaskExecutorResult,
} from "@/types/scheduler"
import { openWorkspaceBundleTurnLease } from "@/lib/task-workspace/run-lease"
import {
  acquireWorkspaceBundle,
  getWorkspaceBundle,
  type BeginTaskWorkspaceTurn,
} from "@/lib/task-workspace/client"
import { resolveSessionWorkspaceRoot } from "@/lib/task-workspace/session-execution-context"
import { provisioningForWorkspaceRoot } from "@/lib/task-workspace/workspace-provisioning"
import { getProjectEnvironment } from "@/lib/db/project-environments"
import { withRestrictedModeDenials } from "@/lib/workspace/restricted-tools"
import { remapExactRoots } from "@/lib/task-workspace/root-aliases"
import type { Project } from "@/types"
import { executeProjectEnvironment } from "@/lib/project-environment/executor"
import { resolveEnvironmentForRun } from "@/lib/project-environment/resolve-environment"
import { registerTaskExecutor, type TaskExecutor } from "../task-scheduler"
import { BUILT_IN_EXECUTOR_TASK_TYPES, type BuiltInExecutorTaskType } from "../executor-owners"
import { executePluginTask } from "./plugin-executor"
import { executeBackupTask } from "./backup-executor"
import { executeTwinTask } from "./twin-executor"
import { executeWikiRebuildTask } from "./wiki-rebuild-executor"
import { executeWikiLintTask } from "./wiki-lint-executor"
import { executeGithubIssueSyncTask } from "./github-issue-sync-executor"
import { executeRadarReportTask } from "./radar-report-executor"
import { executeAgentTeamTask } from "./team-executor"
import { executeGoalTask } from "./goal-executor"
import { scheduledSessionAttribution } from "./session-attribution"
import {
  loadOwningWorkspace,
  resolveScheduledWorkspaceTrust,
  type ScheduledWorkspaceTrust,
} from "./owning-workspace"
import { executePlanTask } from "./plan-executor"
import { executeBotTask } from "./bot-executor"
import { executeBackgroundCommandTask, executeMonitorTask } from "./background-job-executor"
import { executeScript } from "../script-executor"
import { sendPrompt, onClaudeMessage, interruptSession, approveTool } from "@/lib/claude/ipc"
import {
  createUnattendedPermissionResponder,
  needsApprovalSummary,
  type UnattendedPermissionResponder,
} from "@/lib/claude/unattended-permission-responder"
import type {
  AppSettings,
  BuiltinToolsConfig,
  ChatSession,
  ClaudeEvent,
  SendOptions,
} from "@cognia/agent-config-types"
import { createSession, getSession } from "@/lib/db/sessions"
import {
  beginAgentTaskAttempt,
  linkAgentTaskAttemptExecution,
  settleAgentTaskAttempt,
} from "@/lib/db/agent-tasks"
import { getSettings } from "@/lib/db/settings"
import { listEnabledMcpServers, buildMcpServerMapResolved } from "@/lib/db/mcp-servers"
import type { WorkspaceCapabilityScope } from "@/lib/db/workspace-capabilities"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { BUILT_IN_AGENT_MODES, type AgentModeConfig } from "@/types/agent/agent-mode"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { listEnabledSkillsByIds, renderSkillsSection } from "@/lib/db/skills"
import { DEFAULT_SKILL_CATALOG_TOKEN_BUDGET } from "@/lib/skills/prompt-budget"
import { executeOnExternalAgent } from "@/lib/ai/agent/external/manager"
import { loggers } from "@cognia/logging"
import { assertTaskTypeSupportedOnHost } from "../host-support"
import { executeTestTask } from "./test-executor"
import { executeWorkflowTask } from "./workflow-executor"
import { executeImPushTask } from "./im-push-executor"

const log = loggers.scheduler

// =============================================================================
// Public payload aliases
// =============================================================================

/**
 * @deprecated Re-exported for back-compat with callers that imported
 * `ChatTaskPayload` from this module. Prefer importing `ChatLikeTaskPayload`
 * (or the type-narrow variants `AgentTaskPayload` / `SkillTaskPayload`) from
 * `@/types/scheduler`.
 */
export type ChatTaskPayload = ChatLikeTaskPayload
export type { AgentTaskPayload, SkillTaskPayload, ExternalAgentTaskPayload }

// =============================================================================
// Common types
// =============================================================================

type ChatExecutionResult = TaskExecutorResult

async function openScheduledWritableBundle(
  task: ScheduledTask,
  execution: TaskExecution,
  sourceRoot: string,
  agentKind: string
) {
  const primaryLogicalRootId = "primary"
  // A scheduled run gets a fresh worktree with no `node_modules` every time it
  // fires. Whatever the workspace provisions its chat worktrees with applies
  // here for the same reason and by the same consent.
  const provisioning = await provisioningForWorkspaceRoot(sourceRoot).catch(() => undefined)
  const bundle = await acquireWorkspaceBundle({
    ownerType: "scheduled",
    ownerRef: task.id,
    environmentKind: "managed",
    base: { kind: "remoteDefault" },
    roots: [
      {
        logicalRootId: primaryLogicalRootId,
        role: "primary",
        sourceRoot,
      },
    ],
    ...(provisioning ? { provisioning } : {}),
  })
  const lease = await openWorkspaceBundleTurnLease(bundle, primaryLogicalRootId, {
    taskId: `scheduled:${task.id}`,
    sessionId: task.id,
    runId: `scheduled:${execution.id}:${agentKind}`,
    executionRunId: execution.id,
    turnId: execution.id,
    attemptId: "a1",
    surface: "scheduler",
    agentId: "scheduler",
    agentKind,
    workspaceRoot: sourceRoot,
    base: { kind: "remoteDefault" },
  })
  if (!lease) throw new Error("Scheduled Registry Bundle Turn is unavailable")
  return lease
}

// =============================================================================
// Legacy payload field migration
// =============================================================================

const legacyWarnedTaskIds = new Set<string>()

/**
 * Old `conversational-task-authoring` versions wrote `payload.message` (chat)
 * and `payload.agentTask` (agent) instead of the canonical `prompt`. This
 * helper transparently rewrites those legacy keys into `prompt` so existing
 * IndexedDB rows keep working. We log a one-time warning per task id so
 * stragglers are surfaced without spamming.
 */
function reconcileLegacyPromptFields(
  taskId: string,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...payload }

  if (typeof next.prompt !== "string" || next.prompt.trim().length === 0) {
    if (typeof next.message === "string" && next.message.trim().length > 0) {
      next.prompt = next.message
      delete next.message
      if (!legacyWarnedTaskIds.has(taskId)) {
        legacyWarnedTaskIds.add(taskId)
        log.warn(
          "[deprecated] Scheduled task payload uses `message` instead of `prompt`. Auto-migrating; please update authoring code.",
          { taskId }
        )
      }
    } else if (typeof next.agentTask === "string" && next.agentTask.trim().length > 0) {
      next.prompt = next.agentTask
      delete next.agentTask
      if (!legacyWarnedTaskIds.has(taskId)) {
        legacyWarnedTaskIds.add(taskId)
        log.warn(
          "[deprecated] Scheduled task payload uses `agentTask` instead of `prompt`. Auto-migrating; please update authoring code.",
          { taskId }
        )
      }
    }
  }

  // Older agent drafts nested model / maxSteps under `payload.config`. Hoist
  // them so the executor can treat them like every other ChatLikeTaskPayload
  // field.
  if (next.config && typeof next.config === "object" && !Array.isArray(next.config)) {
    const cfg = next.config as Record<string, unknown>
    if (typeof cfg.model === "string" && next.model === undefined) next.model = cfg.model
    if (typeof cfg.maxSteps === "number" && next.maxTurns === undefined)
      next.maxTurns = cfg.maxSteps
    delete next.config
  }

  return next
}

// =============================================================================
// Agent mode resolution
// =============================================================================

/**
 * Resolve a payload `agentModeId` against the built-in registry first, then
 * the custom-mode store. Returns:
 *   - `undefined` — defer to `useAgentRuntimeStore.modeId` (default behaviour
 *     of `resolveSendOptions` when `ctx.agentMode` is omitted).
 *   - `null`      — explicitly opt OUT of mode application.
 *   - `AgentModeConfig` — apply the resolved mode.
 *
 * An unknown id is treated as `null` (opt-out) and warned about so the user
 * gets feedback that the mode they picked is missing rather than silently
 * falling back to the runtime-store default.
 */
function resolveAgentMode(
  taskId: string,
  agentModeId: string | null | undefined
): AgentModeConfig | null | undefined {
  if (agentModeId === undefined) return undefined
  if (agentModeId === null) return null
  const builtIn = BUILT_IN_AGENT_MODES.find((m) => m.id === agentModeId)
  if (builtIn) return builtIn
  const custom = useCustomModeStore.getState().customModes[agentModeId]
  if (custom) return custom
  log.warn("Scheduled task references unknown agent mode id; falling back to no mode", {
    taskId,
    agentModeId,
  })
  return null
}

// =============================================================================
// Override layering — keep parity with hooks/chat/use-claude-chat.ts merge
// =============================================================================

function unionStrings(...sources: (readonly string[] | undefined)[]): string[] {
  const out = new Set<string>()
  for (const src of sources) {
    if (!src) continue
    for (const s of src) out.add(s)
  }
  return [...out]
}

/**
 * Layer the payload-level overrides on top of the SendOptions returned by
 * `resolveSendOptions`. Mirrors the rules used in `use-claude-chat.ts:111-140`
 * for `pendingCommandOverrides`:
 *
 *   - `model`, `permissionMode`, `maxTurns`, `effort` → assign
 *   - `appendSystemPrompt`                            → join with existing (if any)
 *   - `allowedTools`, `additionalDirectories`         → UNION with resolved set
 *   - `disallowedTools`                               → assign
 *   - `mcpServerIds`                                  → resolve to a server map
 *                                                       and assign
 *   - `builtinTools`                                  → shallow-merge over the
 *                                                       resolved AppSettings
 *                                                       toggles
 */
async function applyPayloadOverrides(
  base: SendOptions,
  payload: ChatLikeTaskPayload,
  appSettings: AppSettings | null,
  capabilityScope: WorkspaceCapabilityScope
): Promise<SendOptions> {
  const out: SendOptions = { ...base }

  if (payload.model) out.model = payload.model
  if (payload.permissionMode) out.permissionMode = payload.permissionMode
  if (typeof payload.maxTurns === "number") out.maxTurns = payload.maxTurns
  if (payload.effort) out.effort = payload.effort

  if (payload.appendSystemPrompt && payload.appendSystemPrompt.trim().length > 0) {
    const existing = out.appendSystemPrompt?.trim() ?? ""
    out.appendSystemPrompt = existing
      ? `${existing}\n\n${payload.appendSystemPrompt.trim()}`
      : payload.appendSystemPrompt.trim()
  }

  if (payload.allowedTools && payload.allowedTools.length > 0) {
    out.allowedTools = unionStrings(out.allowedTools, payload.allowedTools)
  }

  if (payload.disallowedTools && payload.disallowedTools.length > 0) {
    out.disallowedTools = [...payload.disallowedTools]
  }

  if (payload.additionalDirectories && payload.additionalDirectories.length > 0) {
    out.additionalDirectories = unionStrings(
      out.additionalDirectories,
      payload.additionalDirectories
    )
  }

  if (payload.mcpServerIds) {
    try {
      const enabled = await listEnabledMcpServers(capabilityScope)
      const wanted = new Set(payload.mcpServerIds)
      const subset = enabled.filter((srv) => wanted.has(srv.id))
      if (subset.length > 0) {
        out.mcpServers = await buildMcpServerMapResolved(subset)
      } else {
        // Empty array means "no MCP servers" — strip the resolved map.
        delete out.mcpServers
      }
    } catch (err) {
      log.warn("Scheduler payload mcpServerIds resolution failed", { err: String(err) })
    }
  }

  if (payload.builtinTools) {
    const baseTools: BuiltinToolsConfig = out.builtinTools ??
      appSettings?.builtinTools ?? {
        fileExtras: false,
        git: false,
        process: false,
        environment: false,
        shellAdvanced: false,
      }
    out.builtinTools = { ...baseTools, ...payload.builtinTools }
  }

  return out
}

// =============================================================================
// Session resolution + ad-hoc skill injection
// =============================================================================

interface PreparedSession {
  session: ChatSession
  /** True when the executor created this session for the run (vs. resumed). */
  created: boolean
}

async function resolveOrCreateSession(
  task: ScheduledTask,
  payload: ChatLikeTaskPayload,
  options: { characterId?: string; runId?: string }
): Promise<PreparedSession | { error: string }> {
  if (payload.sessionId) {
    const existing = await getSession(payload.sessionId)
    if (!existing) {
      return { error: `Session not found: ${payload.sessionId}` }
    }
    return { session: existing, created: false }
  }

  const isTeam = !!payload.teamId
  const session = await createSession({
    title: payload.sessionTitle ?? `${task.name} (scheduled)`,
    kind: isTeam ? "team" : "direct",
    characterId: options.characterId,
    teamId: payload.teamId,
    model: payload.model,
    executionContext: payload.executionContext,
    ...scheduledSessionAttribution(task, options.runId),
  })
  return { session, created: true }
}

/**
 * For `skill` tasks the user picks one ad-hoc skill on top of the character's
 * own skill set. We splice that skill's prompt section onto the resolved
 * system prompt and union its `allowedTools` into the resolved whitelist.
 */
async function applyAdHocSkill(
  base: SendOptions,
  skillId: string | undefined,
  capabilityScope: WorkspaceCapabilityScope
): Promise<SendOptions> {
  if (!skillId) return base
  const skills = await listEnabledSkillsByIds([skillId], capabilityScope)
  if (skills.length === 0) return base

  const out: SendOptions = { ...base }
  // Same ceiling the interactive send pipeline applies — a scheduled run has
  // no one watching to notice a prompt that grew past the model's budget.
  const skillSection = renderSkillsSection(skills, {
    maxTokens: DEFAULT_SKILL_CATALOG_TOKEN_BUDGET,
    onDegrade: (report) =>
      log.warn("skills block exceeded its prompt budget", {
        ...report,
        omittedCount: report.omitted.length,
      }),
  })
  if (skillSection) {
    out.systemPrompt = out.systemPrompt
      ? `${out.systemPrompt}\n\n---\n\n${skillSection}`
      : skillSection
  }
  const skillTools = skills.flatMap((s) => s.allowedTools ?? [])
  if (skillTools.length > 0) {
    out.allowedTools = unionStrings(out.allowedTools, skillTools)
  }
  return out
}

// =============================================================================
// Workspace roots — confinement and the trust proof follow the lease
// =============================================================================

/**
 * Point workspace confinement at the directories the run actually works in.
 *
 * `resolveSendOptions` derives `confinement.roots` from the cwd and additional
 * directories it resolved (the source checkout). A scheduled run then moves
 * both: payload `additionalDirectories` are unioned on top, and a task lease
 * swaps cwd and additionalDirectories for bundle aliases. Without this, the
 * roots still name the source checkout. Every write in the alias then counts
 * as escaping the workspace and, with nobody there to approve it, ends the run
 * `needs_approval`, while writes into the source checkout the lease exists to
 * protect pass. Same derivation as build-options: cwd plus every additional
 * directory.
 */
function alignConfinementRoots(options: SendOptions): SendOptions {
  if (!options.confinement?.enabled) return options
  const roots = new Set<string>()
  if (options.cwd) roots.add(options.cwd)
  for (const dir of options.additionalDirectories ?? []) {
    if (dir) roots.add(dir)
  }
  if (roots.size === 0) {
    const { confinement: _dropped, ...rest } = options
    return rest
  }
  return { ...options, confinement: { ...options.confinement, roots: [...roots] } }
}

/**
 * Which source root each alias of a scheduled lease checks out, limited to the
 * aliases the lease actually made active.
 *
 * A borrowed canonical bundle was acquired over the owning workspace's roots,
 * one lease per root keyed by the root's id (`ensureSessionExecutionBundle`).
 * A scheduled writable bundle is acquired over the one bound root and answers
 * with it as the primary alias. A root this cannot place gets no alias, so its
 * grant does not travel.
 */
function leaseAliasesBySource(
  lease: { primaryAlias: string; additionalAliases: readonly string[] },
  source: {
    canonicalBundle: { leases: readonly { logicalRootId: string; aliasPath: string }[] } | null
    project: Project | null
    boundWorkspaceRoot: string
  }
): Map<string, string> {
  const aliases = new Map<string, string>()
  if (!source.canonicalBundle) {
    aliases.set(source.boundWorkspaceRoot.trim(), lease.primaryAlias)
    return aliases
  }
  const active = new Set([lease.primaryAlias, ...lease.additionalAliases])
  const aliasByRootId = new Map(
    source.canonicalBundle.leases.map((root) => [root.logicalRootId, root.aliasPath] as const)
  )
  for (const root of source.project?.roots ?? []) {
    const alias = aliasByRootId.get(root.id)
    if (alias && active.has(alias)) aliases.set(root.path.trim(), alias)
  }
  return aliases
}

/**
 * Carry the Workspace Trust proof onto the aliases a task lease runs in.
 *
 * `resolveSendOptions` stamps `trustedWorkspaceRoots` with the owning
 * workspace's source roots. The sidecar honours only a trusted root that is
 * also active for the send, so once a lease re-points cwd and
 * additionalDirectories at bundle aliases, the source paths prove nothing and
 * native SDK skills/plugins are refused. Each alias inherits the grant of the
 * exact source root it checks out, the rule the connector loop applies. An
 * alias whose source is not a trusted root stays unproven.
 */
function alignTrustedWorkspaceRoots(
  options: SendOptions,
  aliasesBySource: ReadonlyMap<string, string>
): SendOptions {
  if (!options.trustedWorkspaceRoots?.length) return options
  return {
    ...options,
    trustedWorkspaceRoots: remapExactRoots(options.trustedWorkspaceRoots, aliasesBySource),
  }
}

/**
 * The reason a scheduled run ended `needs_approval`: the tools the unattended
 * responder turned away, and the roots an untrusted workspace ran restricted
 * for. Restricted Mode removes its tools before the turn starts, so the model
 * never asks for them and no denial is recorded. The untrusted roots are the
 * only evidence the run did less than a trusted one would have.
 */
function scheduledNeedsApprovalSummary(
  permissions: UnattendedPermissionResponder,
  trust: ScheduledWorkspaceTrust
): string {
  if (!trust.restricted) return needsApprovalSummary(permissions)
  const roots = trust.untrustedRoots.length > 0 ? trust.untrustedRoots.join(", ") : null
  const restriction = trust.unverified
    ? `Workspace Trust could not be verified for ${roots ?? "the owning workspace"}, so the run had no disk or host-mutating tools`
    : `workspace not trusted (${roots ?? "the owning workspace"}), so the run had no disk or host-mutating tools`
  return `${needsApprovalSummary(permissions)}; ${restriction}`
}

/** The restriction a run carried, for its output: present only when it ran restricted. */
function workspaceTrustOutput(trust: ScheduledWorkspaceTrust): Record<string, unknown> {
  if (!trust.restricted) return {}
  return {
    workspaceTrust: {
      restricted: true,
      untrustedRoots: [...trust.untrustedRoots],
      ...(trust.unverified ? { unverified: true } : {}),
    },
  }
}

// =============================================================================
// Core chat-style runner — used by chat, agent, and skill executors
// =============================================================================

interface RunChatPromptOptions {
  characterId?: string
  skillId?: string
  signal?: AbortSignal
}

async function runChatPrompt(
  task: ScheduledTask,
  execution: TaskExecution,
  payload: ChatLikeTaskPayload,
  options: RunChatPromptOptions = {}
): Promise<ChatExecutionResult> {
  // Host gate: chat-style tasks drive a Claude turn through the sidecar. The
  // desktop and the headless brain both provide it; a plain browser does not.
  const refused = assertTaskTypeSupportedOnHost(task.type)
  if (refused) return refused

  if (!payload.prompt || !payload.prompt.trim()) {
    return { success: false, error: "Empty prompt" }
  }

  // 1. Resolve / create the session.
  const sessionResult = await resolveOrCreateSession(task, payload, {
    characterId: options.characterId,
    runId: execution.id,
  })
  if ("error" in sessionResult) {
    return { success: false, error: sessionResult.error }
  }
  const { session } = sessionResult
  const sessionId = session.id

  // 2. Pull AppSettings and resolve full SendOptions through the same
  // pipeline the interactive composer uses.
  let appSettings: AppSettings | null = null
  try {
    appSettings = await getSettings()
  } catch (err) {
    log.warn("Scheduler: getSettings failed; continuing with no app defaults", {
      err: String(err),
    })
  }

  const agentMode = resolveAgentMode(task.id, payload.agentModeId)

  // Splice the per-task disabled-skill list onto the session for this turn
  // only. resolveSendOptions reads `session.disabledSkillIds` directly, so a
  // synthetic clone is the cleanest seam.
  const sessionForResolution: ChatSession = payload.disabledSkillIds?.length
    ? {
        ...session,
        disabledSkillIds: unionStrings(session.disabledSkillIds, payload.disabledSkillIds),
      }
    : session

  // A schedule fires for the workspace that owns its conversation, which is
  // almost never the one the user happens to be looking at when it fires — and
  // often nothing is on screen at all. Resolving against the UI pointer here
  // would hand a cron job someone else's skills, servers and instructions. One
  // id answers both the capability scope and the send-time workspace, so the
  // two cannot attribute the run to different workspaces.
  // A conversation this run just created was stamped by `createSession`, which
  // falls back to the UI-active workspace when the task names none. The task is
  // the authority for that session: an unbound task has no owning workspace.
  const sessionProjectId = sessionResult.created ? task.projectId : session.projectId
  const owningProjectId = payload.executionContext?.projectId ?? sessionProjectId ?? null
  const capabilityScope: WorkspaceCapabilityScope = { projectId: owningProjectId }
  const owning = await loadOwningWorkspace(owningProjectId, { taskId: task.id })
  const activeProject = owning.project
  // Same gate, same workspace as an interactive turn: a schedule must not be
  // the way around Restricted Mode for a checkout the user never trusted.
  const workspaceTrust = await resolveScheduledWorkspaceTrust(owning, appSettings, {
    taskId: task.id,
  })

  let resolved: SendOptions
  try {
    resolved = await resolveSendOptions({
      // `resolveSendOptions` scopes skills, MCP servers, memory and RAG by
      // `session.projectId` first, so the session it reads must carry the
      // owning workspace, not the UI-active one `createSession` stamped.
      session: { ...sessionForResolution, projectId: owningProjectId ?? undefined },
      appSettings,
      agentMode,
      activeProject,
      workspaceRestricted: workspaceTrust.restricted,
      trustedWorkspaceRoots: workspaceTrust.trustedRoots,
    })
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // 3. Layer payload-level overrides on top.
  let finalOptions = await applyPayloadOverrides(resolved, payload, appSettings, capabilityScope)

  // 4. Skill-task ad-hoc skill: splice into system prompt + allowedTools.
  finalOptions = await applyAdHocSkill(finalOptions, options.skillId, capabilityScope)

  // The payload replaces `disallowedTools` and unions `allowedTools`, and the
  // ad-hoc skill unions its tools too. Either could hand back a tool Restricted
  // Mode removed, so the restriction is re-applied after every override.
  if (workspaceTrust.restricted) finalOptions = withRestrictedModeDenials(finalOptions)

  // Scheduled managed-worktree runs fail closed: unlike an interactive run,
  // there is nobody present to approve bypassing failed isolation/setup. The
  // durable workspaceKey binds subsequent schedule fires to the same chat
  // worktree while each execution still gets its own versioned TaskRun.
  // Real schedule producers persist the owning session id, not a second copy
  // of its execution binding. Prefer an explicit frozen payload context for
  // migrated rows, otherwise use the resolved session's canonical binding.
  const executionContext = payload.executionContext ?? session.executionContext
  const canonicalExecution = executionContext?.execution
  const canonicalManaged = canonicalExecution && canonicalExecution.mode !== "local"
  const canonicalBundle = canonicalManaged
    ? canonicalExecution.bundleId
      ? await getWorkspaceBundle(canonicalExecution.bundleId).catch(() => null)
      : null
    : null
  if (
    canonicalManaged &&
    (!canonicalBundle ||
      canonicalBundle.state !== "active" ||
      canonicalBundle.environmentKind === "imported")
  ) {
    return { success: false, error: "Scheduled workspace canonical bundle is unavailable" }
  }
  const canonicalPrimary = canonicalBundle?.leases.find((lease) => lease.role === "primary")
  const requestedRootIds = new Set(
    canonicalExecution?.roots.map((root) => root.logicalRootId) ?? []
  )
  const canonicalRootIds = new Set(
    canonicalBundle?.leases.map((lease) => lease.logicalRootId) ?? []
  )
  if (
    canonicalManaged &&
    (!canonicalPrimary ||
      requestedRootIds.size !== canonicalRootIds.size ||
      [...requestedRootIds].some((rootId) => !canonicalRootIds.has(rootId)))
  ) {
    return { success: false, error: "Scheduled workspace root leases are stale" }
  }
  const boundWorkspaceRoot = canonicalManaged
    ? canonicalPrimary!.aliasPath
    : executionContext
      ? resolveSessionWorkspaceRoot(executionContext)
      : undefined
  if (executionContext && !boundWorkspaceRoot) {
    return { success: false, error: "Scheduled workspace is missing on this device" }
  }
  const taskLeaseInput: BeginTaskWorkspaceTurn | null = executionContext
    ? {
        taskId: executionContext.taskWorkspace.taskId,
        sessionId,
        runId: `scheduled:${execution.id}`,
        agentId: "scheduler",
        agentKind: "scheduled-chat",
        workspaceRoot: boundWorkspaceRoot!,
        workspaceKey: executionContext.taskWorkspace.workspaceKey,
        base:
          executionContext.location === "managedWorktree" &&
          executionContext.baseRef &&
          executionContext.baseRef !== "HEAD"
            ? { kind: "gitRef", gitRef: executionContext.baseRef }
            : { kind: "workingState" },
        executionRunId: execution.id,
        surface: "scheduler",
      }
    : null
  const taskLease = taskLeaseInput
    ? canonicalManaged
      ? await openWorkspaceBundleTurnLease(
          canonicalBundle!,
          canonicalPrimary!.logicalRootId,
          taskLeaseInput
        )
      : await openScheduledWritableBundle(
          task,
          execution,
          boundWorkspaceRoot!,
          "scheduled-chat"
        ).catch(() => null)
    : null
  if (executionContext && !taskLease) {
    return { success: false, error: "Scheduled workspace isolation is unavailable" }
  }
  if (taskLease) {
    finalOptions = {
      ...finalOptions,
      cwd: taskLease.primaryAlias,
      additionalDirectories: taskLease.additionalAliases,
      taskWorkspace: {
        taskId: executionContext!.taskWorkspace.taskId,
        runId: taskLease.run.runId,
        workspaceRoot: boundWorkspaceRoot!,
        agentId: "scheduler",
        agentKind: "scheduled-chat",
      },
    }
  }
  // Last rewrite of cwd / additionalDirectories above: confinement follows it.
  finalOptions = alignConfinementRoots(finalOptions)
  // So does the trust proof, alias by alias.
  if (taskLease) {
    finalOptions = alignTrustedWorkspaceRoots(
      finalOptions,
      leaseAliasesBySource(taskLease, {
        canonicalBundle: canonicalManaged ? canonicalBundle : null,
        project: activeProject,
        boundWorkspaceRoot: boundWorkspaceRoot!,
      })
    )
  }

  if (executionContext?.environmentId) {
    const environment = await getProjectEnvironment(executionContext.environmentId)
    if (!environment || environment.projectId !== executionContext.projectId) {
      if (taskLease) await taskLease.settle("failed").catch(() => undefined)
      return { success: false, error: "Scheduled project environment is unavailable" }
    }
    // The repository's own `.cognia/workspace.json`, merged in when the user
    // has approved it. Resolved through the shared seam rather than inline, so
    // the trust gate cannot end up applied on one of the two run paths.
    const executionRoot = finalOptions.cwd ?? executionContext.projectRoot
    const resolved = await resolveEnvironmentForRun({
      environment,
      executionRoot,
      surface: "scheduled",
      ...(executionContext.projectId ? { projectId: executionContext.projectId } : {}),
    })
    const setup = await executeProjectEnvironment({
      environment: resolved.environment,
      executionRoot,
      scope: executionContext.location,
      surface: "scheduled",
    })
    if (!setup.success) {
      if (taskLease) await taskLease.settle("failed").catch(() => undefined)
      return { success: false, error: setup.error ?? "Scheduled project environment setup failed" }
    }
  }

  // 5. Subscribe FIRST, then send. The sidecar may emit `result` before the
  // returned promise is awaited if we don't.
  const collected: unknown[] = []
  let resolveOnce: (value: ChatExecutionResult) => void = () => undefined
  const finished = new Promise<ChatExecutionResult>((resolve) => {
    resolveOnce = resolve
  })

  // Nobody is watching a scheduled turn. A permission request is answered
  // here with a recorded denial, so the task ends `needs_approval` with the
  // tools named, instead of the desktop's silent auto-deny or the headless
  // brain's five-minute hang that surfaced as "timeout or cancellation".
  const permissions = createUnattendedPermissionResponder("scheduled task")
  const unlisten = await onClaudeMessage((evt: ClaudeEvent) => {
    if (
      (evt as { sessionId?: string }).sessionId &&
      (evt as { sessionId: string }).sessionId !== sessionId
    ) {
      return
    }
    collected.push(evt)
    const evtType = (evt as { type?: string }).type
    if (evtType === "permission_request") {
      const request = evt as { requestId?: string; toolName?: string }
      if (request.requestId && request.toolName) {
        const decision = permissions.onPermissionRequest({
          type: "permission_request",
          sessionId,
          requestId: request.requestId,
          toolUseID: (evt as { toolUseID?: string }).toolUseID ?? request.requestId,
          toolName: request.toolName,
          input: (evt as { input?: Record<string, unknown> }).input ?? {},
        })
        void approveTool(sessionId, request.requestId, decision.decision, decision.message).catch(
          (error) => log.warn("Scheduler unattended deny failed", { sessionId, error })
        )
      }
      return
    }
    if (evtType === "result") {
      // Only a turn that was actually refused something waits on a person. A
      // restricted run that asked for nothing did its (read-only) work and
      // completes, so a read-only schedule in a workspace nobody has trusted
      // yet is not failed and auto-paused on every fire. Its output still says
      // it ran restricted, and for which roots.
      if (permissions.needsApproval()) {
        resolveOnce({
          success: false,
          error: scheduledNeedsApprovalSummary(permissions, workspaceTrust),
          // Terminal: a retry re-runs the whole turn into the same wall.
          terminalReason: "needs-approval",
          output: {
            sessionId,
            events: collected.length,
            last: evt,
            status: "needs_approval",
            needsApproval: [...permissions.denials],
            ...workspaceTrustOutput(workspaceTrust),
          },
        })
        return
      }
      resolveOnce({
        success: true,
        output: {
          sessionId,
          events: collected.length,
          last: evt,
          ...workspaceTrustOutput(workspaceTrust),
        },
      })
    } else if (evtType === "error") {
      resolveOnce({
        success: false,
        error: (evt as { error?: string }).error ?? "Sidecar error",
        output: { sessionId, events: collected.length, last: evt },
      })
    }
  })

  const { signal } = options

  const abortHandler = () => {
    void interruptSession(sessionId).catch(() => undefined)
    resolveOnce({
      success: false,
      error: `Chat task aborted (timeout or cancellation)`,
      output: { sessionId, events: collected.length },
    })
  }

  if (signal?.aborted) {
    abortHandler()
    try {
      unlisten()
    } catch {
      /* */
    }
    return await finished
  }

  signal?.addEventListener("abort", abortHandler, { once: true })

  if (signal?.aborted) {
    abortHandler()
    try {
      unlisten()
    } catch {
      /* */
    }
    signal?.removeEventListener("abort", abortHandler)
    return await finished
  }

  try {
    log.info("Scheduler chat task → sendPrompt", {
      taskId: task.id,
      executionId: execution.id,
      sessionId,
      characterId: options.characterId,
      skillId: options.skillId,
      teamId: payload.teamId,
      agentModeId: payload.agentModeId,
    })
    await sendPrompt(sessionId, payload.prompt, finalOptions)
    const result = await finished
    if (taskLease) {
      await taskLease.settle(result.success ? "ready" : "failed").catch(() => undefined)
    }
    return result
  } catch (err) {
    if (taskLease) await taskLease.settle("failed").catch(() => undefined)
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    signal?.removeEventListener("abort", abortHandler)
    try {
      unlisten()
    } catch {
      /* listener already detached */
    }
  }
}

// =============================================================================
// Executor implementations
// =============================================================================

async function executeChatTask(
  task: ScheduledTask,
  execution: TaskExecution,
  signal: AbortSignal
): Promise<ChatExecutionResult> {
  const raw = (task.payload ?? {}) as Record<string, unknown>
  const payload = reconcileLegacyPromptFields(task.id, raw) as Partial<ChatLikeTaskPayload>
  if (!payload.prompt) return { success: false, error: "chat task requires `prompt` in payload" }
  return runChatPrompt(task, execution, payload as ChatLikeTaskPayload, { signal })
}

async function executeAgentTask(
  task: ScheduledTask,
  execution: TaskExecution,
  signal: AbortSignal
): Promise<ChatExecutionResult> {
  const raw = (task.payload ?? {}) as Record<string, unknown>
  const payload = reconcileLegacyPromptFields(task.id, raw) as Partial<AgentTaskPayload>
  if (!payload.prompt) return { success: false, error: "agent task requires `prompt` in payload" }
  if (!payload.characterId)
    return { success: false, error: "agent task requires `characterId` in payload" }
  let attemptId: string | undefined
  if (payload.agentTaskId) {
    try {
      const attempt = await beginAgentTaskAttempt(payload.agentTaskId, {
        sessionId: payload.sessionId,
        runId: execution.id,
      })
      attemptId = attempt.id
      await linkAgentTaskAttemptExecution(attempt.id, execution.id)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  try {
    const result = await runChatPrompt(task, execution, payload as AgentTaskPayload, {
      characterId: payload.characterId,
      signal,
    })
    if (attemptId) {
      await settleAgentTaskAttempt(attemptId, {
        status: result.success ? "completed" : "failed",
        result: result.output ? JSON.stringify(result.output) : undefined,
        errorCode: result.success ? undefined : "agent_execution_failed",
        errorMessage: result.error,
      })
    }
    return result
  } catch (error) {
    if (attemptId) {
      await settleAgentTaskAttempt(attemptId, {
        status: signal.aborted ? "cancelled" : "failed",
        errorCode: signal.aborted ? "agent_execution_cancelled" : "agent_execution_error",
        errorMessage: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined)
    }
    throw error
  }
}

async function executeSkillTask(
  task: ScheduledTask,
  execution: TaskExecution,
  signal: AbortSignal
): Promise<ChatExecutionResult> {
  const raw = (task.payload ?? {}) as Record<string, unknown>
  const payload = reconcileLegacyPromptFields(task.id, raw) as Partial<SkillTaskPayload>
  if (!payload.prompt) return { success: false, error: "skill task requires `prompt` in payload" }
  if (!payload.skillId) return { success: false, error: "skill task requires `skillId` in payload" }
  return runChatPrompt(task, execution, payload as SkillTaskPayload, {
    skillId: payload.skillId,
    signal,
  })
}

async function executeScriptTask(
  task: ScheduledTask,
  execution: TaskExecution,
  signal: AbortSignal
): Promise<ChatExecutionResult> {
  const payload = task.payload as
    | {
        language?: string
        code?: string
        working_dir?: string
        args?: string[]
        env?: Record<string, string>
        timeout_secs?: number
        memory_mb?: number
        use_sandbox?: boolean
      }
    | undefined

  const refused = assertTaskTypeSupportedOnHost(task.type)
  if (refused) return refused

  if (!payload?.language || !payload.code) {
    return { success: false, error: "script task requires `language` and `code` in payload" }
  }

  if (signal?.aborted) {
    return { success: false, error: "Script execution aborted before start" }
  }

  const workspaceLease = payload.working_dir
    ? await openScheduledWritableBundle(task, execution, payload.working_dir, "scheduled-script")
    : null
  let result: Awaited<ReturnType<typeof executeScript>>
  try {
    result = await executeScript(
      {
        type: "execute_script",
        language: payload.language,
        code: payload.code,
        working_dir: workspaceLease?.primaryAlias,
        args: payload.args,
        env: payload.env,
        timeout_secs: payload.timeout_secs ?? Math.floor((task.config.timeout || 300_000) / 1000),
        memory_mb: payload.memory_mb,
        use_sandbox: payload.use_sandbox,
      },
      { signal, taskId: task.id }
    )
  } catch (error) {
    await workspaceLease?.settle(signal.aborted ? "cancelled" : "failed").catch(() => undefined)
    throw error
  }
  if (signal?.aborted) {
    await workspaceLease?.settle("cancelled")
    return { success: false, error: "Script execution was cancelled" }
  }
  await workspaceLease?.settle(result.success ? "ready" : "failed")

  log.info("Scheduler script task complete", {
    taskId: task.id,
    executionId: execution.id,
    success: result.success,
  })

  return {
    success: result.success,
    output: {
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: result.duration_ms,
    },
    error: result.error,
  }
}

async function executeExternalAgentTask(
  task: ScheduledTask,
  execution: TaskExecution,
  signal: AbortSignal
): Promise<ChatExecutionResult> {
  const refused = assertTaskTypeSupportedOnHost(task.type)
  if (refused) return refused

  const payload = (task.payload ?? {}) as Partial<ExternalAgentTaskPayload>
  if (!payload.prompt || !payload.prompt.trim()) {
    return { success: false, error: "external-agent task requires `prompt` in payload" }
  }
  if (!payload.agentId || !payload.agentId.trim()) {
    return { success: false, error: "external-agent task requires `agentId` in payload" }
  }

  if (signal?.aborted) {
    return { success: false, error: "External agent task aborted" }
  }

  const timeout = payload.timeoutMs ?? task.config.timeout ?? 300_000
  let workspaceLease: Awaited<ReturnType<typeof openScheduledWritableBundle>> | null = null

  log.info("Scheduler external-agent task → executeOnExternalAgent", {
    taskId: task.id,
    executionId: execution.id,
    agentId: payload.agentId,
  })

  try {
    workspaceLease = payload.cwd
      ? await openScheduledWritableBundle(task, execution, payload.cwd, "scheduled-external-agent")
      : null
    const result = await executeOnExternalAgent(payload.prompt, {
      agentId: payload.agentId,
      permissionMode: payload.permissionMode,
      workingDirectory: workspaceLease?.primaryAlias,
      timeout,
    })

    if (!result) {
      await workspaceLease?.settle("failed")
      return {
        success: false,
        error: `No matching external agent for id: ${payload.agentId}`,
      }
    }

    await workspaceLease?.settle(result.success ? "ready" : "failed")

    return {
      success: result.success,
      output: {
        sessionId: result.sessionId,
        finalResponse: result.finalResponse,
        duration: result.duration,
        tokenUsage: result.tokenUsage,
        toolCalls: result.toolCalls,
      },
      error: result.error,
    }
  } catch (err) {
    await workspaceLease?.settle(signal.aborted ? "cancelled" : "failed").catch(() => undefined)
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The "custom" type is a hook for a user- or plugin-supplied executor
 * registered at runtime via `registerTaskExecutor("custom", fn)` — which
 * REPLACES this placeholder in the registry. If a custom task fires and
 * nothing has replaced it, the handler is genuinely missing (a plugin was
 * removed, or the task was imported from another install), so the run fails
 * with `EXECUTOR_NOT_FOUND` instead of reporting a silent green no-op.
 */
async function executeCustomTask(
  task: ScheduledTask,
  _execution: TaskExecution,
  _signal: AbortSignal
): Promise<ChatExecutionResult> {
  log.warn("Custom scheduled task fired without a registered custom executor", {
    taskId: task.id,
  })
  return {
    success: false,
    error:
      'No custom executor is registered for task type "custom" (a plugin or the app must call registerTaskExecutor("custom", …) before this task can run).',
    terminalReason: "executor-not-found",
  }
}

// =============================================================================
// Registration
// =============================================================================

/**
 * Typed against `BUILT_IN_EXECUTOR_TASK_TYPES`, the list the scheduler loads
 * this module for on demand (`../executor-owners.ts`): a type missing here, or
 * one the list does not name, does not compile.
 */
const BUILT_IN_EXECUTORS = {
  chat: executeChatTask,
  agent: executeAgentTask,
  skill: executeSkillTask,
  script: executeScriptTask,
  "background-command": executeBackgroundCommandTask,
  monitor: executeMonitorTask,
  plugin: executePluginTask,
  backup: executeBackupTask,
  custom: executeCustomTask,
  "external-agent": executeExternalAgentTask,
  twin: executeTwinTask,
  "wiki-rebuild": executeWikiRebuildTask,
  "wiki-lint": executeWikiLintTask,
  "github-issue-sync": executeGithubIssueSyncTask,
  "radar-report": executeRadarReportTask,
  "agent-team": executeAgentTeamTask,
  goal: executeGoalTask,
  plan: executePlanTask,
  bot: executeBotTask,
  test: executeTestTask,
  workflow: executeWorkflowTask,
  "im-push": executeImPushTask,
} satisfies Record<BuiltInExecutorTaskType, TaskExecutor>

let registered = false

/**
 * Register all built-in executors with the global task scheduler. Idempotent
 * — calling twice (e.g. from HMR, or `initSchedulerSystem` after the scheduler
 * already loaded this module for a due task) won't double-register.
 */
export function registerBuiltInExecutors(): void {
  if (registered) return
  registered = true

  for (const type of BUILT_IN_EXECUTOR_TASK_TYPES) {
    registerTaskExecutor(type, BUILT_IN_EXECUTORS[type])
  }

  log.info(`Built-in scheduler executors registered: ${BUILT_IN_EXECUTOR_TASK_TYPES.join(", ")}`)
}

export {
  executeChatTask,
  executeAgentTask,
  executeSkillTask,
  executeScriptTask,
  executeBackgroundCommandTask,
  executeMonitorTask,
  executeExternalAgentTask,
  executePluginTask,
  executeBackupTask,
  executeWikiRebuildTask,
  executeWikiLintTask,
  executeRadarReportTask,
  executeCustomTask,
  executeAgentTeamTask,
  executeGoalTask,
  executePlanTask,
  // Internal helpers exposed for unit testing.
  reconcileLegacyPromptFields,
  resolveAgentMode,
  applyPayloadOverrides,
  applyAdHocSkill,
  alignConfinementRoots,
}
