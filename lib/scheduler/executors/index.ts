/**
 * Task executor registry for the app scheduler.
 *
 * Cognia ships a much wider executor set (workflow / sync / im-push /
 * ai-generation / test). cognia-next has no backing systems for those, so we
 * only register the executors that map to existing infrastructure here:
 *
 *   - chat    → drives a Claude session via lib/claude/ipc.sendPrompt
 *   - agent   → starts a Claude session pre-bound to a character (a.k.a. agent persona)
 *   - skill   → starts a Claude session with a skill enabled
 *   - script  → shells out via the existing shell_exec Tauri command
 *   - backup  → builds & writes an encrypted backup to appDataDir()/backups/
 *
 * Plus the two Cognia executors that don't depend on external systems:
 *
 *   - plugin  → routes to the registered plugin handler (no-op until plugin runtime exists)
 *   - custom  → user-supplied executor registered at runtime
 */

import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import { registerTaskExecutor } from "../task-scheduler"
import { executePluginTask } from "./plugin-executor"
import { executeBackupTask } from "./backup-executor"
import { executeScript } from "../script-executor"
import { sendPrompt } from "@/lib/claude/ipc"
import { onClaudeMessage } from "@/lib/claude/ipc"
import type { ClaudeEvent } from "@/lib/claude/types"
import { createSession } from "@/lib/db/sessions"
import { loggers } from "@/lib/logger"
import { isTauri } from "@/lib/tauri"

const log = loggers.scheduler

// =============================================================================
// Chat / Agent / Skill payloads
// =============================================================================

/**
 * Payload for `chat` task type — drives a one-off Claude completion. The
 * scheduler creates a fresh session by default so each run is isolated; pass
 * an explicit `sessionId` to append to an existing thread instead.
 */
export interface ChatTaskPayload {
  prompt: string
  sessionId?: string
  /** Title used when the executor creates a new session for this run */
  sessionTitle?: string
  /** Optional Claude model override */
  model?: string
}

/** Payload for `agent` task type — a chat task bound to a specific character. */
export interface AgentTaskPayload extends ChatTaskPayload {
  characterId: string
}

/** Payload for `skill` task type — a chat task that activates a single skill. */
export interface SkillTaskPayload extends ChatTaskPayload {
  skillId: string
}

// =============================================================================
// Common helpers
// =============================================================================

interface ChatExecutionResult {
  success: boolean
  output?: Record<string, unknown>
  error?: string
}

/**
 * Send a prompt and resolve once the sidecar emits a terminal event for that
 * session (success → `result`, failure → `error`). The caller-supplied
 * `timeoutMs` bounds the wait; the sidecar otherwise streams forever. We
 * subscribe before sending to avoid a race where the result lands before the
 * listener attaches.
 */
async function runChatPrompt(
  task: ScheduledTask,
  execution: TaskExecution,
  payload: ChatTaskPayload,
  options: { characterId?: string; skillId?: string } = {}
): Promise<ChatExecutionResult> {
  if (!isTauri()) {
    return { success: false, error: "Chat-style scheduled tasks require the Tauri runtime" }
  }

  if (!payload.prompt || !payload.prompt.trim()) {
    return { success: false, error: "Empty prompt" }
  }

  const sessionId =
    payload.sessionId ??
    (
      await createSession({
        title: payload.sessionTitle ?? `${task.name} (scheduled)`,
        kind: "direct",
        characterId: options.characterId,
        model: payload.model,
      })
    ).id

  // Subscribe FIRST, then send. The sidecar may emit `result` before the
  // promise we return is awaited if we don't.
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
    if ((evt as { type?: string }).type === "result") {
      resolveOnce({
        success: true,
        output: { sessionId, events: collected.length, last: evt },
      })
    } else if ((evt as { type?: string }).type === "error") {
      resolveOnce({
        success: false,
        error: (evt as { error?: string }).error ?? "Sidecar error",
        output: { sessionId, events: collected.length, last: evt },
      })
    }
  })

  const timeoutMs = task.config.timeout || 300_000
  const timer = new Promise<ChatExecutionResult>((resolve) => {
    setTimeout(() => {
      resolve({
        success: false,
        error: `Chat task exceeded timeout (${timeoutMs}ms)`,
        output: { sessionId, events: collected.length },
      })
    }, timeoutMs)
  })

  try {
    log.info("Scheduler chat task → sendPrompt", {
      taskId: task.id,
      executionId: execution.id,
      sessionId,
      skillId: options.skillId,
    })
    await sendPrompt(sessionId, payload.prompt)
    return await Promise.race([finished, timer])
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
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
  execution: TaskExecution
): Promise<ChatExecutionResult> {
  const payload = (task.payload ?? {}) as Partial<ChatTaskPayload>
  if (!payload.prompt) return { success: false, error: "chat task requires `prompt` in payload" }
  return runChatPrompt(task, execution, payload as ChatTaskPayload)
}

async function executeAgentTask(
  task: ScheduledTask,
  execution: TaskExecution
): Promise<ChatExecutionResult> {
  const payload = (task.payload ?? {}) as Partial<AgentTaskPayload>
  if (!payload.prompt) return { success: false, error: "agent task requires `prompt` in payload" }
  if (!payload.characterId)
    return { success: false, error: "agent task requires `characterId` in payload" }
  return runChatPrompt(task, execution, payload as AgentTaskPayload, {
    characterId: payload.characterId,
  })
}

async function executeSkillTask(
  task: ScheduledTask,
  execution: TaskExecution
): Promise<ChatExecutionResult> {
  const payload = (task.payload ?? {}) as Partial<SkillTaskPayload>
  if (!payload.prompt) return { success: false, error: "skill task requires `prompt` in payload" }
  if (!payload.skillId) return { success: false, error: "skill task requires `skillId` in payload" }
  return runChatPrompt(task, execution, payload as SkillTaskPayload, {
    skillId: payload.skillId,
  })
}

async function executeScriptTask(
  task: ScheduledTask,
  execution: TaskExecution
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

async function executeCustomTask(task: ScheduledTask): Promise<ChatExecutionResult> {
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

  log.info(
    "Built-in scheduler executors registered: chat, agent, skill, script, plugin, backup, custom"
  )
}

export {
  executeChatTask,
  executeAgentTask,
  executeSkillTask,
  executeScriptTask,
  executePluginTask,
  executeBackupTask,
  executeCustomTask,
}
