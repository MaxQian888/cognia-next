/**
 * External-agent hook bridge.
 *
 * External agents (claude-code / codex / opencode) are parsed entirely in TS —
 * the Rust `external_agent` module is a pure stdio pass-through — so this module
 * reaches the shared settings.json hook runtime (System B) through the
 * `run_agent_hook` Tauri command, and fires the in-process plugin hooks
 * (System A) directly. It is wired into BOTH manager execution seams:
 *   - `executeStreaming` (interactive): blocking PreToolUse truly suppresses the
 *     permission event via `continue`.
 *   - `execute` (headless plugin runs): the deny is still enforced through
 *     `respondToPermission`; there is no permission UI to suppress.
 *
 * Every call here is best-effort: a broken or absent hook bridge (web/mobile,
 * IPC error) must never break agent execution.
 */

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import { createLogger } from "@/lib/logging"
import type {
  ExternalAgentEvent,
  ExternalAgentPermissionRequestEvent,
} from "@/types/agent/external-agent"

const log = createLogger("agent.external.hooks")

/** Mirror of the Rust `HookDecisionDto`. */
export interface AgentHookDecision {
  block?: string | null
  additionalContext?: string | null
  warnings: string[]
}

/** Context threaded through one external-agent execution for hook firing. */
export interface AgentHookContext {
  agentId: string
  sessionId: string
  cwd?: string
}

/**
 * Call the Rust settings.json hook runtime for one external-agent lifecycle
 * event. Returns null on web/mobile or any bridge error.
 */
export async function fireAgentHook(
  event: string,
  ctx: AgentHookContext,
  opts?: { toolName?: string; payload?: Record<string, unknown> }
): Promise<AgentHookDecision | null> {
  if (!isTauri()) return null
  try {
    return await invoke<AgentHookDecision>("run_agent_hook", {
      event,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd ?? null,
      toolName: opts?.toolName ?? null,
      payload: opts?.payload ?? null,
    })
  } catch (e) {
    log.warn("run_agent_hook_failed", { event, error: String(e) })
    return null
  }
}

/**
 * Fire the observational hooks for one event — the System-A plugin hooks
 * (`onExternalAgentToolCall`) and the System-B settings hooks (SessionStart,
 * PostToolUse/Failure, Stop, SessionEnd, StopFailure). Never throws.
 */
export function observeExternalAgentEvent(ctx: AgentHookContext, event: ExternalAgentEvent): void {
  const plugin = getPluginEventHooks()
  switch (event.type) {
    case "session_start":
      void fireAgentHook("SessionStart", ctx)
      break
    case "tool_use_start":
      plugin.dispatchExternalAgentToolCall(
        ctx.agentId,
        ctx.sessionId,
        event.toolName,
        event.rawInput ?? {}
      )
      break
    case "tool_result": {
      const failed = event.isError === true
      void fireAgentHook(failed ? "PostToolUseFailure" : "PostToolUse", ctx, {
        toolName: event.toolName ?? "unknown",
        payload: {
          tool_name: event.toolName ?? "unknown",
          tool_use_id: event.toolUseId,
          is_error: failed,
          tool_response: event.result,
        },
      })
      break
    }
    case "done":
      void fireAgentHook("Stop", ctx, { payload: { success: event.success } })
      void fireAgentHook("SessionEnd", ctx)
      break
    case "error":
      void fireAgentHook("StopFailure", ctx, { payload: { error: event.error } })
      break
    default:
      break
  }
}

/**
 * Permission gate for an external-agent tool call. Fires the observational
 * permission hooks, runs the blocking `PreToolUse` hook, and — when a hook
 * blocks — denies the permission through `deny`. Returns true when blocked so
 * the streaming caller can suppress the event.
 */
export async function gateExternalAgentPermission(
  ctx: AgentHookContext,
  event: ExternalAgentPermissionRequestEvent,
  deny: (requestId: string, reason: string) => Promise<void>
): Promise<boolean> {
  const req = event.request
  const toolName = req.toolInfo?.name ?? "unknown"
  const requestId = req.requestId ?? req.id
  const toolInput = req.rawInput ?? {}

  getPluginEventHooks().dispatchExternalAgentPermissionRequest(
    ctx.agentId,
    ctx.sessionId,
    toolName,
    req.reason
  )
  void fireAgentHook("PermissionRequest", ctx, {
    toolName,
    payload: { tool_name: toolName, tool_input: toolInput },
  })

  const decision = await fireAgentHook("PreToolUse", ctx, {
    toolName,
    payload: { tool_name: toolName, tool_input: toolInput },
  })

  if (decision?.block) {
    try {
      await deny(requestId, decision.block)
    } catch (e) {
      log.warn("permission_deny_failed", { agentId: ctx.agentId, error: String(e) })
    }
    void fireAgentHook("PermissionDenied", ctx, {
      toolName,
      payload: { tool_name: toolName, reason: decision.block },
    })
    return true
  }
  return false
}
