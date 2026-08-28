/**
 * Plugin Hooks System - Unified hook management
 *
 * Two hook managers cover the live needs:
 * - PluginLifecycleHooks: Core plugin lifecycle and event hooks
 * - PluginEventHooks: Application event integration hooks
 *
 * (A generic middleware/caching `HookDispatcher` framework once lived here but
 * was never instantiated outside tests; removed 2026-06-10.)
 */

import type {
  PluginHooks,
  PluginUpdateInfo,
  PluginA2UIAction,
  PluginA2UIDataChange,
  PluginAgentStep,
  PluginMessage,
  PluginTeamStartPayload,
  PluginTeamPlanReadyPayload,
  PluginTeammateClaimPayload,
  PluginTeammateReleasePayload,
  PluginTeamBudgetWarnPayload,
  PluginTeamCompletePayload,
  PluginConsensusOpenedPayload,
  PluginConsensusVotedPayload,
  PluginConsensusResolvedPayload,
  PluginSharedMemoryWritePayload,
  PluginSharedMemoryDeletePayload,
  PluginTeamDelegationStartPayload,
  PluginTeamDelegationCompletePayload,
  PluginCommandContext,
  PluginCommandResult,
} from "@/types/plugin"
import type { A2UISurfaceType } from "@/types/artifact/a2ui"
import { usePluginStore } from "@/stores/plugin-runtime"
import {
  getPluginHookContribution,
  listEnabledHookPlugins,
  listHookContributors,
  listRegisteredHookPlugins,
  __resetHookRegistryForTesting,
  registerPluginHookContribution,
  unregisterPluginHookContribution,
} from "@/lib/plugin/registries/hook-registry"
import { loggers } from "../core/logger"
import type {
  PluginHooksAll,
  HookSandboxExecutionResult,
  PluginTerminalSpawnRequest,
  PluginTerminalSpawnDecision,
  PluginTerminalLifecycleEvent,
  GoalHookPayload,
  ShareLinkHookPayload,
  ConnectorHookDecision,
  ConnectorInboundHookPayload,
  ConnectorOutboundHookPayload,
  PetInteractHookPayload,
  PetLevelUpHookPayload,
  PetEvolvedHookPayload,
  PetAchievementUnlockedHookPayload,
  PetUnwellHookPayload,
} from "@/types/plugin/plugin-hooks"
import type { Project, KnowledgeFile } from "@/types/plugin/_compat"
import type { Artifact } from "@/types/artifact/artifact"
import type { PluginCanvasDocument } from "@/types/plugin/plugin"
import { emitFinishedSpan } from "@cognia/agent-trace/emitter"

// =============================================================================
// Plugin hook failure telemetry
// =============================================================================

/** A single captured plugin-hook failure, surfaced in the Settings panel. */
export interface PluginHookErrorRecord {
  pluginId: string
  hookName: string
  message: string
  at: number
}

const PLUGIN_HOOK_ERROR_BUFFER_CAP = 256
const pluginHookErrors: PluginHookErrorRecord[] = []

/**
 * Record a plugin-hook failure into a bounded ring buffer. Called from the
 * isolated per-plugin try/catch in `dispatchTeamHook` so one misbehaving
 * plugin's errors are observable without crashing the team runtime.
 */
export function recordPluginHookError(pluginId: string, hookName: string, error: unknown): void {
  pluginHookErrors.push({
    pluginId,
    hookName,
    message: error instanceof Error ? error.message : String(error),
    at: Date.now(),
  })
  if (pluginHookErrors.length > PLUGIN_HOOK_ERROR_BUFFER_CAP) {
    pluginHookErrors.splice(0, pluginHookErrors.length - PLUGIN_HOOK_ERROR_BUFFER_CAP)
  }
}

/** Snapshot of recent plugin-hook failures (newest last). */
export function getRecentPluginHookErrors(): readonly PluginHookErrorRecord[] {
  return [...pluginHookErrors]
}

/** Test-only: clear the captured plugin-hook failure buffer. */
export function __resetPluginHookErrorsForTesting(): void {
  pluginHookErrors.length = 0
}

/** Pull a sessionId out of a hook payload when one is present. Every team
 * payload type carries it under one of `sessionId` / `chatSessionId` /
 * `id` (consensus events). Returns undefined for hooks with no chat scope. */
function extractSessionIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const p = payload as Record<string, unknown>
  const candidates = [p.sessionId, p.chatSessionId]
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c
  }
  return undefined
}

/**
 * Emit a finished agent-trace span for a single plugin-hook handler run.
 * Caller measures duration themselves (the team-hook dispatcher already
 * runs handlers inside `queueMicrotask`, so start/end pairing here would
 * fight the fire-and-forget model). On failure, also routes through
 * `recordPluginHookError` to keep the legacy ring buffer populated.
 *
 * `sessionId` defaults to `"plugin-runtime"` for hooks that aren't bound to
 * a chat session (lifecycle hooks, theme hooks, etc.). Caller can pass a
 * concrete sessionId when one is available (team / agent / message hooks).
 */
export function recordPluginHookEvent(args: {
  pluginId: string
  hookName: string
  startTime: number
  durationMs: number
  sessionId?: string
  error?: unknown
}): void {
  if (args.error) {
    recordPluginHookError(args.pluginId, args.hookName, args.error)
  }
  try {
    emitFinishedSpan({
      operationName: "execute_tool",
      providerName: "cognia.plugin",
      sessionId: args.sessionId ?? "plugin-runtime",
      surface: "plugin-hook",
      toolName: args.hookName,
      pluginId: args.pluginId,
      startTime: args.startTime,
      durationMs: Math.max(0, args.durationMs),
      errorType: args.error ? "plugin_hook_error" : undefined,
      errorMessage: args.error
        ? args.error instanceof Error
          ? args.error.message
          : String(args.error)
        : undefined,
    })
  } catch {
    // emit is best-effort; never break the host loop
  }
}

// =============================================================================
// Unified Types
// =============================================================================

/**
 * Unified priority system for hook execution order
 */
export enum HookPriority {
  CRITICAL = 100, // Execute first
  HIGH = 75, // High priority
  NORMAL = 50, // Default
  LOW = 25, // Low priority
  DEFERRED = 0, // Execute last
}

/** Convert legacy priority values to unified enum */
export function normalizePriority(priority: number | string): HookPriority {
  if (typeof priority === "number") {
    if (priority >= 100) return HookPriority.CRITICAL
    if (priority >= 75) return HookPriority.HIGH
    if (priority >= 50) return HookPriority.NORMAL
    if (priority >= 25) return HookPriority.LOW
    return HookPriority.DEFERRED
  }

  const normalized = String(priority).toLowerCase()
  switch (normalized) {
    case "highest":
    case "critical":
      return HookPriority.CRITICAL
    case "high":
      return HookPriority.HIGH
    case "normal":
      return HookPriority.NORMAL
    case "low":
      return HookPriority.LOW
    case "lowest":
    case "deferred":
      return HookPriority.DEFERRED
    default:
      return HookPriority.NORMAL
  }
}

/** Convert unified enum to legacy priority value */
export function priorityToNumber(priority: HookPriority): number {
  return priority
}

/** Convert unified enum to legacy string value */
export function priorityToString(priority: HookPriority): string {
  switch (priority) {
    case HookPriority.CRITICAL:
      return "high"
    case HookPriority.HIGH:
      return "high"
    case HookPriority.NORMAL:
      return "normal"
    case HookPriority.LOW:
      return "low"
    case HookPriority.DEFERRED:
      return "low"
    default:
      return "normal"
  }
}

// Re-export HookSandboxExecutionResult from types
export type { HookSandboxExecutionResult } from "@/types/plugin/plugin-hooks"

// =============================================================================
// PluginLifecycleHooks - Core Plugin Lifecycle Management
// =============================================================================

interface RegisteredHooks {
  pluginId: string
  hooks: PluginHooks
  priority: number
}

type HookName = keyof PluginHooks

/**
 * Core plugin lifecycle hooks manager.
 *
 * Handles plugin lifecycle events (onLoad, onEnable, onDisable, onUnload),
 * A2UI surface events, agent execution events, message pipeline,
 * session events, and command handling.
 */
export class PluginLifecycleHooks {
  // ===========================================================================
  // Registration
  //
  // Storage lives in `lib/plugin/registries/hook-registry.ts`. It used to be a
  // class-private Map here while `PluginEventHooks` read the Zustand store —
  // two stores, written together but read apart, with two different liveness
  // rules. One registry now backs both dispatchers.
  // ===========================================================================

  registerHooks(pluginId: string, hooks: PluginHooks, priority: number = 0): void {
    registerPluginHookContribution(pluginId, hooks as PluginHooksAll, priority)
  }

  unregisterHooks(pluginId: string): void {
    unregisterPluginHookContribution(pluginId)
  }

  /** One plugin's registered hooks, ignoring enablement. */
  private registered(pluginId: string): RegisteredHooks | undefined {
    const entry = getPluginHookContribution(pluginId)
    if (!entry) return undefined
    return { pluginId, hooks: entry.hooks as PluginHooks, priority: entry.priority }
  }

  /**
   * Enabled plugins in priority order. Previously an eagerly-maintained array
   * with NO enabled filter, so a disabled plugin kept receiving every fan-out
   * hook until it was fully unloaded. The explicit per-plugin dispatchers
   * (`dispatchOnDisable` and friends) deliberately go through `registered()`
   * instead, which ignores enablement — a plugin must still receive its own
   * disable hook.
   */
  private get hookExecutionOrder(): string[] {
    return listEnabledHookPlugins()
  }

  // ===========================================================================
  // Hook Dispatchers - Lifecycle
  // ===========================================================================

  async dispatchOnLoad(pluginId: string): Promise<void> {
    const registered = this.registered(pluginId)
    if (registered?.hooks.onLoad) {
      await registered.hooks.onLoad()
    }
  }

  async dispatchOnEnable(pluginId: string): Promise<void> {
    const registered = this.registered(pluginId)
    if (registered?.hooks.onEnable) {
      await registered.hooks.onEnable()
    }
  }

  async dispatchOnDisable(pluginId: string): Promise<void> {
    const registered = this.registered(pluginId)
    if (registered?.hooks.onDisable) {
      await registered.hooks.onDisable()
    }
  }

  async dispatchOnUnload(pluginId: string): Promise<void> {
    const registered = this.registered(pluginId)
    if (registered?.hooks.onUnload) {
      await registered.hooks.onUnload()
    }
  }

  async dispatchOnInstall(pluginId: string): Promise<void> {
    const registered = this.registered(pluginId)
    if (registered?.hooks.onInstall) {
      await registered.hooks.onInstall()
    }
  }

  async dispatchOnUninstall(pluginId: string): Promise<void> {
    const registered = this.registered(pluginId)
    if (registered?.hooks.onUninstall) {
      await registered.hooks.onUninstall()
    }
  }

  async dispatchOnUpdate(pluginId: string, info: PluginUpdateInfo): Promise<void> {
    const registered = this.registered(pluginId)
    if (registered?.hooks.onUpdate) {
      await registered.hooks.onUpdate(info)
    }
  }

  async dispatchOnSuspend(pluginId: string): Promise<void> {
    const registered = this.registered(pluginId)
    if (registered?.hooks.onSuspend) {
      await registered.hooks.onSuspend()
    }
  }

  async dispatchOnResume(pluginId: string): Promise<void> {
    const registered = this.registered(pluginId)
    if (registered?.hooks.onResume) {
      await registered.hooks.onResume()
    }
  }

  dispatchOnConfigChange(pluginId: string, config: Record<string, unknown>): void {
    const registered = this.registered(pluginId)
    if (registered?.hooks.onConfigChange) {
      registered.hooks.onConfigChange(config)
    }
  }

  // ===========================================================================
  // Hook Dispatchers - A2UI
  // ===========================================================================

  dispatchOnA2UISurfaceCreate(surfaceId: string, type: A2UISurfaceType): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onA2UISurfaceCreate) {
        try {
          registered.hooks.onA2UISurfaceCreate(surfaceId, type)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onA2UISurfaceCreate:`, error)
        }
      }
    }
  }

  dispatchOnA2UISurfaceDestroy(surfaceId: string): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onA2UISurfaceDestroy) {
        try {
          registered.hooks.onA2UISurfaceDestroy(surfaceId)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onA2UISurfaceDestroy:`, error)
        }
      }
    }
  }

  async dispatchOnA2UIAction(action: PluginA2UIAction): Promise<void> {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onA2UIAction) {
        try {
          await registered.hooks.onA2UIAction(action)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onA2UIAction:`, error)
        }
      }
    }
  }

  dispatchOnA2UIDataChange(change: PluginA2UIDataChange): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onA2UIDataChange) {
        try {
          registered.hooks.onA2UIDataChange(change)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onA2UIDataChange:`, error)
        }
      }
    }
  }

  // ===========================================================================
  // Hook Dispatchers - Agent
  // ===========================================================================

  dispatchOnAgentStart(agentId: string, config: Record<string, unknown>): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onAgentStart) {
        try {
          registered.hooks.onAgentStart(agentId, config)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onAgentStart:`, error)
        }
      }
    }
  }

  dispatchOnAgentStep(agentId: string, step: PluginAgentStep): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onAgentStep) {
        try {
          registered.hooks.onAgentStep(agentId, step)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onAgentStep:`, error)
        }
      }
    }
  }

  async dispatchOnAgentToolCall(agentId: string, tool: string, args: unknown): Promise<unknown> {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onAgentToolCall) {
        try {
          const result = await registered.hooks.onAgentToolCall(agentId, tool, args)
          if (result !== undefined) {
            return result
          }
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onAgentToolCall:`, error)
        }
      }
    }
    return undefined
  }

  dispatchOnAgentComplete(agentId: string, result: unknown): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onAgentComplete) {
        try {
          registered.hooks.onAgentComplete(agentId, result)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onAgentComplete:`, error)
        }
      }
    }
  }

  dispatchOnAgentError(agentId: string, error: Error): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onAgentError) {
        try {
          registered.hooks.onAgentError(agentId, error)
        } catch (err) {
          loggers.hooks.error(`Error in plugin ${pluginId} onAgentError:`, err)
        }
      }
    }
  }

  // ===========================================================================
  // Hook Dispatchers - Agent Team (lib/ai/agent/agent-team-runtime.ts)
  // ===========================================================================

  /**
   * Generic helper used by all team-context hooks. Each dispatcher below
   * narrows the hook handler signature to its specific payload type — this
   * keeps the per-hook code one-liner-thin while preserving type safety.
   *
   * Team hooks are fire-and-forget: each plugin's handler runs in its own
   * `queueMicrotask` so (a) the runtime path that fired the hook never blocks
   * on a slow plugin, and (b) a handler side-effect (e.g. a Zustand setState)
   * can't synchronously re-enter the dispatcher. Each handler is isolated in
   * its own try/catch — one throwing plugin never starves the others, and the
   * failure is recorded for the Settings "recent plugin failures" panel.
   */
  private dispatchTeamHook<K extends keyof PluginHooks>(
    name: K,
    payload: Parameters<NonNullable<PluginHooks[K]>>[0]
  ): void {
    const sessionId = extractSessionIdFromPayload(payload)
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      const handler = registered?.hooks[name] as ((p: typeof payload) => void) | undefined
      if (!handler) continue
      queueMicrotask(() => {
        const startTime = Date.now()
        let caught: unknown
        try {
          handler(payload)
        } catch (error) {
          caught = error
          loggers.hooks.error(`Error in plugin ${pluginId} ${name}:`, error)
        }
        recordPluginHookEvent({
          pluginId,
          hookName: String(name),
          startTime,
          durationMs: Date.now() - startTime,
          sessionId,
          error: caught,
        })
      })
    }
  }

  dispatchOnTeamStart(payload: PluginTeamStartPayload): void {
    this.dispatchTeamHook("onTeamStart", payload)
  }

  dispatchOnTeamPlanReady(payload: PluginTeamPlanReadyPayload): void {
    this.dispatchTeamHook("onTeamPlanReady", payload)
  }

  dispatchOnTeammateClaim(payload: PluginTeammateClaimPayload): void {
    this.dispatchTeamHook("onTeammateClaim", payload)
  }

  dispatchOnTeammateRelease(payload: PluginTeammateReleasePayload): void {
    this.dispatchTeamHook("onTeammateRelease", payload)
  }

  dispatchOnTeamBudgetWarn(payload: PluginTeamBudgetWarnPayload): void {
    this.dispatchTeamHook("onTeamBudgetWarn", payload)
  }

  dispatchOnTeamComplete(payload: PluginTeamCompletePayload): void {
    this.dispatchTeamHook("onTeamComplete", payload)
  }

  dispatchOnConsensusOpened(payload: PluginConsensusOpenedPayload): void {
    this.dispatchTeamHook("onConsensusOpened", payload)
  }

  dispatchOnConsensusVoted(payload: PluginConsensusVotedPayload): void {
    this.dispatchTeamHook("onConsensusVoted", payload)
  }

  dispatchOnConsensusResolved(payload: PluginConsensusResolvedPayload): void {
    this.dispatchTeamHook("onConsensusResolved", payload)
  }

  dispatchOnSharedMemoryWrite(payload: PluginSharedMemoryWritePayload): void {
    this.dispatchTeamHook("onSharedMemoryWrite", payload)
  }

  dispatchOnSharedMemoryDelete(payload: PluginSharedMemoryDeletePayload): void {
    this.dispatchTeamHook("onSharedMemoryDelete", payload)
  }

  dispatchOnTeamDelegationStart(payload: PluginTeamDelegationStartPayload): void {
    this.dispatchTeamHook("onTeamDelegationStart", payload)
  }

  dispatchOnTeamDelegationComplete(payload: PluginTeamDelegationCompletePayload): void {
    this.dispatchTeamHook("onTeamDelegationComplete", payload)
  }

  // ===========================================================================
  // Hook Dispatchers - Message (Pipeline style)
  // ===========================================================================

  async dispatchOnMessageSend(message: PluginMessage): Promise<PluginMessage> {
    let currentMessage = message

    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onMessageSend) {
        try {
          currentMessage = await registered.hooks.onMessageSend(currentMessage)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onMessageSend:`, error)
        }
      }
    }

    return currentMessage
  }

  async dispatchOnMessageReceive(message: PluginMessage): Promise<PluginMessage> {
    let currentMessage = message

    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onMessageReceive) {
        try {
          currentMessage = await registered.hooks.onMessageReceive(currentMessage)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onMessageReceive:`, error)
        }
      }
    }

    return currentMessage
  }

  dispatchOnMessageRender(message: PluginMessage): React.ReactNode | null {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onMessageRender) {
        try {
          const result = registered.hooks.onMessageRender(message)
          if (result !== null) {
            return result
          }
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onMessageRender:`, error)
        }
      }
    }
    return null
  }

  // ===========================================================================
  // Hook Dispatchers - Session
  // ===========================================================================

  dispatchOnSessionCreate(sessionId: string): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onSessionCreate) {
        try {
          registered.hooks.onSessionCreate(sessionId)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onSessionCreate:`, error)
        }
      }
    }
  }

  dispatchOnSessionSwitch(sessionId: string): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onSessionSwitch) {
        try {
          registered.hooks.onSessionSwitch(sessionId)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onSessionSwitch:`, error)
        }
      }
    }
  }

  dispatchOnSessionDelete(sessionId: string): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onSessionDelete) {
        try {
          registered.hooks.onSessionDelete(sessionId)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onSessionDelete:`, error)
        }
      }
    }
  }

  // ===========================================================================
  // Hook Dispatchers - Message Lifecycle
  // ===========================================================================

  dispatchOnMessageDelete(messageId: string, sessionId: string): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onMessageDelete) {
        try {
          registered.hooks.onMessageDelete(messageId, sessionId)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onMessageDelete:`, error)
        }
      }
    }
  }

  dispatchOnMessageEdit(
    messageId: string,
    oldContent: string,
    newContent: string,
    sessionId: string
  ): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onMessageEdit) {
        try {
          registered.hooks.onMessageEdit(messageId, oldContent, newContent, sessionId)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onMessageEdit:`, error)
        }
      }
    }
  }

  // ===========================================================================
  // Hook Dispatchers - Session Lifecycle (Extended)
  // ===========================================================================

  dispatchOnSessionRename(sessionId: string, oldTitle: string, newTitle: string): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onSessionRename) {
        try {
          registered.hooks.onSessionRename(sessionId, oldTitle, newTitle)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onSessionRename:`, error)
        }
      }
    }
  }

  dispatchOnSessionClear(sessionId: string): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onSessionClear) {
        try {
          registered.hooks.onSessionClear(sessionId)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onSessionClear:`, error)
        }
      }
    }
  }

  // ===========================================================================
  // Hook Dispatchers - Chat Flow
  // ===========================================================================

  dispatchOnChatRegenerate(messageId: string, sessionId: string): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onChatRegenerate) {
        try {
          registered.hooks.onChatRegenerate(messageId, sessionId)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onChatRegenerate:`, error)
        }
      }
    }
  }

  dispatchOnModelSwitch(
    provider: string,
    model: string,
    previousProvider?: string,
    previousModel?: string
  ): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onModelSwitch) {
        try {
          registered.hooks.onModelSwitch(provider, model, previousProvider, previousModel)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onModelSwitch:`, error)
        }
      }
    }
  }

  dispatchOnChatModeSwitch(sessionId: string, newMode: string, previousMode: string): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onChatModeSwitch) {
        try {
          registered.hooks.onChatModeSwitch(sessionId, newMode, previousMode)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onChatModeSwitch:`, error)
        }
      }
    }
  }

  dispatchOnSystemPromptChange(
    sessionId: string,
    newPrompt: string,
    previousPrompt?: string
  ): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onSystemPromptChange) {
        try {
          registered.hooks.onSystemPromptChange(sessionId, newPrompt, previousPrompt)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onSystemPromptChange:`, error)
        }
      }
    }
  }

  // ===========================================================================
  // Hook Dispatchers - Agent Plan
  // ===========================================================================

  dispatchOnAgentPlanCreate(agentId: string, tasks: { id: string; description: string }[]): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onAgentPlanCreate) {
        try {
          registered.hooks.onAgentPlanCreate(agentId, tasks)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onAgentPlanCreate:`, error)
        }
      }
    }
  }

  dispatchOnAgentPlanStepComplete(
    agentId: string,
    taskId: string,
    result: string,
    success: boolean
  ): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onAgentPlanStepComplete) {
        try {
          registered.hooks.onAgentPlanStepComplete(agentId, taskId, result, success)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onAgentPlanStepComplete:`, error)
        }
      }
    }
  }

  // ===========================================================================
  // Hook Dispatchers - Scheduler
  // ===========================================================================

  dispatchOnScheduledTaskStart(taskId: string, executionId: string): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onScheduledTaskStart) {
        try {
          registered.hooks.onScheduledTaskStart(taskId, executionId)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onScheduledTaskStart:`, error)
        }
      }
    }
  }

  dispatchOnScheduledTaskComplete(
    taskId: string,
    executionId: string,
    result: { success: boolean; output?: Record<string, unknown>; error?: string }
  ): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onScheduledTaskComplete) {
        try {
          registered.hooks.onScheduledTaskComplete(taskId, executionId, result)
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onScheduledTaskComplete:`, error)
        }
      }
    }
  }

  dispatchOnScheduledTaskError(taskId: string, executionId: string, error: Error): void {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onScheduledTaskError) {
        try {
          registered.hooks.onScheduledTaskError(taskId, executionId, error)
        } catch (error: unknown) {
          loggers.hooks.error(`Error in plugin ${pluginId} onScheduledTaskError:`, error)
        }
      }
    }
  }

  // ===========================================================================
  // Hook Dispatchers - Command
  // ===========================================================================

  /**
   * Offer a command to every registered handler in hook order and return the
   * first structured acceptance, or `null` when nobody handled it.
   *
   * Two handler contracts coexist. The legacy one returns `true`, which
   * normalizes to a bare `{ handled: true }` and leaves the host to write the
   * generic response line. The current one returns a {@link PluginCommandResult}
   * whose `message` becomes the command's actual chat response — that is what
   * lets a command answer with its own content instead of a toast plus a
   * placeholder. Declining (`false` / `{ handled: false }`) keeps the search
   * going, so a plugin can inspect the arguments and pass.
   */
  async dispatchOnCommand(
    command: string,
    args: string[],
    context?: PluginCommandContext
  ): Promise<PluginCommandResult | null> {
    for (const pluginId of this.hookExecutionOrder) {
      const registered = this.registered(pluginId)
      if (registered?.hooks.onCommand) {
        try {
          const outcome = await registered.hooks.onCommand(command, args, context)
          if (outcome === true) return { handled: true }
          if (outcome && typeof outcome === "object" && outcome.handled) return outcome
        } catch (error) {
          loggers.hooks.error(`Error in plugin ${pluginId} onCommand:`, error)
        }
      }
    }
    return null
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  hasHook(pluginId: string, hookName: HookName): boolean {
    const registered = this.registered(pluginId)
    return registered?.hooks[hookName] !== undefined
  }

  /**
   * Cheap existence check: does ANY registered plugin contribute `hookName`?
   * Powers the adapter-hooks no-listener fast path so dispatch is skipped when
   * no plugin is wired. Distinct from the per-plugin `hasHook(pluginId, …)`.
   */
  hasAnyHook(hookName: HookName): boolean {
    return listHookContributors(hookName as keyof PluginHooksAll).length > 0
  }

  getPluginsWithHook(hookName: HookName): string[] {
    return listHookContributors(hookName as keyof PluginHooksAll)
  }

  getRegisteredPlugins(): string[] {
    return listRegisteredHookPlugins()
  }

  /**
   * Hook names a plugin has actually registered (a non-undefined handler).
   * Powers the detail pane's "Capabilities → Hooks" enumeration so users can
   * see which lifecycle hooks a plugin contributes, not just filter by them.
   */
  getHooksByPlugin(pluginId: string): string[] {
    const registered = this.registered(pluginId)
    if (!registered) return []
    return Object.keys(registered.hooks).filter(
      (name) => registered.hooks[name as HookName] !== undefined
    )
  }

  clear(): void {
    __resetHookRegistryForTesting()
  }
}

// =============================================================================
// PluginEventHooks - Application Event Integration
// =============================================================================

/**
 * Application event hooks manager.
 *
 * Handles integration with application events including projects,
 * canvas, artifacts, export, theme, AI/chat, vector/RAG, workflows, and UI.
 */
export class PluginEventHooks {
  private hookPriorities: Map<string, Map<string, HookPriority>> = new Map()

  // ===========================================================================
  // Priority Management
  // ===========================================================================

  setPriority(pluginId: string, hookName: string, priority: HookPriority | string): void {
    const normalized = normalizePriority(priority)
    if (!this.hookPriorities.has(pluginId)) {
      this.hookPriorities.set(pluginId, new Map())
    }
    this.hookPriorities.get(pluginId)!.set(hookName, normalized)
  }

  getPriority(pluginId: string, hookName: string): HookPriority {
    return this.hookPriorities.get(pluginId)?.get(hookName) || HookPriority.NORMAL
  }

  /**
   * Get all plugins with hooks sorted by priority
   */
  private getPluginsByPriority(hookName: keyof PluginHooksAll): string[] {
    // Reads the SAME registry `PluginLifecycleHooks` writes to. This used to
    // read the Zustand plugin store directly while the other dispatcher read a
    // class-private Map, so the two could disagree about which plugins were
    // live. `listHookContributors` already applies the shared enabled rule and
    // orders by registration priority; the per-hook overrides recorded via
    // `setPriority` are layered on top of that here.
    const contributors = listHookContributors(hookName)
    return contributors
      .map((id) => ({ id, priority: this.getPriority(id, hookName) }))
      .sort((a, b) => {
        const byPriority = priorityToNumber(b.priority) - priorityToNumber(a.priority)
        return byPriority !== 0
          ? byPriority
          : contributors.indexOf(a.id) - contributors.indexOf(b.id)
      })
      .map((p) => p.id)
  }

  /**
   * Cheap existence check: is there at least one ENABLED plugin contributing
   * `hookName`? Reuses `getPluginsByPriority` so the enabled-only + has-handler
   * filter stays identical to the dispatch path. Powers the adapter-hooks
   * no-listener fast path.
   */
  hasAnyHook(hookName: keyof PluginHooksAll): boolean {
    return this.getPluginsByPriority(hookName).length > 0
  }

  /** Default timeout for hook execution in milliseconds */
  private static readonly HOOK_TIMEOUT_MS = 10_000

  /**
   * Execute a hook on all plugins with timeout protection
   */
  private async executeHook<T>(
    hookName: keyof PluginHooksAll,
    executor: (hooks: PluginHooksAll, pluginId: string) => T | Promise<T>,
    timeoutMs: number = PluginEventHooks.HOOK_TIMEOUT_MS
  ): Promise<HookSandboxExecutionResult<T>[]> {
    const store = usePluginStore.getState()
    const pluginIds = this.getPluginsByPriority(hookName)
    const results: HookSandboxExecutionResult<T>[] = []

    for (const pluginId of pluginIds) {
      const plugin = store.plugins[pluginId]
      if (!plugin || plugin.status !== "enabled" || !plugin.hooks) continue

      const startTime = performance.now()
      // The timeout timer must be cleared on the fast path (W3.7): per-chunk
      // dispatchers (dispatchStreamChunk) call executeHook thousands of times
      // per stream, and an uncleared racer both leaks a pending timer per call
      // and rejects into the void later.
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      try {
        const hookPromise = Promise.resolve(executor(plugin.hooks as PluginHooksAll, pluginId))
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () =>
              reject(
                new Error(`Hook ${hookName} timed out after ${timeoutMs}ms for plugin ${pluginId}`)
              ),
            timeoutMs
          )
        })
        const result = await Promise.race([hookPromise, timeoutPromise])
        results.push({
          success: true,
          result,
          pluginId,
          executionTime: performance.now() - startTime,
          duration: performance.now() - startTime,
          skipped: false,
        })
      } catch (error) {
        loggers.hooks.error(`Error in ${hookName} for plugin ${pluginId}:`, error)
        results.push({
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
          pluginId,
          executionTime: performance.now() - startTime,
          duration: performance.now() - startTime,
          skipped: false,
        })
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      }
    }

    return results
  }

  // =============================================================================
  // Project Hooks
  // =============================================================================

  async dispatchProjectCreate(project: Project) {
    return this.executeHook("onProjectCreate", (hooks) => hooks.onProjectCreate?.(project))
  }

  async dispatchProjectUpdate(project: Project, changes: Partial<Project>) {
    return this.executeHook("onProjectUpdate", (hooks) => hooks.onProjectUpdate?.(project, changes))
  }

  async dispatchProjectDelete(projectId: string) {
    return this.executeHook("onProjectDelete", (hooks) => hooks.onProjectDelete?.(projectId))
  }

  dispatchProjectSwitch(projectId: string | null, previousProjectId: string | null) {
    this.executeHook("onProjectSwitch", (hooks) =>
      hooks.onProjectSwitch?.(projectId, previousProjectId)
    )
  }

  async dispatchGoalCreate(goal: GoalHookPayload) {
    return this.executeHook("onGoalCreate", (hooks) => hooks.onGoalCreate?.(goal))
  }

  async dispatchGoalUpdate(goal: GoalHookPayload) {
    return this.executeHook("onGoalUpdate", (hooks) => hooks.onGoalUpdate?.(goal))
  }

  async dispatchGoalProgress(goal: GoalHookPayload) {
    return this.executeHook("onGoalProgress", (hooks) => hooks.onGoalProgress?.(goal))
  }

  async dispatchGoalComplete(goal: GoalHookPayload) {
    return this.executeHook("onGoalComplete", (hooks) => hooks.onGoalComplete?.(goal))
  }

  async dispatchGoalDelete(goalId: string) {
    return this.executeHook("onGoalDelete", (hooks) => hooks.onGoalDelete?.(goalId))
  }

  async dispatchPetInteract(payload: PetInteractHookPayload) {
    return this.executeHook("onPetInteract", (hooks) => hooks.onPetInteract?.(payload))
  }

  async dispatchPetLevelUp(payload: PetLevelUpHookPayload) {
    return this.executeHook("onPetLevelUp", (hooks) => hooks.onPetLevelUp?.(payload))
  }

  async dispatchPetEvolved(payload: PetEvolvedHookPayload) {
    return this.executeHook("onPetEvolved", (hooks) => hooks.onPetEvolved?.(payload))
  }

  async dispatchPetAchievementUnlocked(payload: PetAchievementUnlockedHookPayload) {
    return this.executeHook("onPetAchievementUnlocked", (hooks) =>
      hooks.onPetAchievementUnlocked?.(payload)
    )
  }

  async dispatchPetUnwell(payload: PetUnwellHookPayload) {
    return this.executeHook("onPetUnwell", (hooks) => hooks.onPetUnwell?.(payload))
  }

  async dispatchShareLinkCreate(link: ShareLinkHookPayload) {
    return this.executeHook("onShareLinkCreate", (hooks) => hooks.onShareLinkCreate?.(link))
  }

  async dispatchShareLinkRevoke(code: string) {
    return this.executeHook("onShareLinkRevoke", (hooks) => hooks.onShareLinkRevoke?.(code))
  }

  async dispatchKnowledgeFileAdd(projectId: string, file: KnowledgeFile) {
    return this.executeHook("onKnowledgeFileAdd", (hooks) =>
      hooks.onKnowledgeFileAdd?.(projectId, file)
    )
  }

  dispatchKnowledgeFileRemove(projectId: string, fileId: string) {
    this.executeHook("onKnowledgeFileRemove", (hooks) =>
      hooks.onKnowledgeFileRemove?.(projectId, fileId)
    )
  }

  // =============================================================================
  // Canvas Hooks
  // =============================================================================

  async dispatchCanvasCreate(document: PluginCanvasDocument) {
    return this.executeHook("onCanvasCreate", (hooks) => hooks.onCanvasCreate?.(document))
  }

  dispatchCanvasUpdate(document: PluginCanvasDocument, changes: Partial<PluginCanvasDocument>) {
    this.executeHook("onCanvasUpdate", (hooks) => hooks.onCanvasUpdate?.(document, changes))
  }

  dispatchCanvasDelete(documentId: string) {
    this.executeHook("onCanvasDelete", (hooks) => hooks.onCanvasDelete?.(documentId))
  }

  dispatchCanvasSwitch(documentId: string | null) {
    this.executeHook("onCanvasSwitch", (hooks) => hooks.onCanvasSwitch?.(documentId))
  }

  dispatchCanvasContentChange(documentId: string, content: string, previousContent: string) {
    this.executeHook("onCanvasContentChange", (hooks) =>
      hooks.onCanvasContentChange?.(documentId, content, previousContent)
    )
  }

  // =============================================================================
  // Artifact Hooks
  // =============================================================================

  async dispatchArtifactCreate(artifact: Artifact) {
    return this.executeHook("onArtifactCreate", (hooks) => hooks.onArtifactCreate?.(artifact))
  }

  dispatchArtifactUpdate(artifact: Artifact, changes: Partial<Artifact>) {
    this.executeHook("onArtifactUpdate", (hooks) => hooks.onArtifactUpdate?.(artifact, changes))
  }

  dispatchArtifactDelete(artifactId: string) {
    this.executeHook("onArtifactDelete", (hooks) => hooks.onArtifactDelete?.(artifactId))
  }

  dispatchArtifactOpen(artifactId: string) {
    this.executeHook("onArtifactOpen", (hooks) => hooks.onArtifactOpen?.(artifactId))
  }

  dispatchArtifactClose() {
    this.executeHook("onArtifactClose", (hooks) => hooks.onArtifactClose?.())
  }

  // =============================================================================
  // Export Hooks
  // =============================================================================

  async dispatchExportStart(sessionId: string, format: string) {
    return this.executeHook("onExportStart", (hooks) => hooks.onExportStart?.(sessionId, format))
  }

  dispatchExportComplete(sessionId: string, format: string, success: boolean) {
    this.executeHook("onExportComplete", (hooks) =>
      hooks.onExportComplete?.(sessionId, format, success)
    )
  }

  async dispatchExportTransform(content: string, format: string): Promise<string> {
    const results = await this.executeHook("onExportTransform", async (hooks) => {
      if (hooks.onExportTransform) {
        return hooks.onExportTransform(content, format)
      }
      return content
    })

    let transformed = content
    for (const result of results) {
      if (result.success && typeof result.result === "string") {
        transformed = result.result
      }
    }
    return transformed
  }

  // =============================================================================
  // Theme Hooks
  // =============================================================================

  dispatchThemeModeChange(mode: "light" | "dark" | "system", resolvedMode: "light" | "dark") {
    this.executeHook("onThemeModeChange", (hooks) => hooks.onThemeModeChange?.(mode, resolvedMode))
  }

  dispatchColorPresetChange(preset: string) {
    this.executeHook("onColorPresetChange", (hooks) => hooks.onColorPresetChange?.(preset))
  }

  // =============================================================================
  // AI/Chat Hooks
  // =============================================================================

  async dispatchChatRequest(messages: PluginMessage[], model: string): Promise<PluginMessage[]> {
    const results = await this.executeHook("onChatRequest", async (hooks) => {
      if (hooks.onChatRequest) {
        return hooks.onChatRequest(messages, model)
      }
      return messages
    })

    for (let i = results.length - 1; i >= 0; i--) {
      if (results[i].success && Array.isArray(results[i].result)) {
        return results[i].result as PluginMessage[]
      }
    }
    return messages
  }

  /**
   * ADR-0026 §4 §B — transform-pipeline dispatch for `onBuildOptions`.
   *
   * Plugins return a (partial) replacement of the structural
   * `BuildOptionsHookInput`. The dispatcher applies a shallow per-field
   * merge in plugin priority order. Returning `undefined` (no return) is
   * treated as "no change."
   *
   * Errors / timeouts in any single plugin are swallowed (`executeHook`
   * already isolates failures); the chain proceeds with the previous
   * value. This sits below the around-style `chat.middleware` runner —
   * use `onBuildOptions` for option tweaks, the runner for control flow.
   */
  async dispatchBuildOptions(
    options: import("@/types/plugin/plugin-hooks").BuildOptionsHookInput
  ): Promise<import("@/types/plugin/plugin-hooks").BuildOptionsHookInput> {
    const results = await this.executeHook("onBuildOptions", async (hooks) => {
      if ((hooks as import("@/types/plugin/plugin-hooks").PluginHooksAll).onBuildOptions) {
        return (hooks as import("@/types/plugin/plugin-hooks").PluginHooksAll).onBuildOptions!(
          options
        )
      }
      return undefined
    })

    let merged = options
    for (const result of results) {
      if (!result.success || !result.result) continue
      // Shallow merge per-field. Plugins can omit fields to leave them
      // untouched; explicit `undefined` returns are filtered out so a
      // forgotten field can't accidentally null-out a host-set value.
      const patch = result.result as Partial<typeof options>
      const next: typeof merged = { ...merged }
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) {
          ;(next as unknown as Record<string, unknown>)[key] = value
        }
      }
      merged = next
    }
    return merged
  }

  dispatchStreamStart(sessionId: string) {
    this.executeHook("onStreamStart", (hooks) => hooks.onStreamStart?.(sessionId))
  }

  dispatchStreamChunk(sessionId: string, chunk: string, fullContent: string) {
    this.executeHook("onStreamChunk", (hooks) =>
      hooks.onStreamChunk?.(sessionId, chunk, fullContent)
    )
  }

  dispatchStreamEnd(sessionId: string, finalContent: string) {
    this.executeHook("onStreamEnd", (hooks) => hooks.onStreamEnd?.(sessionId, finalContent))
  }

  dispatchChatError(sessionId: string, error: Error) {
    this.executeHook("onChatError", (hooks) => hooks.onChatError?.(sessionId, error))
  }

  dispatchTokenUsage(
    sessionId: string,
    usage: { prompt: number; completion: number; total: number }
  ) {
    this.executeHook("onTokenUsage", (hooks) => hooks.onTokenUsage?.(sessionId, usage))
  }

  // =============================================================================
  // AI/Chat Hooks - Enhanced (Pre/Post Operations)
  // =============================================================================

  /**
   * Dispatch user prompt submit hook - allows plugins to modify or block prompts
   */
  async dispatchUserPromptSubmit(
    prompt: string,
    sessionId: string,
    context: import("@/types/plugin/plugin-hooks").PromptSubmitContext
  ): Promise<import("@/types/plugin/plugin-hooks").PromptSubmitResult> {
    const results = await this.executeHook("onUserPromptSubmit", async (hooks) => {
      if (hooks.onUserPromptSubmit) {
        return hooks.onUserPromptSubmit(prompt, sessionId, context)
      }
      return { action: "proceed" as const }
    })

    // Check for block or modify actions (first one wins)
    for (const result of results) {
      if (result.success && result.result && result.result.action !== "proceed") {
        return result.result
      }
    }
    return { action: "proceed" }
  }

  /**
   * Dispatch pre-tool-use hook - allows plugins to modify or deny tool calls
   */
  async dispatchPreToolUse(
    toolName: string,
    toolArgs: unknown,
    sessionId: string
  ): Promise<import("@/types/plugin/plugin-hooks").PreToolUseResult> {
    const results = await this.executeHook("onPreToolUse", async (hooks) => {
      if (hooks.onPreToolUse) {
        return hooks.onPreToolUse(toolName, toolArgs, sessionId)
      }
      return { action: "allow" as const }
    })

    // Check for deny or modify actions (first one wins)
    for (const result of results) {
      if (result.success && result.result && result.result.action !== "allow") {
        return result.result
      }
    }
    return { action: "allow" }
  }

  /**
   * Dispatch post-tool-use hook - allows plugins to modify tool results
   */
  async dispatchPostToolUse(
    toolName: string,
    toolArgs: unknown,
    toolResult: unknown,
    sessionId: string
  ): Promise<import("@/types/plugin/plugin-hooks").PostToolUseResult> {
    const results = await this.executeHook("onPostToolUse", async (hooks) => {
      if (hooks.onPostToolUse) {
        return hooks.onPostToolUse(toolName, toolArgs, toolResult, sessionId)
      }
      return {}
    })

    // Merge all modifications
    const finalResult: import("@/types/plugin/plugin-hooks").PostToolUseResult = {}
    for (const result of results) {
      if (result.success && result.result) {
        if (result.result.modifiedResult !== undefined) {
          finalResult.modifiedResult = result.result.modifiedResult
        }
        if (result.result.additionalMessages) {
          finalResult.additionalMessages = [
            ...(finalResult.additionalMessages || []),
            ...result.result.additionalMessages,
          ]
        }
      }
    }
    return finalResult
  }

  /**
   * Dispatch pre-compact hook - allows plugins to customize context compression.
   *
   * NOTE: this dispatcher is part of the public plugin `onPreCompact` API
   * surface but is not yet wired into a live compaction trigger. The Anthropic
   * path self-manages compaction inside the Agent SDK, and the generic
   * (AI-SDK) path summarizes in the sidecar, which cannot call back into `lib/`
   * (`types/plugin/plugin-compaction-strategy.ts:11-14`). Kept for contract
   * parity (mirrored in the Python `PluginHook.ON_PRE_COMPACT` enum and guarded
   * by `runtime-proof-audit.test.ts`).
   */
  async dispatchPreCompact(
    context: import("@/types/plugin/plugin-hooks").PreCompactContext
  ): Promise<import("@/types/plugin/plugin-hooks").PreCompactResult> {
    const results = await this.executeHook("onPreCompact", async (hooks) => {
      if (hooks.onPreCompact) {
        return hooks.onPreCompact(context)
      }
      return {}
    })

    // Merge all results
    const finalResult: import("@/types/plugin/plugin-hooks").PreCompactResult = {}
    for (const result of results) {
      if (result.success && result.result) {
        if (result.result.skipCompaction) {
          finalResult.skipCompaction = true
        }
        if (result.result.contextToInject) {
          finalResult.contextToInject = finalResult.contextToInject
            ? `${finalResult.contextToInject}\n${result.result.contextToInject}`
            : result.result.contextToInject
        }
        if (result.result.customStrategy) {
          finalResult.customStrategy = result.result.customStrategy
        }
      }
    }
    return finalResult
  }

  /**
   * Dispatch post-chat-receive hook - allows plugins to process AI responses
   */
  async dispatchPostChatReceive(
    response: import("@/types/plugin/plugin-hooks").ChatResponseData
  ): Promise<import("@/types/plugin/plugin-hooks").PostChatReceiveResult> {
    const results = await this.executeHook("onPostChatReceive", async (hooks) => {
      if (hooks.onPostChatReceive) {
        return hooks.onPostChatReceive(response)
      }
      return {}
    })

    // Merge all results
    const finalResult: import("@/types/plugin/plugin-hooks").PostChatReceiveResult = {}
    for (const result of results) {
      if (result.success && result.result) {
        if (result.result.modifiedContent !== undefined) {
          finalResult.modifiedContent = result.result.modifiedContent
        }
        if (result.result.additionalMessages) {
          finalResult.additionalMessages = [
            ...(finalResult.additionalMessages || []),
            ...result.result.additionalMessages,
          ]
        }
        if (result.result.metadata) {
          finalResult.metadata = { ...(finalResult.metadata || {}), ...result.result.metadata }
        }
      }
    }
    return finalResult
  }

  // =============================================================================
  // Vector/RAG Hooks
  // =============================================================================

  dispatchDocumentsIndexed(collection: string, count: number) {
    this.executeHook("onDocumentsIndexed", (hooks) => hooks.onDocumentsIndexed?.(collection, count))
  }

  dispatchVectorSearch(collection: string, query: string, resultCount: number) {
    this.executeHook("onVectorSearch", (hooks) =>
      hooks.onVectorSearch?.(collection, query, resultCount)
    )
  }

  dispatchRAGContextRetrieved(
    sessionId: string,
    sources: { id: string; content: string; score: number }[]
  ) {
    this.executeHook("onRAGContextRetrieved", (hooks) =>
      hooks.onRAGContextRetrieved?.(sessionId, sources)
    )
  }

  // =============================================================================
  // Workflow Hooks
  // =============================================================================

  dispatchWorkflowStart(workflowId: string, name: string) {
    this.executeHook("onWorkflowStart", (hooks) => hooks.onWorkflowStart?.(workflowId, name))
  }

  dispatchWorkflowStepComplete(workflowId: string, stepIndex: number, result: unknown) {
    this.executeHook("onWorkflowStepComplete", (hooks) =>
      hooks.onWorkflowStepComplete?.(workflowId, stepIndex, result)
    )
  }

  dispatchWorkflowComplete(workflowId: string, success: boolean, result?: unknown) {
    this.executeHook("onWorkflowComplete", (hooks) =>
      hooks.onWorkflowComplete?.(workflowId, success, result)
    )
  }

  dispatchWorkflowError(workflowId: string, error: Error) {
    this.executeHook("onWorkflowError", (hooks) => hooks.onWorkflowError?.(workflowId, error))
  }

  dispatchWorkflowNodeStart(workflowId: string, nodeId: string, nodeType: string) {
    this.executeHook("onWorkflowNodeStart", (hooks) =>
      hooks.onWorkflowNodeStart?.(workflowId, nodeId, nodeType)
    )
  }

  dispatchWorkflowNodeComplete(
    workflowId: string,
    nodeId: string,
    nodeType: string,
    output: unknown
  ) {
    this.executeHook("onWorkflowNodeComplete", (hooks) =>
      hooks.onWorkflowNodeComplete?.(workflowId, nodeId, nodeType, output)
    )
  }

  dispatchWorkflowNodeError(workflowId: string, nodeId: string, error: Error) {
    this.executeHook("onWorkflowNodeError", (hooks) =>
      hooks.onWorkflowNodeError?.(workflowId, nodeId, error)
    )
  }

  dispatchWorkflowTriggerFired(workflowId: string, triggerKind: string, payload: unknown) {
    this.executeHook("onWorkflowTriggerFired", (hooks) =>
      hooks.onWorkflowTriggerFired?.(workflowId, triggerKind, payload)
    )
  }

  // =============================================================================
  // UI Hooks
  // =============================================================================

  dispatchSidebarToggle(visible: boolean) {
    this.executeHook("onSidebarToggle", (hooks) => hooks.onSidebarToggle?.(visible))
  }

  dispatchPanelOpen(panelId: string) {
    this.executeHook("onPanelOpen", (hooks) => hooks.onPanelOpen?.(panelId))
  }

  dispatchPanelClose(panelId: string) {
    this.executeHook("onPanelClose", (hooks) => hooks.onPanelClose?.(panelId))
  }

  async dispatchShortcut(shortcut: string): Promise<boolean> {
    const results = await this.executeHook("onShortcut", (hooks) => hooks.onShortcut?.(shortcut))

    return results.some((r) => r.success && r.result === true)
  }

  // =============================================================================
  // Terminal Hooks (plan: vscode-vivid-wilkinson)
  // =============================================================================

  /**
   * Pre-spawn veto/modify gate for the integrated terminal dock.
   *
   * Each subscribed plugin sees the (possibly already-mutated) request
   * and returns a decision. The first `"deny"` short-circuits. Mutations
   * chain. `"allow"`, `void`, and undefined are equivalent. Hook errors
   * and timeouts default to `"allow"` so a buggy plugin never wedges the
   * dock.
   */
  async dispatchTerminalWillSpawn(
    initial: PluginTerminalSpawnRequest
  ): Promise<{ decision: "allow" | "deny"; req: PluginTerminalSpawnRequest }> {
    let req = { ...initial }
    const results = await this.executeHook("onTerminalWillSpawn", (hooks) =>
      hooks.onTerminalWillSpawn?.(req)
    )
    for (const r of results) {
      if (!r.success) continue
      const value = r.result as PluginTerminalSpawnDecision | undefined
      if (value === undefined || value === "allow") continue
      if (value === "deny") {
        return { decision: "deny", req }
      }
      // Mutation — the plugin returned a fresh request shape. Subsequent
      // plugins (within this same dispatch) saw the pre-mutation form,
      // which is acceptable: the dispatcher already collected all
      // promises before iterating. Downstream callers re-call dispatch
      // if they want plugins to see the post-mutation form.
      req = { ...req, ...value }
    }
    return { decision: "allow", req }
  }

  /**
   * Observe + veto + transform gate for IM connector inbound / outbound
   * (plugin⇄IM extensibility). Deterministic aggregation across all subscribed
   * plugins (priority order):
   *
   *   - First `{action:"block"}` short-circuits → returns block immediately.
   *   - `{action:"transform", segments}` replaces the segment list; later
   *     transforms in the SAME dispatch saw the pre-mutation payload, so the
   *     last transform wins on the full-replacement (documented, matches
   *     `dispatchTerminalWillSpawn`).
   *   - `allow` / `void` / `undefined` → no-op.
   *
   * A throwing/timing-out plugin is treated as `allow` (fail-OPEN for plugin
   * ERRORS, so a buggy plugin never wedges IM). The HOST is responsible for the
   * fail-CLOSED PII re-gate on any returned transform — this method only
   * aggregates decisions.
   */
  async dispatchConnectorDecision(
    hookName: "onConnectorInbound" | "onConnectorOutbound",
    payload: ConnectorInboundHookPayload | ConnectorOutboundHookPayload
  ): Promise<ConnectorHookDecision> {
    const results = await this.executeHook(hookName, (hooks) => {
      const fn = hooks[hookName] as
        | ((
            p: typeof payload
          ) => ConnectorHookDecision | void | Promise<ConnectorHookDecision | void>)
        | undefined
      return fn?.(payload)
    })
    let transformed: unknown[] | null = null
    for (const r of results) {
      if (!r.success) continue
      const value = r.result as ConnectorHookDecision | undefined | void
      if (!value || value.action === "allow") continue
      if (value.action === "block") return { action: "block", reason: value.reason }
      if (value.action === "transform") transformed = value.segments
    }
    return transformed ? { action: "transform", segments: transformed } : { action: "allow" }
  }

  /**
   * Fire-and-forget terminal lifecycle event for audit / activity-log
   * plugins. Never blocks the dock.
   */
  dispatchTerminalLifecycle(event: PluginTerminalLifecycleEvent): void {
    this.executeHook("onTerminalLifecycle", (hooks) => hooks.onTerminalLifecycle?.(event))
  }

  async dispatchContextMenuShow(context: {
    type: string
    target?: unknown
  }): Promise<{ items?: unknown[] } | undefined> {
    const results = await this.executeHook("onContextMenuShow", (hooks) =>
      hooks.onContextMenuShow?.(context)
    )

    for (const result of results) {
      if (result.success && result.result) {
        return result.result as { items?: unknown[] }
      }
    }
    return undefined
  }

  // =============================================================================
  // Additional Hooks - From PluginHooksAll type definition
  // =============================================================================

  // Project - Additional hooks
  dispatchSessionLinked(projectId: string, sessionId: string) {
    this.executeHook("onSessionLinked", (hooks) => hooks.onSessionLinked?.(projectId, sessionId))
  }

  dispatchSessionUnlinked(projectId: string, sessionId: string) {
    this.executeHook("onSessionUnlinked", (hooks) =>
      hooks.onSessionUnlinked?.(projectId, sessionId)
    )
  }

  // Canvas - Additional hooks
  dispatchCanvasVersionSave(documentId: string, versionId: string) {
    this.executeHook("onCanvasVersionSave", (hooks) =>
      hooks.onCanvasVersionSave?.(documentId, versionId)
    )
  }

  dispatchCanvasVersionRestore(documentId: string, versionId: string) {
    this.executeHook("onCanvasVersionRestore", (hooks) =>
      hooks.onCanvasVersionRestore?.(documentId, versionId)
    )
  }

  dispatchCanvasSelection(
    documentId: string,
    selection: { start: number; end: number; text: string }
  ) {
    this.executeHook("onCanvasSelection", (hooks) =>
      hooks.onCanvasSelection?.(documentId, selection)
    )
  }

  // Artifact - Additional hooks
  dispatchArtifactExecute(artifactId: string, result: { success: boolean; error?: string }) {
    this.executeHook("onArtifactExecute", (hooks) => hooks.onArtifactExecute?.(artifactId, result))
  }

  dispatchArtifactExport(artifactId: string, format: string) {
    this.executeHook("onArtifactExport", (hooks) => hooks.onArtifactExport?.(artifactId, format))
  }

  // Export - Project export hooks
  async dispatchProjectExportStart(projectId: string, format: string) {
    return this.executeHook("onProjectExportStart", (hooks) =>
      hooks.onProjectExportStart?.(projectId, format)
    )
  }

  dispatchProjectExportComplete(projectId: string, format: string, success: boolean) {
    this.executeHook("onProjectExportComplete", (hooks) =>
      hooks.onProjectExportComplete?.(projectId, format, success)
    )
  }

  // Theme - Additional hooks
  dispatchCustomThemeActivate(themeId: string) {
    this.executeHook("onCustomThemeActivate", (hooks) => hooks.onCustomThemeActivate?.(themeId))
  }

  // =============================================================================
  // External Agent Hooks
  // =============================================================================

  dispatchExternalAgentConnect(agentId: string, agentName: string) {
    this.executeHook("onExternalAgentConnect", (hooks) =>
      (
        hooks as PluginHooksAll & {
          onExternalAgentConnect?: (agentId: string, name: string) => void
        }
      ).onExternalAgentConnect?.(agentId, agentName)
    )
  }

  dispatchExternalAgentDisconnect(agentId: string) {
    this.executeHook("onExternalAgentDisconnect", (hooks) =>
      (
        hooks as PluginHooksAll & { onExternalAgentDisconnect?: (agentId: string) => void }
      ).onExternalAgentDisconnect?.(agentId)
    )
  }

  dispatchExternalAgentExecutionStart(agentId: string, sessionId: string, prompt: string) {
    this.executeHook("onExternalAgentExecutionStart", (hooks) =>
      (
        hooks as PluginHooksAll & {
          onExternalAgentExecutionStart?: (
            agentId: string,
            sessionId: string,
            prompt: string
          ) => void
        }
      ).onExternalAgentExecutionStart?.(agentId, sessionId, prompt)
    )
  }

  dispatchExternalAgentExecutionComplete(
    agentId: string,
    sessionId: string,
    success: boolean,
    response?: string
  ) {
    this.executeHook("onExternalAgentExecutionComplete", (hooks) =>
      (
        hooks as PluginHooksAll & {
          onExternalAgentExecutionComplete?: (
            agentId: string,
            sessionId: string,
            success: boolean,
            response?: string
          ) => void
        }
      ).onExternalAgentExecutionComplete?.(agentId, sessionId, success, response)
    )
  }

  dispatchExternalAgentPermissionRequest(
    agentId: string,
    sessionId: string,
    toolName: string,
    reason?: string
  ) {
    this.executeHook("onExternalAgentPermissionRequest", (hooks) =>
      (
        hooks as PluginHooksAll & {
          onExternalAgentPermissionRequest?: (
            agentId: string,
            sessionId: string,
            toolName: string,
            reason?: string
          ) => void
        }
      ).onExternalAgentPermissionRequest?.(agentId, sessionId, toolName, reason)
    )
  }

  dispatchExternalAgentToolCall(
    agentId: string,
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>
  ) {
    this.executeHook("onExternalAgentToolCall", (hooks) =>
      (
        hooks as PluginHooksAll & {
          onExternalAgentToolCall?: (
            agentId: string,
            sessionId: string,
            toolName: string,
            args: Record<string, unknown>
          ) => void
        }
      ).onExternalAgentToolCall?.(agentId, sessionId, toolName, args)
    )
  }

  dispatchExternalAgentError(agentId: string, error: string) {
    this.executeHook("onExternalAgentError", (hooks) =>
      (
        hooks as PluginHooksAll & {
          onExternalAgentError?: (agentId: string, error: string) => void
        }
      ).onExternalAgentError?.(agentId, error)
    )
  }

  // =============================================================================
  // Code Execution / Sandbox Hooks
  // =============================================================================

  dispatchCodeExecutionStart(language: string, code: string, sandboxId?: string) {
    this.executeHook("onCodeExecutionStart", (hooks) =>
      hooks.onCodeExecutionStart?.(language, code, sandboxId)
    )
  }

  dispatchCodeExecutionComplete(language: string, result: unknown, sandboxId?: string) {
    this.executeHook("onCodeExecutionComplete", (hooks) =>
      hooks.onCodeExecutionComplete?.(language, result, sandboxId)
    )
  }

  dispatchCodeExecutionError(language: string, error: Error, sandboxId?: string) {
    this.executeHook("onCodeExecutionError", (hooks) =>
      hooks.onCodeExecutionError?.(language, error, sandboxId)
    )
  }

  // =============================================================================
  // MCP Server Hooks
  // =============================================================================

  dispatchMCPServerConnect(serverId: string, serverName: string) {
    this.executeHook("onMCPServerConnect", (hooks) =>
      hooks.onMCPServerConnect?.(serverId, serverName)
    )
  }

  dispatchMCPServerDisconnect(serverId: string) {
    this.executeHook("onMCPServerDisconnect", (hooks) => hooks.onMCPServerDisconnect?.(serverId))
  }

  dispatchMCPToolCall(serverId: string, toolName: string, args: Record<string, unknown>) {
    this.executeHook("onMCPToolCall", (hooks) => hooks.onMCPToolCall?.(serverId, toolName, args))
  }

  dispatchMCPToolResult(serverId: string, toolName: string, result: unknown) {
    this.executeHook("onMCPToolResult", (hooks) =>
      hooks.onMCPToolResult?.(serverId, toolName, result)
    )
  }
}

// =============================================================================
// Singleton Instances
// =============================================================================

let pluginLifecycleHooksInstance: PluginLifecycleHooks | null = null
let pluginEventHooksInstance: PluginEventHooks | null = null

/**
 * Get the plugin lifecycle hooks singleton instance
 */
export function getPluginLifecycleHooks(): PluginLifecycleHooks {
  if (!pluginLifecycleHooksInstance) {
    pluginLifecycleHooksInstance = new PluginLifecycleHooks()
  }
  return pluginLifecycleHooksInstance
}

/**
 * Get the plugin event hooks singleton instance
 */
export function getPluginEventHooks(): PluginEventHooks {
  if (!pluginEventHooksInstance) {
    pluginEventHooksInstance = new PluginEventHooks()
  }
  return pluginEventHooksInstance
}

/**
 * Reset the plugin lifecycle hooks instance (for testing)
 */
export function resetPluginLifecycleHooks(): void {
  if (pluginLifecycleHooksInstance) {
    pluginLifecycleHooksInstance.clear()
    pluginLifecycleHooksInstance = null
  }
}

/**
 * Reset the plugin event hooks instance (for testing)
 */
export function resetPluginEventHooks(): void {
  pluginEventHooksInstance = null
}
