/**
 * Task executor registry for the app scheduler.
 *
 * Cognia ships a much wider executor set (workflow / sync / im-push /
 * ai-generation / test). cognia-next has no backing systems for those, so we
 * only register the executors that map to existing infrastructure here:
 *
 *   - chat            → drives a Claude session via lib/claude/ipc.sendPrompt,
 *                       feeding the SAME `resolveSendOptions` pipeline the
 *                       interactive composer uses (character / agent mode /
 *                       skills / allowed tools / MCP / built-in tools / …).
 *   - agent           → chat + bound character (a.k.a. agent persona).
 *   - skill           → chat + one ad-hoc skill on top of the character set.
 *   - external-agent  → drives an ACP agent (Claude Desktop, Cursor, …) via
 *                       lib/ai/agent/external/manager:executeOnExternalAgent.
 *   - script          → shells out via the existing shell_exec Tauri command.
 *   - backup          → builds & writes an encrypted backup to appDataDir()/backups/.
 *
 * Plus the two Cognia executors that don't depend on external systems:
 *
 *   - plugin          → routes to the registered plugin handler (no-op until
 *                       plugin runtime exists).
 *   - custom          → user-supplied executor registered at runtime.
 */

import type {
  AgentTaskPayload,
  ChatLikeTaskPayload,
  ExternalAgentTaskPayload,
  ScheduledTask,
  SkillTaskPayload,
  TaskExecution,
} from "@/types/scheduler"
import { registerTaskExecutor } from "../task-scheduler"
import { executePluginTask } from "./plugin-executor"
import { executeBackupTask } from "./backup-executor"
import { executeTwinTask } from "./twin-executor"
import { executeWikiRebuildTask } from "./wiki-rebuild-executor"
import { executeWikiLintTask } from "./wiki-lint-executor"
import { executeRadarReportTask } from "./radar-report-executor"
import { executeAgentTeamTask } from "./team-executor"
import { executeGoalTask } from "./goal-executor"
import { executePlanTask } from "./plan-executor"
import { executeScript } from "../script-executor"
import { sendPrompt, onClaudeMessage, interruptSession } from "@/lib/claude/ipc"
import type {
  AppSettings,
  BuiltinToolsConfig,
  ChatSession,
  ClaudeEvent,
  SendOptions,
} from "@/lib/claude/types"
import { createSession, getSession } from "@/lib/db/sessions"
import { getSettings } from "@/lib/db/settings"
import { listEnabledMcpServers, buildMcpServerMap } from "@/lib/db/mcp-servers"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { BUILT_IN_AGENT_MODES, type AgentModeConfig } from "@/types/agent/agent-mode"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { listEnabledSkillsByIds, renderSkillsSection } from "@/lib/db/skills"
import { executeOnExternalAgent } from "@/lib/ai/agent/external/manager"
import { loggers } from "@cognia/logging"
import { isTauri } from "@/lib/tauri"

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

interface ChatExecutionResult {
  success: boolean
  output?: Record<string, unknown>
  error?: string
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
  appSettings: AppSettings | null
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
      const enabled = await listEnabledMcpServers()
      const wanted = new Set(payload.mcpServerIds)
      const subset = enabled.filter((srv) => wanted.has(srv.id))
      if (subset.length > 0) {
        out.mcpServers = buildMcpServerMap(subset)
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
  options: { characterId?: string }
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
  skillId: string | undefined
): Promise<SendOptions> {
  if (!skillId) return base
  const skills = await listEnabledSkillsByIds([skillId])
  if (skills.length === 0) return base

  const out: SendOptions = { ...base }
  const skillSection = renderSkillsSection(skills)
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
  if (!isTauri()) {
    return { success: false, error: "Chat-style scheduled tasks require the Tauri runtime" }
  }

  if (!payload.prompt || !payload.prompt.trim()) {
    return { success: false, error: "Empty prompt" }
  }

  // 1. Resolve / create the session.
  const sessionResult = await resolveOrCreateSession(task, payload, {
    characterId: options.characterId,
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

  let resolved: SendOptions
  try {
    resolved = await resolveSendOptions({
      session: sessionForResolution,
      appSettings,
      agentMode,
    })
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // 3. Layer payload-level overrides on top.
  let finalOptions = await applyPayloadOverrides(resolved, payload, appSettings)

  // 4. Skill-task ad-hoc skill: splice into system prompt + allowedTools.
  finalOptions = await applyAdHocSkill(finalOptions, options.skillId)

  // 5. Subscribe FIRST, then send. The sidecar may emit `result` before the
  // returned promise is awaited if we don't.
  const collected: unknown[] = []
  let resolveOnce: (value: ChatExecutionResult) => void = () => undefined
  const finished = new Promise<ChatExecutionResult>((resolve) => {
    resolveOnce = resolve
  })

  const unlisten = await onClaudeMessage((evt: ClaudeEvent) => {
    if (
      (evt as { sessionId?: string }).sessionId &&
      (evt as { sessionId: string }).sessionId !== sessionId
    ) {
      return
    }
    collected.push(evt)
    const evtType = (evt as { type?: string }).type
    if (evtType === "result") {
      resolveOnce({
        success: true,
        output: { sessionId, events: collected.length, last: evt },
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
    return await finished
  } catch (err) {
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
  return runChatPrompt(task, execution, payload as AgentTaskPayload, {
    characterId: payload.characterId,
    signal,
  })
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

  if (!payload?.language || !payload.code) {
    return { success: false, error: "script task requires `language` and `code` in payload" }
  }

  if (signal?.aborted) {
    return { success: false, error: "Script execution aborted before start" }
  }

  const result = await executeScript({
    type: "execute_script",
    language: payload.language,
    code: payload.code,
    working_dir: payload.working_dir,
    args: payload.args,
    env: payload.env,
    timeout_secs: payload.timeout_secs ?? Math.floor((task.config.timeout || 300_000) / 1000),
    memory_mb: payload.memory_mb,
    use_sandbox: payload.use_sandbox,
  })

  if (signal?.aborted) {
    return { success: false, error: "Script execution was cancelled" }
  }

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

  log.info("Scheduler external-agent task → executeOnExternalAgent", {
    taskId: task.id,
    executionId: execution.id,
    agentId: payload.agentId,
  })

  try {
    const result = await executeOnExternalAgent(payload.prompt, {
      agentId: payload.agentId,
      permissionMode: payload.permissionMode,
      workingDirectory: payload.cwd,
      timeout,
    })

    if (!result) {
      return {
        success: false,
        error: `No matching external agent for id: ${payload.agentId}`,
      }
    }

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
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function executeCustomTask(
  task: ScheduledTask,
  _execution: TaskExecution,
  _signal: AbortSignal
): Promise<ChatExecutionResult> {
  // The "custom" type lets users write their own executor and register it via
  // `registerTaskExecutor("custom-<name>", fn)`. The default fall-through is
  // a friendly no-op so the scheduler doesn't blow up if a stale custom task
  // survives a deploy that removed its handler.
  log.warn("Custom scheduled task ran with the default no-op executor", { taskId: task.id })
  return { success: true, output: { note: "Custom executor not registered; ran as no-op." } }
}

// =============================================================================
// Registration
// =============================================================================

let registered = false

/**
 * Register all built-in executors with the global task scheduler. Idempotent
 * — calling twice (e.g. from HMR) won't double-register.
 */
export function registerBuiltInExecutors(): void {
  if (registered) return
  registered = true

  registerTaskExecutor("chat", executeChatTask)
  registerTaskExecutor("agent", executeAgentTask)
  registerTaskExecutor("skill", executeSkillTask)
  registerTaskExecutor("script", executeScriptTask)
  registerTaskExecutor("plugin", executePluginTask)
  registerTaskExecutor("backup", executeBackupTask)
  registerTaskExecutor("custom", executeCustomTask)
  registerTaskExecutor("external-agent", executeExternalAgentTask)
  registerTaskExecutor("twin", executeTwinTask)
  registerTaskExecutor("wiki-rebuild", executeWikiRebuildTask)
  registerTaskExecutor("wiki-lint", executeWikiLintTask)
  registerTaskExecutor("radar-report", executeRadarReportTask)
  registerTaskExecutor("agent-team", executeAgentTeamTask)
  registerTaskExecutor("goal", executeGoalTask)
  registerTaskExecutor("plan", executePlanTask)

  log.info(
    "Built-in scheduler executors registered: chat, agent, skill, script, plugin, backup, custom, external-agent, twin, wiki-rebuild, wiki-lint, radar-report, agent-team, goal, plan"
  )
}

export {
  executeChatTask,
  executeAgentTask,
  executeSkillTask,
  executeScriptTask,
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
}
