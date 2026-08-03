"use client"

import { startTransition, useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import type { UnlistenFn } from "@tauri-apps/api/event"
import {
  applySdkEvent,
  contentPreview,
  extractUsage,
  makeUserMessage,
  mergeMemorySourcesIntoLastAssistant,
  mergeTwinSourcesIntoLastAssistant,
} from "@/lib/claude/adapter"
import { toast } from "sonner"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { createDiagnostic } from "@cognia/diagnostics"
import { toDiagnostic } from "@/lib/diagnostics/to-diagnostic"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"
import { flushProjectEditorEdits } from "@/lib/files/project-editor-bridge"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { handleTurnComplete } from "@/lib/goal/turn-driver"
import { defaultLifecycleFirer } from "@/lib/claude/hooks/lifecycle-firer"
import { buildGoalJudgeClient } from "@/lib/goal/judge-client"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { runAutoModeForTool } from "@/lib/claude/permissions/auto-mode-runner"
import { deriveAllowRuleFromApproval } from "@/lib/claude/permissions/approval-rule"
import { setToolRule } from "@/lib/claude/permissions/ruleset-edit"
import { getPluginCommandRulesets } from "@/lib/plugin/registries/command-safety-registry"
import {
  runTitleTask,
  shouldGenerateTitle,
  isPlaceholderTitle,
} from "@/lib/ai/generation/run-title-task"
import { generateTurnLabel } from "@/lib/ai/generation/turn-label"
import { gateContinuation } from "@/lib/goal/pacing"
import { parseSuggestedDelay } from "@/lib/goal/prompts"
import { getLoopRuntime } from "@/lib/loop/runtime"
import { handleLoopTurnComplete } from "@/lib/loop/turn-driver"
import { gateLoopContinuation } from "@/lib/loop/pacing"
import { renderLoopIterationMessage } from "@/lib/loop/prompts"
import type { LoopStatus } from "@/types/loop"
import type { GoalStatus } from "@/types/goal"
import type { AgentPlan, PlanStatus } from "@/types/agent/plan"
import { attemptRoutingFallback } from "@/lib/claude/routing-fallback"
import { notifyDroppedCapabilityOnce } from "@/lib/claude/dropped-capability-toast"
import { notifyOverBudgetOnce } from "@/lib/claude/over-budget-toast"
import { applyPlanModeBridge } from "@/lib/agent/plan-mode-bridge"
import { steerBlocksOf, steerTextOf, type SteerMessageMeta } from "@/lib/claude/steer"
import {
  appendSteerMessage,
  isSessionOpen,
  markPendingSteersFailed,
  maybeDrainSteer,
  sessionExternalLane,
  sessionStatusOf,
  setSessionExternalLane,
  setSteerMessageState,
  steerArmed,
} from "./steer-runtime"
import {
  maybeDrainBackgroundResults,
  registerBackgroundReplaySend,
} from "./background-result-runtime"
import { getSubagentApprovalRoute } from "@/lib/claude/agents/subagent-approval-routes"
import { tagBranchSiblings, tagEditSibling } from "@/lib/chat/branch-regen"
import {
  approveTool,
  closeSession,
  interruptSession,
  onClaudeMessage,
  sendPrompt,
  toolResultDecision,
} from "@/lib/claude/ipc"
import { isEmbeddedSession } from "@/lib/chat/session-exposure"
import { gateWorkbenchProviderPayload } from "@/lib/context-workbench/provider-payload"
import type { RemoteExecutionContext } from "@/lib/claude/remote-execution"
import { COMPUTER_USE_PLUGIN_TOOL_NAMES } from "@/lib/claude/computer-use-tools"
import { clearSessionGrants } from "@/lib/claude/computer-use-session-grants"

// ADR-0020 W3 — keep grant recording and send-side suppression on the
// same visual/execution tool-name contract.
const COMPUTER_USE_PLUGIN_TOOL_NAME_SET = new Set<string>(COMPUTER_USE_PLUGIN_TOOL_NAMES)

function isComputerUsePluginToolName(name: string): boolean {
  return COMPUTER_USE_PLUGIN_TOOL_NAME_SET.has(name)
}
import {
  armApprovalBackstop,
  clearApprovalBackstops,
  isSessionAttached,
} from "@/lib/companion/remote-attach-registry"
import { notifyRemoteNeedsInput } from "@/lib/companion/needs-input-notifier"
import {
  listMessages,
  persistMessages,
  persistStreamingMessages,
  updateMessageMetadata,
} from "@/lib/db/messages"
import { SessionCoalescingRegistry } from "@/hooks/chat/stream-coalescing"
import {
  getSession,
  setSdkSessionId,
  touchSession,
  updateSession,
  clearBranchSeed,
  freezeImportedSession,
} from "@/lib/db/sessions"
import { recordResultUsage } from "@/lib/db/session-usage"
import { recordProviderOutcome } from "@/lib/claude/provider-telemetry"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { useInFlightStore } from "@/stores/settings/in-flight-store"
import { endSpan, recordEvent, startSpan } from "@cognia/agent-trace/emitter"
import { toTraceparent } from "@/lib/agent-trace/trace-context"
import {
  clearToolSpansForSession,
  handleSdkEventForToolSpans,
  setToolSpanEventPublisher,
} from "@cognia/agent-trace/chat-tool-spans"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"
import { beginCodeAdoptionTurn } from "@/lib/code-adoption/client"
import { markTaskWorkspaceTurnCancelled } from "@/lib/code-adoption/turn-tracker"
import { runIdForTurn, taskIdForMessage } from "@/lib/task-workspace/client"
import { openTaskWorkspaceRunLease } from "@/lib/task-workspace/run-lease"
import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"
import { bumpUnread } from "@/lib/db/session-state"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { useGitStore } from "@/stores/git/git-store"
import { primaryRootOf } from "@/lib/workspace/roots"
import { pendingRecoveryPhase } from "@/lib/usage/compaction-metrics"
import {
  buildChatMentionTargets,
  resolveTargetAgentId,
} from "@/lib/claude/agents/chat-mention-targets"
import { discoverMarkdownAgentTargets } from "@/lib/claude/agents/markdown-mention-targets"
import { resolveMentions } from "@/lib/chat/mentions/resolve-mentions"
import { useProjectStore } from "@/stores/project/project-store"
import { allRootPaths } from "@/lib/workspace/roots"
import { isWorkspaceRestricted } from "@/lib/workspace/trust-gate"
import {
  dispatchChatError as dispatchPluginChatError,
  dispatchUserPromptSubmit as dispatchPluginUserPromptSubmit,
  dispatchTokenUsage as dispatchPluginTokenUsage,
  dispatchPostChatReceive as dispatchPluginPostChatReceive,
  dispatchPreToolUse as dispatchPluginPreToolUse,
  dispatchPostToolUse as dispatchPluginPostToolUse,
  dispatchOnMessageSend as dispatchPluginMessageSend,
  dispatchOnAssistantMessage as dispatchPluginAssistantMessage,
  hasPostToolUseListeners,
} from "@/lib/claude/adapter-hooks"

setToolSpanEventPublisher((eventType, payload) => {
  emitSystemBusEvent(eventType, payload)
})

// ── Plugin tool hooks (W3.1) ─────────────────────────────────────────────────
// Correlates `tool_result_review` events back to the tool call's name + input
// so `dispatchPostToolUse` receives real args. Fed from streamed assistant
// `tool_use` blocks and from `permission_request` events; bounded so a long
// session can't grow it unboundedly.
const chatToolCallsById = new Map<string, { name: string; input: Record<string, unknown> }>()
const behaviorTurnStartedAt = new Map<string, number>()

function finishBehaviorTurn(sessionId: string): number | undefined {
  const startedAt = behaviorTurnStartedAt.get(sessionId)
  if (startedAt === undefined) return undefined
  behaviorTurnStartedAt.delete(sessionId)
  return Math.max(0, Date.now() - startedAt)
}
const CHAT_TOOL_CALLS_CAP = 500

function rememberChatToolCall(id: string, name: string, input: Record<string, unknown>): void {
  if (!id) return
  if (chatToolCallsById.size >= CHAT_TOOL_CALLS_CAP) {
    const oldest = chatToolCallsById.keys().next().value
    if (oldest !== undefined) chatToolCallsById.delete(oldest)
  }
  chatToolCallsById.set(id, { name, input })
}

/** Pull assistant `tool_use` blocks out of a streamed SDK event envelope. */
function rememberToolCallsFromSdkEvent(event: unknown): void {
  const message = (event as { message?: { content?: unknown } } | undefined)?.message
  const content = message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    const b = block as { type?: string; id?: string; name?: string; input?: unknown }
    if (b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
      rememberChatToolCall(b.id, b.name, (b.input as Record<string, unknown>) ?? {})
    }
  }
}
import { tryBuildTwinDeps } from "@/lib/twin/runtime/build-deps"
import { tryBuildMemoryDeps } from "@/lib/memory/runtime/build-deps"
import { generateEmbedding } from "@cognia/provider-embedding/embedding"
import { runTurnMemory } from "@/lib/memory/run-turn-memory"
import { resolveMemoryConfig } from "@/types/memory/memory"
import { isStandaloneChatMode } from "@/lib/runtime/standalone-mode"
import { runStandaloneTurn } from "@/lib/ai/chat/standalone-engine"
import type {
  ApprovalDecision,
  ChatSession,
  ClaudeEvent,
  PendingApproval,
  SDKEventEnvelope,
  SendContent,
  SendOptions,
} from "@cognia/agent-config-types"
import { isSubSessionId } from "@/lib/claude/team-session-id"
import { useChatStore } from "@/stores/chat"
import { getExecutionBroker } from "@/lib/execution/broker"
import { acquireChatLease } from "@/lib/execution/chat-lease"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import {
  selectSessionSubagents,
  applySubagentsToMessages,
  subagentSignature,
} from "@/lib/claude/subagent-bridge"
import { useSettingsStore } from "@/stores/settings"
import { useAgentRuntimeStore, useExternalAgentStore } from "@/stores/agent"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { routeAiRevision } from "@/lib/artifacts/route-ai-revision"
import { isTauri } from "@/lib/tauri"
import { isCapacitor } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { chatTurnPerformance } from "@/lib/perf/chat-turn-performance"
import type { UIMessage } from "ai"

/**
 * Pull plain assistant text out of a UIMessage's parts. Used to feed the
 * artifact detector; only the rendered text content is meaningful — tool
 * calls and reasoning blocks are ignored.
 */
function extractAssistantText(message: UIMessage | undefined): string {
  if (!message || message.role !== "assistant") return ""
  return message.parts
    .map((part) => {
      const p = part as { type?: string; text?: string }
      return p.type === "text" && typeof p.text === "string" ? p.text : ""
    })
    .filter(Boolean)
    .join("\n")
}

/** Pull plain text out of any UIMessage's `text` parts (role-agnostic). */
function extractPlainText(message: UIMessage | undefined): string {
  if (!message) return ""
  return message.parts
    .map((part) => {
      const p = part as { type?: string; text?: string }
      return p.type === "text" && typeof p.text === "string" ? p.text : ""
    })
    .filter(Boolean)
    .join("\n")
}

// The title gate + instant-preview predicate now live in the shared
// title-task core so the chat and team hooks share one implementation.
// Re-exported here to preserve the historical public surface (tests import
// `shouldGenerateTitle` from this module).
export { shouldGenerateTitle }

/**
 * Error surfaced on every in-flight session when the sidecar process dies.
 *
 * The sidecar does NOT emit a per-session `session_ended` on crash (only a
 * single global `sidecar_exited`), so without this the foreground session
 * freezes in `streaming` forever.
 *
 * This string is now ONLY a telemetry/log artifact for the agent-trace span.
 * It used to be written into the session error as a sentinel and then
 * string-compared back in `chat-view.tsx` to pick a localized message — a
 * round-trip that existed purely because the store had no way to carry a code.
 * The UI now reads the `sidecarExited` diagnostic directly, so this is
 * deliberately module-private: re-exporting it invites the sentinel back.
 */
const SIDECAR_EXITED_TRACE_MESSAGE =
  "The assistant process stopped unexpectedly. Your last turn was interrupted — retry to continue."

/**
 * Write the instant first-message title preview onto a session — but only when
 * the session still carries a placeholder title (never clobber a user rename),
 * re-reading a *fresh* row so a concurrent write can't be overwritten from a
 * stale snapshot. Shared by both the external-agent and SDK send paths.
 */
async function applyInstantTitle(sessionId: string, content: SendContent): Promise<void> {
  const preview = contentPreview(content, 40)
  if (!preview) return
  const fresh = await getSession(sessionId).catch(() => undefined)
  if (fresh && !isPlaceholderTitle(fresh.title)) return
  await updateSession(sessionId, { title: preview, titleAuto: true })
}

/**
 * Background "utility model" work fired once a turn seals: upgrade the
 * machine-set conversation title to an LLM-generated one on the first
 * assistant turn, and (opt-in) generate a short timeline-minimap label for
 * the latest user turn. Fire-and-forget — never blocks the per-session event
 * queue, and every failure is swallowed (the placeholder title / raw label
 * remain). `messages` is the just-sealed turn snapshot.
 */
function runUtilityModelTasks(sessionId: string, messages: UIMessage[]): void {
  void (async () => {
    try {
      const settings = useSettingsStore.getState().settings
      if (!settings) return
      const locale = settings.language
      const sessionRow = await getSession(sessionId).catch(() => undefined)
      if (!sessionRow) return

      // ── Conversation title: first assistant turn, enabled, not renamed ──
      const titleCfg = settings.conversationTitle
      const assistantCount = messages.filter((m) => m.role === "assistant").length
      if (
        shouldGenerateTitle({
          titleEnabled: titleCfg?.enabled,
          assistantCount,
          titleAuto: sessionRow.titleAuto,
        })
      ) {
        const firstUser = messages.find((m) => m.role === "user")
        const firstAssistant = messages.find((m) => m.role === "assistant")
        await runTitleTask({
          session: sessionRow,
          appSettings: settings,
          override: titleCfg,
          featureId: "conversation-title",
          sourceText: extractPlainText(firstUser),
          resultText: extractAssistantText(firstAssistant),
          locale,
          currentTitle: sessionRow.title,
          // Re-read titleAuto before writing — the user may have renamed the
          // session while the model call was in flight.
          isStillAuto: async () => {
            const fresh = await getSession(sessionId).catch(() => undefined)
            return !fresh || fresh.titleAuto !== false
          },
          persist: (title) => updateSession(sessionId, { title, titleAuto: true }),
        })
      }

      // ── Timeline minimap label for the latest user turn (opt-in) ──
      const labelCfg = settings.conversationTimeline?.labelSummary
      if (labelCfg?.enabled) {
        const store = useChatStore.getState()
        const msgs = store.activeSessionId === sessionId ? store.messages : messages
        let lastUserIdx = -1
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "user") {
            lastUserIdx = i
            break
          }
        }
        if (lastUserIdx >= 0) {
          const userMsg = msgs[lastUserIdx]
          const userMsgId = userMsg.id
          const meta = (userMsg as { metadata?: Record<string, unknown> }).metadata ?? {}
          if (userMsgId && !meta.minimapLabel) {
            const client = buildUtilityLlmClient({
              session: sessionRow,
              appSettings: settings,
              override: labelCfg,
              featureId: "timeline-label",
            })
            if (client) {
              const label = await generateTurnLabel(client, {
                userText: extractPlainText(userMsg),
                locale,
              })
              if (label) {
                // Patch the in-memory store by *id* against its current state —
                // never replace it with the pre-await snapshot, which may have
                // gone stale if the user sent another turn during the model call.
                if (useChatStore.getState().activeSessionId === sessionId) {
                  const current = useChatStore.getState().messages
                  const idx = current.findIndex((m) => m.id === userMsgId)
                  if (idx >= 0) {
                    const curMeta =
                      (current[idx] as { metadata?: Record<string, unknown> }).metadata ?? {}
                    const next = current.slice()
                    next[idx] = {
                      ...current[idx],
                      metadata: { ...curMeta, minimapLabel: label },
                    } as UIMessage
                    useChatStore.getState().replaceMessages(next)
                  }
                }
                // Targeted single-row DB write — cannot delete a newer turn that
                // landed while the model call was in flight (see the persist-race
                // guard in lib/db/messages.ts).
                await updateMessageMetadata(sessionId, userMsgId, {
                  minimapLabel: label,
                }).catch(() => {})
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn("utility-model tasks failed", err)
    }
  })()
}

/**
 * Background long-term-memory extraction for the just-finished turn. Fire-and-
 * forget — mirrors `runUtilityModelTasks`; never blocks the event queue and
 * swallows every failure. Gated by `memory.enabled && autoExtract && !temporary`
 * and provenance (connector-inbound sessions are excluded inside
 * `runMemoryExtraction`). `messages` is the just-sealed turn snapshot.
 */
function runMemoryTasks(sessionId: string, messages: UIMessage[]): void {
  // Direct-chat extraction keeps its own text nuance (assistant reply via
  // `extractAssistantText`, rolling transcript via `extractPlainText`); the gate,
  // dep wiring, and maintenance scheduling live in the shared `runTurnMemory` so
  // the team hook drives the exact same write path. Fire-and-forget (never throws).
  const lastUser = [...messages].reverse().find((m) => m.role === "user")
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")
  void runTurnMemory(sessionId, {
    userText: extractPlainText(lastUser),
    assistantText: extractAssistantText(lastAssistant),
    assistantMessageId: lastAssistant?.id,
    transcript: messages.map((m) => ({
      role: m.role,
      text: extractPlainText(m),
      parts: m.parts,
    })),
  })
}

/** Signature of the hook's `send`, threaded into `handleEvent` via a ref. */
type SendFn = (
  content: SendContent,
  opts?: SendOptions,
  callOptions?: {
    skipUserAppend?: boolean
    bypassDelegation?: boolean
    sessionId?: string
    steerDrain?: boolean
  }
) => Promise<void>

/**
 * Goal ids for which we've already surfaced the "can't build a judge client"
 * notice this process. Prevents re-warning on every turn for a legacy
 * `ANTHROPIC_API_KEY`-env-only setup. Module-scope so it survives the
 * module-scope `handleEvent` callback.
 */
const goalJudgeClientWarned = new Set<string>()

/** Epoch ms of the last dispatched auto-continuation, per goal (interval gating). */
const goalLastContinuationAt = new Map<string, number>()
/** Active manual-continue unsubscribe fns, per goal (one held continuation at a time). */
const goalManualUnsub = new Map<string, () => void>()
/** Active defer timers, per goal (quiet-hours / interval). */
const goalDeferTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Tear down any pending continuation (defer timer + manual subscription) for a goal. */
function clearPendingContinuation(goalId: string): void {
  const timer = goalDeferTimers.get(goalId)
  if (timer) {
    clearTimeout(timer)
    goalDeferTimers.delete(goalId)
  }
  const unsub = goalManualUnsub.get(goalId)
  if (unsub) {
    unsub()
    goalManualUnsub.delete(goalId)
  }
}

/**
 * Schedule (or hold/defer) a goal continuation per the pacing gate
 * (ADR-0019 Phase 2). Re-reads the goal each attempt so a pause/stop between
 * the turn-driver decision and dispatch cancels cleanly. Re-entrant: a defer
 * timer re-invokes this, and a fresh turn supersedes any prior pending one.
 */
function scheduleGoalContinuation(
  goalId: string,
  sessionId: string,
  userMessage: string,
  sendRef: React.MutableRefObject<SendFn | null>,
  activeRef: React.MutableRefObject<string | null>,
  suggestedDelayMs?: number
): void {
  clearPendingContinuation(goalId)
  void (async () => {
    const goal = await getGoalRuntime().getActiveGoalForSession(sessionId)
    // Goal paused/stopped/replaced, or session backgrounded → drop silently.
    if (!goal || goal.id !== goalId || sessionId !== activeRef.current) return

    const gate = gateContinuation(
      goal,
      Date.now(),
      goalLastContinuationAt.get(goalId),
      suggestedDelayMs
    )
    // Stamp nextContinuationAt (+ audit on defer) so the pill can show the
    // schedule — best-effort, runs in the background.
    void getGoalRuntime().recordPacingDecision(goalId, gate, suggestedDelayMs)
    if (gate.kind === "send") {
      goalLastContinuationAt.set(goalId, Date.now())
      void sendRef.current?.(userMessage, undefined, { skipUserAppend: true })
    } else if (gate.kind === "hold") {
      // Wait for the user to click "Continue" on the status pill.
      const unsub = getGoalRuntime().onManualContinue(goalId, () => {
        clearPendingContinuation(goalId)
        goalLastContinuationAt.set(goalId, Date.now())
        void sendRef.current?.(userMessage, undefined, { skipUserAppend: true })
      })
      goalManualUnsub.set(goalId, unsub)
    } else {
      // defer — re-gate at untilMs (quiet-hours window end / interval gap /
      // model-suggested delay). The suggestion threads through the timer
      // recursion so the re-gate sees the same request.
      const delay = Math.max(0, gate.untilMs - Date.now())
      const timer = setTimeout(() => {
        goalDeferTimers.delete(goalId)
        scheduleGoalContinuation(
          goalId,
          sessionId,
          userMessage,
          sendRef,
          activeRef,
          suggestedDelayMs
        )
      }, delay)
      goalDeferTimers.set(goalId, timer)
    }
  })()
}

/** Active defer timers, per self-paced loop. */
const loopDeferTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Tear down any pending continuation timer for a loop. */
function clearPendingLoopContinuation(loopId: string): void {
  const timer = loopDeferTimers.get(loopId)
  if (timer) {
    clearTimeout(timer)
    loopDeferTimers.delete(loopId)
  }
}

/**
 * Schedule (or defer) a self-paced loop continuation. Mirrors
 * `scheduleGoalContinuation`: re-reads the loop each attempt so a
 * pause/stop between the turn-driver decision and dispatch cancels
 * cleanly; the defer timer re-invokes this to re-gate.
 */
function scheduleLoopContinuation(
  loopId: string,
  sessionId: string,
  userMessage: string,
  sendRef: React.MutableRefObject<SendFn | null>,
  activeRef: React.MutableRefObject<string | null>
): void {
  clearPendingLoopContinuation(loopId)
  void (async () => {
    const loop = await getLoopRuntime().getActiveLoopForSession(sessionId)
    // Loop paused/stopped/replaced, or session backgrounded → drop silently.
    if (!loop || loop.id !== loopId || sessionId !== activeRef.current) return

    const gate = gateLoopContinuation(loop, Date.now())
    if (gate.kind === "send") {
      void sendRef.current?.(userMessage, undefined, { skipUserAppend: true })
    } else {
      const delay = Math.max(0, gate.untilMs - Date.now())
      const timer = setTimeout(() => {
        loopDeferTimers.delete(loopId)
        scheduleLoopContinuation(loopId, sessionId, userMessage, sendRef, activeRef)
      }, delay)
      loopDeferTimers.set(loopId, timer)
    }
  })()
}

/**
 * System card for a /loop terminal state. Hard-coded English, consistent
 * with the goal exit card below and the slash-command cards.
 */
function renderLoopExitCard(resultingStatus: LoopStatus, reason: string): string {
  const head: Record<string, string> = {
    completed: "✅ **Loop completed**",
    iteration_limited: "🛑 **Loop stopped — iteration cap reached**",
    budget_limited: "🛑 **Loop stopped — token budget reached**",
    expired: "⏱️ **Loop stopped — 7-day expiry**",
    stopped: "⏹️ **Loop stopped**",
    error: "⚠️ **Loop stopped — repeated trailer parse failures**",
  }
  const title = head[resultingStatus] ?? `🔁 **Loop ${resultingStatus}**`
  return reason ? `${title}\n\n> ${reason}` : title
}

/**
 * System card for a plan that finished under the in-session driver. Hard-coded
 * English, consistent with the goal / loop exit cards above and the
 * slash-command cards in `lib/slash-commands/actions/plan.ts`.
 */
function renderPlanExitCard(title: string, status: PlanStatus, reason: string): string {
  const head =
    status === "completed"
      ? "📋 **Plan completed**"
      : status === "failed"
        ? "🛑 **Plan stopped — a step failed**"
        : `📋 **Plan ${status}**`
  return `${head} — ${title}\n\n_${reason}_`
}

/**
 * Render the system-message card shown when the `/goal` loop reaches a
 * terminal/exit state. Hard-coded English for Phase 1, consistent with the
 * existing slash-command cards in `lib/slash-commands/actions/goal.ts`; both
 * get i18n-wired together in the ADR-0019 console phase (Phase 3).
 */
function renderGoalExitCard(resultingStatus: GoalStatus, reason: string): string {
  const head: Record<string, string> = {
    completed: "✅ **Goal completed**",
    turn_limited: "🛑 **Goal stopped — turn budget reached**",
    budget_limited: "🛑 **Goal stopped — token budget reached**",
    timed_out: "⏱️ **Goal stopped — timed out**",
    stopped: "⏹️ **Goal stopped**",
    preempted: "✋ **Goal preempted**",
    paused: "⏸️ **Goal paused — judge needs attention**",
  }
  const title = head[resultingStatus] ?? `🎯 **Goal ${resultingStatus}**`
  return reason ? `${title}\n\n> ${reason}` : title
}

/**
 * Wires the Claude sidecar IPC into the React store. Mount this hook once at
 * the top of the chat page; do not invoke it per-message.
 */
export function useClaudeChat() {
  const store = useChatStore
  const tRouting = useTranslations("providers.routingView")
  const tInlineErr = useTranslations("chat.inlineError")
  // The active session id is captured per-render via a ref so the long-lived
  // event handler always sees the freshest value without resubscribing.
  const activeRef = useRef<string | null>(null)
  /**
   * Per-session authoritative "latest messages" while a coalesced commit /
   * debounced persist is in flight. The streaming hot path reads `current`
   * from here (falling back to the store) so deferring the React commit can't
   * feed a stale base into the next event's `applySdkEvent`. Written
   * synchronously every event; cleared at every turn boundary (turnComplete,
   * session_ended, a new send/edit/regenerate) and on a session switch below.
   */
  const messagesMirrorRef = useRef<Map<string, UIMessage[]>>(new Map())
  useEffect(() => {
    const unsub = useChatStore.subscribe((s) => {
      // Concurrent sessions: the mirror is keyed per session and survives focus
      // changes — a background session that is mid-stream keeps its
      // authoritative base so switching away/back never drops its tokens. Each
      // session's entry is cleared at its own turn boundary (turnComplete /
      // session_ended) and on a new send/edit/regenerate, not on focus switch.
      activeRef.current = s.activeSessionId
    })
    activeRef.current = useChatStore.getState().activeSessionId
    return unsub
  }, [])

  // Surface dispatched sub-agent runs inline in the chat. `recordDispatch*`
  // (the dispatch runtime store) is the producer; this is the consumer the
  // subagent-bridge docstring promised. For the active session it folds each
  // run's tree onto the spawning assistant turn, deduped by a cheap signature
  // so progress ticks don't rewrite the message array needlessly.
  const subagentSigRef = useRef<string>("")
  useEffect(() => {
    const apply = () => {
      const sid = useChatStore.getState().activeSessionId
      if (!sid) return
      const subs = selectSessionSubagents(useSubagentRuntimeStore.getState().subAgents, sid)
      const sig = subagentSignature(subs)
      if (sig === subagentSigRef.current) return
      subagentSigRef.current = sig
      if (subs.length === 0) return
      const current = useChatStore.getState().messages
      const next = applySubagentsToMessages(current, subs)
      if (next !== current) useChatStore.getState().replaceMessages(next)
    }
    apply()
    return useSubagentRuntimeStore.subscribe(apply)
  }, [])

  // Always-allow tool list — also kept fresh via ref.
  const allowListRef = useRef<string[]>([])
  useEffect(() => {
    const unsub = useSettingsStore.subscribe((s) => {
      allowListRef.current = s.settings?.alwaysAllowTools ?? []
    })
    allowListRef.current = useSettingsStore.getState().settings?.alwaysAllowTools ?? []
    return unsub
  }, [])

  // Track the last user content per session so we can regenerate without
  // re-deriving from message parts (which lose the original SendContent shape
  // when they include attachments).
  const lastUserContentRef = useRef<Map<string, SendContent>>(new Map())
  // Private resource context is kept outside the message log. It is reused for
  // regenerate/edit-resend, but is only attached after plugin prompt hooks.
  const lastResourceContextRef = useRef<Map<string, string>>(new Map())
  /**
   * Pending branch tag set by `regenerate` and consumed by the first
   * assistant message that arrives afterward. Keyed by sessionId so a regen
   * fired from another session doesn't taint the active turn.
   */
  const pendingBranchTagRef = useRef<Map<string, { groupId: string; index: number }>>(new Map())

  /**
   * Holds the latest `send` so the module-scope `handleEvent` can dispatch a
   * silent goal continuation (ADR-0019). `handleEvent` is defined outside the
   * hook (can't close over `send`), so we thread the live reference through a
   * ref kept fresh by the effect below.
   */
  const sendRef = useRef<SendFn | null>(null)

  /**
   * Per-session serialization queue for `handleEvent`. Sidecar events arrive
   * fire-and-forget, but `handleEvent` does an async read → apply → persist →
   * store-update that spans multiple `await`s. Without serialization, two
   * events for the same session interleave: both read the same stale base, and
   * the loser's `persistMessages` can `bulkDelete` rows the winner just wrote
   * (durable message loss) or overwrite the store with a base missing a delta.
   * Chaining each event onto the tail of its session's promise guarantees the
   * read-modify-write for one session runs to completion before the next
   * starts. Different sessions keep their own chains so a busy background
   * session never blocks the foreground one.
   */
  const eventQueuesRef = useRef<Map<string, Promise<void>>>(new Map())

  // Per-session AbortControllers for in-flight standalone (BYOK) turns, so Stop
  // can cancel the renderer streamText loop (the sidecar path uses
  // `interruptSession` instead).
  const standaloneAbortRef = useRef<Map<string, AbortController>>(new Map())

  /**
   * Per-session streaming coalescers. Each open session gets its own
   * rAF-throttled React commit (≤1/frame) + debounced Dexie write so multiple
   * sessions can stream concurrently without their pending snapshots clobbering
   * each other. The commit pushes into that session's slice via the
   * session-scoped store action (which re-projects onto the top-level fields
   * when the session is the focused one). 0ms persist in tests degrades to
   * synchronous so existing persist-ordering assertions hold.
   */
  const PERSIST_DEBOUNCE_MS = process.env.NODE_ENV === "test" ? 0 : 250
  // Stable across renders (lazy `useState` initializer — created once, never
  // accessed as a ref during render).
  const [registry] = useState(
    () =>
      new SessionCoalescingRegistry({
        onCommit: (sid, msgs) => {
          useChatStore.getState().replaceSessionMessages(sid, msgs)
          // Stamp per-tool start/end times off the freshly-committed parts so the
          // Run Panel can show per-tool elapsed (no-op when nothing transitioned).
          useChatStore.getState().syncToolTimestamps(sid, msgs)
        },
        onPersist: (sid, msgs) =>
          void persistStreamingMessages(sid, msgs).catch((err) =>
            console.error("debounced persistStreamingMessages failed", err)
          ),
        persistDelayMs: PERSIST_DEBOUNCE_MS,
      })
  )

  // Best-effort flush of every session's pending streaming write on unmount so
  // the last partial isn't lost when the hook tears down mid-turn.
  useEffect(() => {
    return () => {
      registry.flushAllPersist()
      registry.clear()
    }
  }, [registry])

  // Route one ClaudeEvent into the per-session serialized queue → `handleEvent`.
  // Keyed by session so same-session events serialize; events without a session
  // id (ready/log/sidecar_exited) share one chain. Shared by the Tauri transport
  // subscription AND the standalone (BYOK) engine, so both producers drive the
  // identical store/coalescing/persistence path.
  const enqueueClaudeEvent = useCallback(
    (evt: ClaudeEvent) => {
      const key =
        typeof (evt as { sessionId?: unknown }).sessionId === "string"
          ? (evt as { sessionId: string }).sessionId
          : "__nosession__"
      const queues = eventQueuesRef.current
      const tail = (queues.get(key) ?? Promise.resolve())
        // A prior failure must not break the chain for later events.
        .catch(() => {})
        .then(() =>
          handleEvent(evt, activeRef, allowListRef, pendingBranchTagRef, sendRef, {
            messagesMirrorRef,
            registry,
          })
        )
        .catch((err) => {
          console.error("handleEvent failed", err)
        })
      queues.set(key, tail)
      // Drop the entry once the chain drains so the map doesn't grow per event.
      void tail.finally(() => {
        if (queues.get(key) === tail) queues.delete(key)
      })
      return tail
    },
    [registry]
  )

  // Subscribe to sidecar events once. Desktop gets them via Tauri events;
  // Capacitor / web-companion renderers get the same `claude://message`
  // channel mirrored over the companion events WebSocket (event_bus.rs), which
  // is what carries the mobile workflow copilot's streamed turns. Plain web
  // (WebStubTransport) has no event source — skip the subscription.
  useEffect(() => {
    if (!isTauri() && !isCapacitor() && !hasWebCompanionTarget()) return
    let unlisten: UnlistenFn | null = null
    let cancelled = false

    onClaudeMessage((evt) => enqueueClaudeEvent(evt as ClaudeEvent))
      .then((u) => {
        if (cancelled) u()
        else unlisten = u
      })
      .catch((err) => {
        console.error("listen claude events failed", err)
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [enqueueClaudeEvent])

  /**
   * Send a user prompt to the active session.
   *
   * `content` can be a plain string (the common case) or an array of
   * multimodal content blocks (text + image), to support attachments.
   */
  const send = useCallback(
    async (
      content: SendContent,
      opts?: SendOptions,
      callOptions?: {
        /** Skip the optimistic user-message append. Used by `regenerate` so we
         *  don't duplicate the user turn when re-issuing the SDK request. */
        skipUserAppend?: boolean
        /** Skip Thread-B delegation routing. Set on the built-in fallback
         *  re-entry so a failed external delegation runs the SDK path without
         *  re-evaluating (and re-matching) the delegation rules. */
        bypassDelegation?: boolean
        /** This turn is the steer queue replaying itself. Like `skipUserAppend`
         *  it must not append a user message (each queued entry was already
         *  shown optimistically when typed), but unlike it this IS a genuine
         *  user turn: it still pauses a self-driving goal/loop, still counts as
         *  a sent message, and still goes through delegation routing. Kept as
         *  its own flag rather than reusing `skipUserAppend` precisely so those
         *  three behaviors don't silently disappear. */
        steerDrain?: boolean
        /** Target session — defaults to the focused session. A multi-pane
         *  composer passes its own session id so each pane sends to itself. */
        sessionId?: string
        /** Private Context Workbench snapshot/selection. This is never exposed
         *  to plugin prompt hooks or persisted as visible message content. */
        resourceContext?: string
        /** Provenance for the leading attachment blocks, from
         *  `buildSendContent`. Lets the optimistic user message render file
         *  cards (with filenames) instead of raw extracted text. */
        attachmentManifest?: readonly AttachmentManifestEntry[]
        /** Stamp the optimistic USER message into a branch group.
         *
         *  Set by `editAndResend`, which keeps the original question as a
         *  sibling instead of deleting it. Passed explicitly rather than via a
         *  pending-tag ref (the shape `regenerate` uses) because the message
         *  being tagged is created right here — a ref would have to survive
         *  until an SDK event arrives, which is only necessary when the target
         *  is an assistant message that does not exist yet. */
        branchTag?: { groupId: string; index: number }
      }
    ) => {
      const sessionId = callOptions?.sessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) {
        useChatStore.getState().setError(tInlineErr("noSession"))
        return
      }
      if (typeof content === "string" && !content.trim()) return
      if (Array.isArray(content) && content.length === 0) return

      // Concurrency cap backstop: never start a turn over the global execution
      // ceiling. The composer already disables send + shows the inline over-cap
      // notice; this guards programmatic sends too. A session that is already
      // streaming is a continuation and never blocked (the broker exempts it).
      // The cap now reflects the unified ExecutionBroker occupancy — headless
      // legs (scheduler / connector / workflow / team) included — not just the
      // renderer's streaming panels.
      if (getExecutionBroker().isAtCapacity("ai-turn", sessionId)) {
        console.warn("send blocked: concurrent stream cap reached", { sessionId })
        return
      }

      // Steer instead of restart: a fresh user turn while THIS session is still
      // streaming / awaiting approval must never re-enter the normal send path —
      // a same-session send during a live turn makes the sidecar
      // close-and-restart it (host `restartReason`), silently dropping its
      // context. Internal re-issues (regenerate / routing fallback) pass
      // `skipUserAppend`, and the queue's own replay passes `steerDrain`; both
      // bypass this.
      if (!callOptions?.skipUserAppend && !callOptions?.steerDrain) {
        const st = sessionStatusOf(sessionId)
        if (st === "streaming" || st === "awaiting_approval") {
          const text = steerTextOf(content)
          const blocks = steerBlocksOf(content)
          if (!text && blocks.length === 0) return

          // Show it immediately, in the user's own words. The model-facing
          // framing (`STEER_PREFIX`) is added only on the replay payload; the
          // transcript renders the original text via `stripSteerPrefix`. The
          // `steer` metadata rides along into Dexie so a restart can tell a
          // delivered follow-up from one that never arrived.
          const entryId = crypto.randomUUID()
          const steerMeta: SteerMessageMeta = { entryId, state: "queued" }
          const optimistic = makeUserMessage(content)
          ;(optimistic as { metadata?: Record<string, unknown> }).metadata = {
            ...((optimistic as { metadata?: Record<string, unknown> }).metadata ?? {}),
            steer: steerMeta,
          }
          appendSteerMessage(sessionId, optimistic)

          // Live steer — the message reaches the model without ending the turn.
          // Two lanes, both best-effort: an external adapter implementing
          // turn/steer (Codex app-server), or the Anthropic sidecar's streaming
          // input. Acceptance means the sidecar queued it into the running
          // query, NOT that the model has already acted on it, so the bubble
          // says "accepted" until the turn settles. Anything else (unsupported
          // provider, input already closed, transport hiccup) falls through to
          // the durable queue below.
          //
          // `awaiting_approval` is included deliberately: a turn paused on a
          // tool prompt still holds its input open, and it is the moment when
          // redirecting matters most — the composer stays writable there for
          // exactly that reason.
          //
          // The lane comes from what THIS session dispatched
          // (`sessionExternalLane`), not the composer's global runtime pick,
          // which in split view describes whichever pane happens to be focused.
          const externalAgentId = sessionExternalLane(sessionId)
          if (externalAgentId) {
            // Adapter steering carries text only (`turn/steer` takes a string),
            // so an attachment-only follow-up has to queue on this lane.
            if (text) {
              try {
                const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
                const mgr = getExternalAgentManager()
                if (mgr.supportsSteering(externalAgentId)) {
                  await mgr.steerSession(externalAgentId, undefined, text)
                  setSteerMessageState(sessionId, entryId, "accepted")
                  return
                }
              } catch (err) {
                console.warn("live steer failed; queueing instead", err)
              }
            }
          } else {
            // Anthropic streaming input. `steerSession` is PII-gated and rejects
            // non-Anthropic providers sidecar-side, so a wrong-provider session
            // simply falls through to the queue. It takes the whole `content`,
            // so an attachment-only follow-up goes live here too.
            try {
              const { steerSession } = await import("@/lib/claude/ipc")
              await steerSession(sessionId, content)
              setSteerMessageState(sessionId, entryId, "accepted")
              return
            } catch (err) {
              console.warn("live steer failed; queueing instead", err)
            }
          }

          useChatStore.getState().enqueueSteer(sessionId, {
            id: entryId,
            text,
            blocks: blocks.length > 0 ? blocks : undefined,
          })
          return
        }
      }

      // The turn is definitely running now, so make disk honest before the agent's
      // file tools read it. Those tools go straight to the filesystem, so a buffer
      // the user edited but never saved is invisible to them: the agent would
      // reason about stale content and its write would then clobber that work.
      // No-op when no project editor is mounted, which is the common case.
      const unflushed = await flushProjectEditorEdits()
      if (unflushed.length > 0) {
        // Proceed anyway — the turn may not touch these files at all — but say so,
        // because for those files disk is not what the user is looking at.
        toast.warning(
          tInlineErr("unflushedEditorBuffers", {
            count: unflushed.length,
            files: unflushed.join(", "),
          })
        )
      }

      const session = await getSession(sessionId)

      // ADR-0019 — a fresh user message while a goal is self-driving is
      // mid-course guidance: PAUSE the goal (rotates generationId + fires the
      // turn-driver abort) rather than terminating it; the user resumes with
      // `/goal resume`. The silent continuation dispatch passes
      // `skipUserAppend`, so it never trips this branch.
      if (!callOptions?.skipUserAppend) {
        const openGoal = await getGoalRuntime().getActiveGoalForSession(sessionId)
        if (openGoal) await getGoalRuntime().pauseGoal(openGoal.id)
        // Same posture for a self-paced /loop: a fresh user message is
        // mid-course guidance — pause rather than fight over the session.
        // Loop kick-offs and continuations pass `skipUserAppend`, so they
        // never trip this branch. Interval loops fire through the scheduler
        // and are unaffected by manual chatting.
        const openLoop = await getLoopRuntime().getActiveLoopForSession(sessionId)
        if (openLoop?.mode === "self_paced") {
          clearPendingLoopContinuation(openLoop.id)
          await getLoopRuntime().pauseLoop(openLoop.id)
        }
      }

      // Extract a plain-text version of the user message for twin RAG. The
      // multimodal path (array of blocks) finds the first text block; if
      // none we leave userMessage undefined and the runtime falls back to
      // the no-context path.
      const userMessageText =
        typeof content === "string"
          ? content
          : (content.find((b) => b.type === "text") as { text?: string } | undefined)?.text
      let sendOptions: SendOptions
      try {
        sendOptions = opts ?? (await buildSendOptions(session, userMessageText))
      } catch (err) {
        // RoutingNoCandidatesError (alias matched, every deployment down)
        // and any other resolver failure surface as the chat error instead
        // of an unhandled rejection.
        const error = err instanceof Error ? err : new Error(String(err))
        useChatStore
          .getState()
          .setSessionDiagnostic(
            sessionId,
            toDiagnostic(error, { source: "chat", meta: { sessionId } })
          )
        return
      }

      // ephemeralSkillIds were consumed by buildSendOptions; clear them so
      // the next turn starts with a fresh attachment set.
      if ((useChatStore.getState().ephemeralSkillIds ?? []).length > 0) {
        useChatStore.getState().clearEphemeralSkillIds?.()
      }

      // Apply per-command frontmatter overrides set by the composer when the
      // user picked a custom slash command. Cleared after merge so the next
      // turn doesn't inherit them.
      const pending = useChatStore.getState().pendingCommandOverrides
      if (pending) {
        sendOptions = {
          ...sendOptions,
          model: pending.model ?? sendOptions.model,
          allowedTools: pending.allowedTools
            ? Array.from(new Set([...(sendOptions.allowedTools ?? []), ...pending.allowedTools]))
            : sendOptions.allowedTools,
          additionalDirectories: pending.paths
            ? Array.from(new Set([...(sendOptions.additionalDirectories ?? []), ...pending.paths]))
            : sendOptions.additionalDirectories,
        }
        useChatStore.getState().setPendingCommandOverrides(null)
      }

      // Plugin PostToolUse (W3.1): only pay for the sidecar's
      // tool_result_review round-trip when a plugin actually listens. The
      // review events are answered in the `tool_result_review` case of the
      // message pump below.
      if (hasPostToolUseListeners()) {
        sendOptions = { ...sendOptions, toolResultReviewEnabled: true }
      }

      // Advisory daily-budget overage — the routing engine selected a provider
      // that is past its dailyCostBudget because nothing under budget was
      // available. Surface once per provider per local day; never blocks.
      notifyOverBudgetOnce(sendOptions.routingDecision?.overBudgetWarning, (v) =>
        tRouting("overBudgetToast", v)
      )

      // Advisory capability drop — the chosen reasoning effort was silently
      // dropped because the resolved model can't honour it. Surface once per
      // model so the setting doesn't vanish without feedback; never blocks.
      notifyDroppedCapabilityOnce(sendOptions.droppedCapabilityWarning, (v) =>
        tRouting("droppedEffortToast", v)
      )

      // Plugin opt-in — fire `onUserPromptSubmit` before the network call.
      // Block / modify / proceed semantics:
      //   • "block" — surface the plugin's reason as the chat error and bail.
      //   • "modify" — when the plugin returns `modifiedPrompt` and the
      //     content is plain text, replace it; multimodal content is left
      //     alone (mod APIs only describe text).
      //   • "modify" with `additionalContext` — fold into the appendSystemPrompt
      //     slot so the SDK passes it through as a system-prompt extension.
      // Errors bubble up as `proceed` (adapter-hooks swallows internally).
      let effectiveContent: SendContent = content
      const promptText =
        typeof content === "string"
          ? content
          : ((content.find((b) => b.type === "text") as { text?: string } | undefined)?.text ?? "")
      const promptDecision = await dispatchPluginUserPromptSubmit(
        promptText,
        sessionId,
        // Cast — the dispatcher's structural shape accepts any subset.
        {} as never
      )
      if (promptDecision.action === "block") {
        store.getState().setSessionDiagnostic(
          sessionId,
          createDiagnostic("promptBlockedByPlugin", {
            source: "plugin",
            message: promptDecision.reason ?? "",
            meta: { sessionId },
          })
        )
        return
      }
      if (promptDecision.action === "modify") {
        if (typeof promptDecision.modifiedPrompt === "string") {
          if (typeof content === "string") {
            effectiveContent = promptDecision.modifiedPrompt
          } else {
            // Replace the first text block with the modified prompt and keep
            // the rest of the content (attachments, etc.) intact.
            effectiveContent = content.map((block) => {
              if (block.type === "text") {
                return { ...block, text: promptDecision.modifiedPrompt as string } as typeof block
              }
              return block
            })
          }
        }
        const additionalContext = (promptDecision as { additionalContext?: string })
          .additionalContext
        if (typeof additionalContext === "string" && additionalContext.trim()) {
          const existing = sendOptions.appendSystemPrompt?.trim() ?? ""
          sendOptions = {
            ...sendOptions,
            appendSystemPrompt: existing
              ? `${existing}\n\n${additionalContext}`
              : additionalContext,
          }
        }
      }

      // Pipeline hook (W3.3): `onMessageSend` — plugins may rewrite the
      // outgoing user message. Same text-only constraint as `modifiedPrompt`;
      // attachments and non-text blocks are untouched. Runs AFTER
      // onUserPromptSubmit so a block decision wins over a rewrite.
      {
        const outboundText =
          typeof effectiveContent === "string"
            ? effectiveContent
            : ((effectiveContent.find((b) => b.type === "text") as { text?: string } | undefined)
                ?.text ?? "")
        const piped = await dispatchPluginMessageSend({
          id: `${sessionId}:outbound`,
          role: "user",
          content: outboundText,
        })
        if (typeof piped?.content === "string" && piped.content !== outboundText) {
          if (typeof effectiveContent === "string") {
            effectiveContent = piped.content
          } else {
            effectiveContent = effectiveContent.map((block) =>
              block.type === "text" ? ({ ...block, text: piped.content } as typeof block) : block
            )
          }
        }
      }

      // New turn: drop any coalesced/debounced streaming work and the mirror
      // from a prior turn (this session only) so its events read the fresh
      // optimistic base. Other sessions' coalescing is untouched.
      registry.release(sessionId)
      messagesMirrorRef.current.delete(sessionId)

      // Optimistic user-message append. Skipped during regenerate so the
      // existing user anchor stays the single source of truth for that turn.
      // Base off this session's own slice — never the focused projection.
      const previousMessages = store.getState().sessions[sessionId]?.messages ?? []
      const userMsg = makeUserMessage(effectiveContent, undefined, callOptions?.attachmentManifest)
      // Structured mention capture: persist the message's inline `@…` tokens
      // as `metadata.mentions: ContextRef[]` so mentions are queryable without
      // regex re-parsing. Known subagent handles resolve to their kind; other
      // tokens fall back to `file` (the CLI's native reading of `@path`).
      // Markdown-agent handles need async discovery and resolve as `file`
      // here — a documented v1 narrowing, not a routing change (routing still
      // uses the full union in resolveTargetAgentId below).
      const mentionSourceText =
        typeof effectiveContent === "string"
          ? effectiveContent
          : effectiveContent
              .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
              .map((b) => b.text)
              .join("\n")
      if (mentionSourceText.includes("@")) {
        const mentionTargets = buildChatMentionTargets()
        const mentionRefs = resolveMentions(mentionSourceText, {
          resolveAgentHandle: (name) => {
            const hit = mentionTargets.find((t) => t.handle === name)
            return hit ? { kind: "subagent", id: hit.handle, label: hit.name } : null
          },
        })
        if (mentionRefs.length > 0) {
          ;(userMsg as { metadata?: Record<string, unknown> }).metadata = {
            ...((userMsg as { metadata?: Record<string, unknown> }).metadata ?? {}),
            mentions: mentionRefs,
          }
        }
      }
      // Edit-as-branch: the replacement joins the original's sibling group, and
      // is selected right away so the user sees their edit rather than watching
      // it disappear behind a previously-pinned sibling.
      if (callOptions?.branchTag) {
        ;(userMsg as { metadata?: Record<string, unknown> }).metadata = {
          ...((userMsg as { metadata?: Record<string, unknown> }).metadata ?? {}),
          branchGroupId: callOptions.branchTag.groupId,
          branchIndex: callOptions.branchTag.index,
        }
        store
          .getState()
          .setSessionActiveBranch(sessionId, callOptions.branchTag.groupId, userMsg.id)
      }
      // Both flags mean "the user turn is already in the transcript": a
      // regenerate re-issues an existing one, a steer drain replays entries that
      // were appended optimistically when typed. Appending again would double
      // them. They diverge only on the *other* effects of a user turn — see
      // `steerDrain`'s doc on the option type.
      const skipAppend = callOptions?.skipUserAppend === true || callOptions?.steerDrain === true
      const next = skipAppend ? previousMessages : [...previousMessages, userMsg]
      const displayContent = effectiveContent
      const shouldGateWorkbenchPayload =
        callOptions?.resourceContext !== undefined || isEmbeddedSession(session ?? {})
      const providerPayload = shouldGateWorkbenchPayload
        ? gateWorkbenchProviderPayload(
            { content: displayContent, sendOptions, messages: next },
            callOptions?.resourceContext
          )
        : { content: displayContent, sendOptions, messages: next }
      effectiveContent = providerPayload.content
      sendOptions = providerPayload.sendOptions
      const providerText =
        typeof effectiveContent === "string"
          ? effectiveContent
          : ((
              effectiveContent.find((block) => block.type === "text") as
                { text?: string } | undefined
            )?.text ?? "")
      if (!skipAppend) {
        store.getState().replaceSessionMessages(sessionId, next)
      }
      // Register this chat turn with the global execution broker so it counts
      // toward — and is observable / cancellable via — the same governor as
      // every headless leg. Acquired before the `streaming` flip so the broker
      // watcher releases it on settle; gated by the `isAtCapacity` check above,
      // so it admits immediately. Best-effort: a broker hiccup never blocks the
      // turn the user already committed to.
      try {
        await acquireChatLease({
          sessionId,
          projectId: session?.projectId,
          label: session?.title || `#${sessionId.slice(0, 8)}`,
        })
      } catch (leaseErr) {
        console.warn("chat lease acquire failed; sending without admission", leaseErr)
      }
      store.getState().setSessionStatus(sessionId, "streaming")
      chatTurnPerformance.begin(sessionId)
      store.getState().setSessionError(sessionId, null)
      lastUserContentRef.current.set(sessionId, displayContent)
      if (callOptions?.resourceContext !== undefined) {
        lastResourceContextRef.current.set(sessionId, callOptions.resourceContext)
      }
      // Plugin bus: the turn has committed (past the prompt-submit block gate).
      // ids only — never the prompt text (PII red-line). Covers all run paths
      // (external + SDK) since this is upstream of the branch below.
      emitSystemBusEvent(SystemEvents.MESSAGE_SENT, { sessionId })
      emitSystemBusEvent(SystemEvents.AGENT_STARTED, { sessionId })
      if (!callOptions?.skipUserAppend) {
        behaviorTurnStartedAt.set(sessionId, Date.now())
        void trackEvent("chat.message.sent", {
          sessionId,
          provider:
            sendOptions.provider ??
            (useAgentRuntimeStore.getState().runtime === "external" ? "external" : "unknown"),
          surface: "chat",
        })
      }

      // Experimental task workspace: snapshot the live workspace and redirect
      // this turn into an isolated worktree/shadow root before any agent starts.
      // Regenerate/continuation keeps the same user-message task id while the
      // chat run id creates a distinct TaskRun version.
      const chatRunId = store.getState().sessions[sessionId]?.runId ?? 0
      if (
        useSettingsStore.getState().settings?.developer?.taskWorkspace === true &&
        sendOptions.cwd
      ) {
        const anchorMessage = skipAppend
          ? [...previousMessages].reverse().find((message) => message.role === "user")
          : userMsg
        const taskEnvelope = {
          taskId: taskIdForMessage(anchorMessage?.id ?? userMsg.id),
          sessionId,
          runId: runIdForTurn(sessionId, chatRunId),
          executionRunId: runIdForTurn(sessionId, chatRunId),
          turnId: anchorMessage?.id ?? userMsg.id,
          attemptId: "a1",
          surface: "chat",
          agentId: "built-in",
          agentKind: "in-app",
          workspaceRoot: sendOptions.cwd,
        }
        const taskLease = await openTaskWorkspaceRunLease(taskEnvelope)
        sendOptions = { ...sendOptions, taskWorkspace: taskEnvelope }
        if (taskLease) {
          sendOptions = { ...sendOptions, cwd: taskLease.run.executionRoot }
        }
      }

      // Code-adoption tracking (Phase 1): open a per-turn attribution window.
      // Fire-and-forget — must never block or disrupt the turn. `runId` is read
      // back from the store, whose streaming flip above bumped it for this turn.
      void beginCodeAdoptionTurn(sendOptions.cwd, {
        sessionId,
        runId: chatRunId,
        model: sendOptions.model ?? null,
        agentKind: "in-app",
      })

      // ── External agent branch ──────────────────────────────────────────
      // When the user selected "external" runtime in the composer toolbar,
      // dispatch to the external agent manager instead of the Claude SDK
      // sidecar. The optimistic user-message stays in the store so the
      // composer reflects the send immediately; the assistant reply is
      // appended from the manager result when it lands.
      const agentRuntime = useAgentRuntimeStore.getState().runtime
      const manualExternal = agentRuntime === "external"

      // ── Thread B: rule-based delegation ─────────────────────────────────
      // When the user did NOT manually pick the external runtime, evaluate the
      // persisted delegation rules. A matching rule redirects this turn to its
      // target external agent (with the prompt PII-filtered). Skipped for
      // silent goal/loop continuations and on the built-in fallback re-entry,
      // and a no-op when no external agents are connected (web/mobile).
      let delegation: import("@/lib/ai/agent/external/delegation-router").RoutingDecision | null =
        null
      if (!manualExternal && !callOptions?.skipUserAppend && !callOptions?.bypassDelegation) {
        try {
          const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
          const mgr = getExternalAgentManager()
          if (mgr.getConnectedAgents().length > 0) {
            mgr.setDelegationRules(useExternalAgentStore.getState().delegationRules)
            const [{ routeDelegation }, { redactText }] = await Promise.all([
              import("@/lib/ai/agent/external/delegation-router"),
              import("@cognia/redact"),
            ])
            const decision = routeDelegation(
              { prompt: providerText, context: { sessionId } },
              {
                checkDelegation: (t, c) => mgr.checkDelegation(t, c),
                // PII gate ON for delegated external sends — the prompt leaves
                // the trust boundary to a third-party CLI.
                redact: (text) => redactText(text),
              }
            )
            if (decision.shouldDelegate) delegation = decision
          }
        } catch (err) {
          // Routing must never block a send — fall through to the built-in path.
          console.error("delegation routing failed", err)
        }
      }

      if (manualExternal || delegation) {
        const extAgentId = manualExternal
          ? useAgentRuntimeStore.getState().externalAgentId
          : delegation!.targetAgentId
        if (!extAgentId) {
          store.getState().replaceSessionMessages(sessionId, previousMessages)
          store.getState().setSessionDiagnostic(
            sessionId,
            createDiagnostic("externalAgentNotSelected", {
              source: "external-agent",
              meta: { sessionId },
            })
          )
          store.getState().setSessionStatus(sessionId, "idle")
          chatTurnPerformance.finish(sessionId, "failed")
          return
        }
        // Record the lane this session's turn is actually on, so a follow-up
        // typed while it runs steers this agent rather than whatever the
        // composer's global runtime selector happens to say (see
        // `sessionExternalLane`). Cleared when the turn settles, in
        // `maybeDrainSteer`.
        setSessionExternalLane(sessionId, extAgentId)
        // The text sent to the external agent: the PII-filtered prompt when
        // delegated by rule, else the raw composer text.
        const externalSendText = delegation ? delegation.filteredPrompt : providerText
        // Badge metadata so the assistant bubble can show "delegated to <rule>".
        const delegatedMeta = delegation
          ? {
              delegatedTo: {
                agentId: extAgentId,
                ruleId: delegation.matchedRuleId,
                ruleName: delegation.matchedRuleName,
              },
            }
          : undefined

        // B3 — failure fallback. A rule-delegated turn that fails falls back to
        // the built-in (trusted, in-process) path when `chatFailurePolicy` is
        // "fallback"; under "strict" it surfaces the error like a manual run.
        const chatFailurePolicy = useExternalAgentStore.getState().chatFailurePolicy
        const handleExternalFailure = async (message: string, error?: Error): Promise<void> => {
          if (delegation && chatFailurePolicy === "fallback") {
            // Keep the user turn, drop any partial external assistant, then
            // re-issue THIS turn through the SDK path (skipUserAppend so the
            // user message isn't duplicated; bypassDelegation so we don't
            // re-match the same rule and loop).
            store.getState().replaceSessionMessages(sessionId, next)
            store.getState().setSessionError(sessionId, null)
            await sendRef.current?.(displayContent, opts, {
              ...callOptions,
              skipUserAppend: true,
              bypassDelegation: true,
            })
            // Disclose the substitution. The user routed this turn to a specific
            // external agent; it ran on the built-in one instead, which changes
            // cost, tooling and output. Silently succeeding looked identical to
            // the agent having worked.
            dispatchDiagnostic(
              createDiagnostic("fallbackToBuiltin", {
                source: "external-agent",
                message,
                meta: { sessionId, agentId: extAgentId },
              })
            )
            return
          }
          const durationMs = finishBehaviorTurn(sessionId)
          if (durationMs !== undefined) {
            void trackEvent("chat.turn.failed", {
              sessionId,
              provider: "external",
              surface: "chat",
              errorType: error?.name || "ExternalAgentError",
              durationMs,
            })
          }
          chatTurnPerformance.finish(sessionId, "failed")
          store.getState().replaceSessionMessages(sessionId, previousMessages)
          store.getState().setSessionDiagnostic(
            sessionId,
            toDiagnostic(error ?? message, {
              source: "external-agent",
              meta: { sessionId, agentId: extAgentId },
            })
          )
          store.getState().setSessionStatus(sessionId, "idle")
          if (error) dispatchPluginChatError(sessionId, error)
        }

        try {
          await persistMessages(sessionId, next)
          await touchSession(sessionId)
          await applyInstantTitle(sessionId, displayContent)

          const { executeOnExternalAgent } = await import("@/lib/ai/agent/external/manager")
          const { applyExternalAgentEventToParts } =
            await import("@/lib/ai/agent/external/event-to-parts")

          // Pre-allocate the assistant message so partial deltas land in it
          // without flickering the chat list. Parts start empty and grow as
          // ExternalAgentEvents arrive via the onEvent callback below.
          const assistantId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          let assistantParts: UIMessage["parts"] = [] as unknown as UIMessage["parts"]
          const baseList = store.getState().sessions[sessionId]?.messages ?? []

          const writeAssistant = () => {
            // Write into this session's *own* slice — a mid-run focus switch is
            // safe because the slice is keyed by session, so the in-flight
            // external turn lands in its pane (live in background or focused),
            // never clobbering whatever session is now focused.
            const assistantMsg: UIMessage = {
              id: assistantId,
              role: "assistant",
              parts: assistantParts,
              ...(delegatedMeta ? { metadata: delegatedMeta } : {}),
            }
            store.getState().replaceSessionMessages(sessionId, [...baseList, assistantMsg])
          }

          chatTurnPerformance.markDispatched(sessionId)
          const result = await executeOnExternalAgent(externalSendText, {
            agentId: extAgentId,
            workingDirectory: sendOptions.cwd,
            // The composer's thinking level, which before this reached only the
            // built-in runtime — on an external agent the control was silently
            // inert. `sendOptions.effort` already carries the resolved
            // precedence chain (IM override > session > bot > app default), and
            // the adapter folds it onto whatever ladder its model publishes.
            ...(sendOptions.effort ? { reasoningEffort: sendOptions.effort } : {}),
            context: {
              custom: {
                additionalDirectories: sendOptions.additionalDirectories ?? [],
              },
            },
            onEvent: (event) => {
              const nextParts = applyExternalAgentEventToParts(assistantParts, event)
              if (nextParts !== assistantParts) {
                assistantParts = nextParts as UIMessage["parts"]
                chatTurnPerformance.markFirstResponse(sessionId)
                writeAssistant()
              }
            },
          })

          if (!result) {
            await handleExternalFailure("No external agent available for this request")
            return
          }

          if (!result.success) {
            await handleExternalFailure(result.error ?? "External agent execution failed")
            return
          }

          // When the event stream never produced a text track (some agents
          // only emit a single final response), fall back to the assembled
          // finalResponse to make sure the user always sees something.
          if (
            assistantParts.length === 0 ||
            !assistantParts.some(
              (p) => (p as { type?: string }).type === "text" && (p as { text?: string }).text
            )
          ) {
            assistantParts = [
              ...(assistantParts as unknown as Array<Record<string, unknown>>),
              { type: "text", text: result.finalResponse, state: "done" },
            ] as unknown as UIMessage["parts"]
            chatTurnPerformance.markFirstResponse(sessionId)
            writeAssistant()
          }

          // Persist this session's final list. The slice already holds the
          // live writes (keyed by session), so read it back; fall back to a
          // locally-assembled list if the slice was somehow cleared.
          const finalAssistant: UIMessage = {
            id: assistantId,
            role: "assistant",
            parts: assistantParts,
            ...(delegatedMeta ? { metadata: delegatedMeta } : {}),
          }
          const finalMessages = store.getState().sessions[sessionId]?.messages ?? [
            ...baseList,
            finalAssistant,
          ]
          chatTurnPerformance.beginFinalPersistence(sessionId)
          await persistMessages(sessionId, finalMessages)
          chatTurnPerformance.endFinalPersistence(sessionId)
          store.getState().setSessionStatus(sessionId, "idle")
          chatTurnPerformance.finish(sessionId, "completed")
          const durationMs = finishBehaviorTurn(sessionId)
          if (durationMs !== undefined) {
            void trackEvent("chat.turn.completed", {
              sessionId,
              provider: "external",
              surface: "chat",
              durationMs,
            })
          }
          // Plugin bus: external-agent run finished (ids only).
          emitSystemBusEvent(SystemEvents.MESSAGE_RECEIVED, { sessionId })
          emitSystemBusEvent(SystemEvents.AGENT_COMPLETED, { sessionId })
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err))
          await handleExternalFailure(error.message, error)
        }
        return
      }
      // ── End external agent branch ──────────────────────────────────────

      // This turn runs on the built-in sidecar, so the session has no external
      // lane — clear any left by a previous turn before a follow-up reads it.
      setSessionExternalLane(sessionId, null)

      try {
        await persistMessages(sessionId, next)
        await touchSession(sessionId)
        // If the session has no title yet, derive one from the first prompt.
        // `titleAuto` marks the title as machine-set so the turn-complete path
        // may later upgrade it to an LLM-generated title (until the user
        // manually renames, which clears the flag).
        await applyInstantTitle(sessionId, displayContent)
        // Open an agent-trace span for this chat turn. The traceId / spanId
        // are echoed through SendOptions so the sidecar (and later, tool +
        // sub-agent spans) can attach as children. `endSpan` runs in the
        // result / error branches of `handleEvent` keyed off the cached
        // sendOptions, so the span is finalized regardless of which path
        // closes the turn.
        if (!sendOptions.spanId) {
          const handle = startSpan({
            operationName: "invoke_agent",
            providerName: "anthropic",
            sessionId,
            surface: "chat",
            requestModel: sendOptions.model,
            agentId: session?.characterId,
            metadata: sendOptions.provider ? { provider: sendOptions.provider } : undefined,
            inputPreview: providerText || undefined,
          })
          sendOptions = {
            ...sendOptions,
            traceId: handle.traceId,
            spanId: handle.spanId,
            traceparent: toTraceparent({
              traceId: handle.traceId,
              rootSpanId: handle.spanId,
            }),
          }
        }
        if (!sendOptions.traceparent && sendOptions.traceId && sendOptions.spanId) {
          sendOptions = {
            ...sendOptions,
            traceparent: toTraceparent({
              traceId: sendOptions.traceId,
              rootSpanId: sendOptions.spanId,
            }),
          }
        }
        if (sendOptions.traceId && sendOptions.spanId) {
          useTaskWorkspaceStore
            .getState()
            .bindTrace(sessionId, sendOptions.traceId, sendOptions.spanId)
        }
        if (sendOptions.spanId && sendOptions.routingPlan) {
          const plan = sendOptions.routingPlan
          recordEvent(sendOptions.spanId, {
            name: "routing.plan",
            at: Date.now(),
            attributes: {
              decisionId: plan.decisionId,
              surface: plan.surface,
              strategy: plan.strategy,
              providerId: plan.selected.providerId,
              modelId: plan.selected.modelId,
              candidateCount: plan.orderedCandidates.length,
              reasonCodes: plan.reasonCodes,
              ...(plan.classification
                ? {
                    category: plan.classification.category,
                    complexity: plan.classification.complexity,
                    difficultyScore: plan.classification.difficultyScore,
                  }
                : {}),
            },
          })
          recordEvent(sendOptions.spanId, {
            name: "routing.attempt",
            at: Date.now(),
            attributes: {
              decisionId: plan.decisionId,
              attemptIndex: 0,
              providerId: plan.selected.providerId,
              modelId: plan.selected.modelId,
            },
          })
          if (plan.shadowComparison?.differs) {
            recordEvent(sendOptions.spanId, {
              name: "routing.shadow_diff",
              at: Date.now(),
              attributes: {
                decisionId: plan.decisionId,
                selectedProviderId: plan.selected.providerId,
                selectedModelId: plan.selected.modelId,
                shadowProviderId: plan.shadowComparison.selected.providerId,
                shadowModelId: plan.shadowComparison.selected.modelId,
              },
            })
          }
        }
        if (isStandaloneChatMode()) {
          // Standalone (BYOK): run the turn in-renderer against the user's own
          // provider. Fire-and-forget like `sendPrompt` — streaming reaches the
          // store via the same event queue; the engine emits `session_ended`.
          const controller = new AbortController()
          standaloneAbortRef.current.set(sessionId, controller)
          chatTurnPerformance.markDispatched(sessionId)
          void runStandaloneTurn({
            sessionId,
            messages: providerPayload.messages,
            sendOptions,
            emit: enqueueClaudeEvent,
            signal: controller.signal,
          }).finally(() => {
            if (standaloneAbortRef.current.get(sessionId) === controller) {
              standaloneAbortRef.current.delete(sessionId)
            }
          })
        } else {
          chatTurnPerformance.markDispatched(sessionId)
          await sendPrompt(sessionId, effectiveContent, sendOptions)
        }
        // Conversation-branching: consume the one-shot context seed now that
        // `resolveSendOptions` has injected it into this send's
        // `appendSystemPrompt`. Provider-agnostic once-only consumption — the
        // ai-sdk path may never capture an `sdkSessionId`, so we can't rely on
        // that gate alone. Fire-and-forget; failure just leaves the seed to be
        // (harmlessly) re-injected next turn.
        if (session?.branchSeed) {
          void clearBranchSeed(sessionId).catch((err) =>
            console.error("clearBranchSeed failed", err)
          )
          // Freeze-on-continue (ADR-0062): the user is now continuing an
          // imported session, so Cognia takes ownership — the fs-watch
          // re-import guard must stop mirroring source-side edits. This is the
          // exact first-continuation signal (imported sessions always carry a
          // `branchSeed`, consumed once here).
          if (sessionId.startsWith("import:")) {
            void freezeImportedSession(sessionId).catch((err) =>
              console.error("freezeImportedSession failed", err)
            )
          }
        }
        // Cache the post-routing send so a transient `session_ended.error`
        // can re-issue the turn against the next entry in the alias's
        // fallback chain. Set even when there is no alias — the retry
        // path checks `aliasResolution.fallbackEntries.length` before
        // doing anything.
        useChatStore.getState().setLastSend(sessionId, {
          content: effectiveContent,
          options: sendOptions,
          attemptIndex: 0,
          routingCommitted: false,
        })
        // Least-busy signal: this turn is now in flight against the resolved
        // deployment; `session_ended` (any flavor) settles it.
        if (sendOptions.provider) {
          useInFlightStore
            .getState()
            .begin(sessionId, sendOptions.provider, { modelId: sendOptions.model })
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        store.getState().setSessionDiagnostic(
          sessionId,
          toDiagnostic(error, {
            source: "chat",
            meta: { sessionId, ...(sendOptions.spanId ? { spanId: sendOptions.spanId } : {}) },
          })
        )
        // Notify plugins; fire-and-forget — host already surfaced the error.
        dispatchPluginChatError(sessionId, error)
        // Local pre-sidecar failure — close the agent-trace span we just
        // opened so it doesn't dangle (no result event will ever land).
        if (sendOptions.spanId) {
          endSpan(sendOptions.spanId, {
            errorType: "send_failed",
            errorMessage: error.message,
          })
        }
        chatTurnPerformance.finish(sessionId, "failed")
        const durationMs = finishBehaviorTurn(sessionId)
        if (durationMs !== undefined) {
          void trackEvent("chat.turn.failed", {
            sessionId,
            surface: "chat",
            errorType: "send_failed",
            durationMs,
            ...(sendOptions.provider ? { provider: sendOptions.provider } : {}),
          })
        }
      }
    },
    [store, tRouting, tInlineErr, registry, enqueueClaudeEvent]
  )

  // Keep the module-scope `handleEvent` pointed at the latest `send` so it can
  // dispatch a silent goal continuation (ADR-0019) without closing over it.
  useEffect(() => {
    sendRef.current = send
    return () => {
      if (sendRef.current === send) sendRef.current = null
    }
  }, [send])

  // Background-run result delivery: register the hook's send as the replay
  // channel, and drain pending results whenever a session (re)opens idle —
  // covers relaunches (journaled pending rows) and panes closed at settle.
  useEffect(() => {
    return registerBackgroundReplaySend((framedText, sessionId) => {
      void sendRef.current?.(framedText, undefined, { sessionId })
    })
  }, [])
  const openSessionIdsForDrain = useChatStore((s) => s.openSessionIds)
  useEffect(() => {
    for (const sessionId of openSessionIdsForDrain) maybeDrainBackgroundResults(sessionId)
  }, [openSessionIdsForDrain])

  // Self-paced /loop kick-off: when the runtime creates or resumes a loop
  // for the ACTIVE session, dispatch its next iteration silently — the same
  // skipUserAppend path as every later continuation, so the send never trips
  // the fresh-user-message preempt above.
  useEffect(() => {
    const unsub = getLoopRuntime().onKickoff((loop) => {
      if (loop.sessionId !== activeRef.current) return
      void sendRef.current?.(renderLoopIterationMessage(loop), undefined, {
        skipUserAppend: true,
      })
    })
    return unsub
  }, [])

  const stop = useCallback(
    async (targetSessionId?: string) => {
      // Each pane wires its own Stop to its own session id; default to focused.
      const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return
      // Plain stop discards any queued steer — the user is taking over, not
      // steering — and disarms the drain so the settle doesn't replay it.
      useChatStore.getState().clearSteerQueue(sessionId)
      steerArmed.delete(sessionId)

      // Seal the renderer state before waiting for the IPC acknowledgement.
      // `claude_interrupt` is best-effort transport control; if its promise is
      // delayed by a busy sidecar, the GUI must still leave the streaming
      // state immediately and preserve the latest partial response.
      const coalesce = registry.get(sessionId)
      coalesce?.commit.flush()
      coalesce?.persist.flush()
      registry.release(sessionId)
      messagesMirrorRef.current.delete(sessionId)
      const chat = store.getState()
      for (const approval of chat.sessions[sessionId]?.pendingApprovals ?? []) {
        if (approval.status !== "interrupted") {
          chat.markApprovalInterrupted(approval.requestId, approval.sessionId, "aborted")
        }
      }
      const endingRunId = chat.sessions[sessionId]?.runId
      if (typeof endingRunId === "number") {
        markTaskWorkspaceTurnCancelled(sessionId, endingRunId)
      }
      chat.setSessionStatus(sessionId, "idle")
      chatTurnPerformance.finish(sessionId, "cancelled")

      try {
        // Standalone (BYOK) turns are cancelled by aborting the renderer
        // streamText loop; the engine then emits its own `session_ended`. The
        // sidecar path interrupts the host instead. The follow-up
        // `session_ended` remains idempotent with the optimistic local seal.
        const standaloneController = standaloneAbortRef.current.get(sessionId)
        if (standaloneController) {
          standaloneController.abort()
          standaloneAbortRef.current.delete(sessionId)
        } else {
          await interruptSession(sessionId)
        }
      } catch (err) {
        console.error("interrupt failed", err)
      }
    },
    [store, registry]
  )

  // "Interrupt & steer now": cut the running turn short so its settle replays
  // the queued steer immediately, instead of waiting for the turn to finish.
  // Arming covers the case where the abort surfaces as an errored
  // `session_ended`. No-op when nothing is queued.
  const interruptAndSteer = useCallback(async (targetSessionId?: string) => {
    const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
    if (!sessionId) return
    const queued = useChatStore.getState().sessions[sessionId]?.steerQueue ?? []
    if (queued.length === 0) return
    steerArmed.add(sessionId)
    try {
      await interruptSession(sessionId)
    } catch (err) {
      console.error("interrupt(steer) failed", err)
      steerArmed.delete(sessionId)
    }
  }, [])

  // Replay a session's queued steer NOW, without a turn boundary. Used by the
  // Run Panel after an errored settle, where the queue is preserved but no
  // settle event is coming — `interruptAndSteer` can't help (nothing to
  // interrupt), so we drain directly. No-op when the queue is empty.
  const flushSteer = useCallback((targetSessionId?: string) => {
    const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
    if (!sessionId) return
    drainSteerVia(sessionId, sendRef)
  }, [])

  const respondToApproval = useCallback(
    async (approval: PendingApproval, decision: ApprovalDecision): Promise<void> => {
      // Built-in-skill desktop consent (W2 dual-channel HITL): synthetic
      // approvals are resolved IN-RENDERER via the approval registry — there
      // is no sidecar-side permission waiting, so `approveTool` must never
      // see these request ids. "Always allow" maps to a session-scoped
      // bypass (skills are renderer-side; the sidecar ruleset doesn't apply).
      {
        const { isBuiltInSkillApprovalRequestId, grantDesktopSkillSessionBypass } =
          await import("@/lib/skills/built-in/desktop-hitl")
        if (isBuiltInSkillApprovalRequestId(approval.requestId)) {
          if (decision === "allow_always") {
            grantDesktopSkillSessionBypass(approval.sessionId, approval.toolName)
          }
          const { resolveApproval } = await import("@/lib/connectors/hitl/approval-registry")
          resolveApproval(approval.sessionId, approval.requestId, {
            decision: decision === "deny" ? "deny" : "allow",
          })
          store.getState().clearApproval(approval.requestId, approval.sessionId)
          return
        }
      }
      // Realtime voice tool approvals — same in-renderer contract as the
      // built-in-skill branch above: there is no sidecar-side waiter, so these
      // ids must never reach `approveTool`. "Always allow" writes an explicit
      // `toolRules` entry rather than falling through to `alwaysAllowTools`,
      // because `deriveAllowRuleFromApproval` returns null for plugin tools and
      // that bare list is only consulted by the sidecar — the voice session
      // would have kept asking forever.
      {
        const { isRealtimeToolApprovalRequestId, grantRealtimeToolAlwaysAllow } =
          await import("@/lib/voice/live/approval")
        if (isRealtimeToolApprovalRequestId(approval.requestId)) {
          if (decision === "allow_always") {
            const settingsState = useSettingsStore.getState()
            const ap = settingsState.settings?.agentPermissions ?? {}
            const nextRules = grantRealtimeToolAlwaysAllow(
              approval.sessionId,
              approval.toolName,
              ap.toolRules
            )
            await settingsState.save({ agentPermissions: { ...ap, toolRules: nextRules } })
          }
          const { resolveApproval } = await import("@/lib/connectors/hitl/approval-registry")
          resolveApproval(approval.sessionId, approval.requestId, {
            decision: decision === "deny" ? "deny" : "allow",
          })
          store.getState().clearApproval(approval.requestId, approval.sessionId)
          return
        }
      }
      // Persist the always-allow choice. Prefer a TARGET-SCOPED rule
      // (`Bash(git *)`, `Read(/path/x)`) so the grant is precise and future
      // matching calls auto-resolve via the sidecar ruleset — falling back to a
      // coarse tool-NAME grant only when no useful target can be extracted.
      if (decision === "allow_always") {
        const rule = deriveAllowRuleFromApproval(approval.toolName, approval.input)
        if (rule) {
          const settingsState = useSettingsStore.getState()
          const ap = settingsState.settings?.agentPermissions ?? {}
          const nextRules = setToolRule(ap.toolRules, rule.tool, rule.pattern, "allow")
          await settingsState.save({ agentPermissions: { ...ap, toolRules: nextRules } })
        } else {
          await useSettingsStore.getState().toggleAlwaysAllow(approval.toolName, true)
        }
      }
      // ADR-0020 W3 — remember the operator's Allow for any computer-use
      // plugin tool so subsequent turns inside this session skip the chat
      // modal when the active character's `chatConsentMode ===
      // "session-grant"`. The Rust ConsentBroker keeps its own
      // per-tuple session grants for defence-in-depth; this store only
      // governs the chat-side prompt cadence. Recording unconditionally
      // is safe because the SEND-side check
      // (`applyComputerUseTools`) consults `chatConsentMode` before
      // honouring a grant.
      if (decision === "allow" || decision === "allow_always") {
        if (isComputerUsePluginToolName(approval.toolName)) {
          const { recordSessionGrant } = await import("@/lib/claude/computer-use-session-grants")
          recordSessionGrant(approval.sessionId, approval.toolName)
        }
      }
      try {
        await approveTool(
          approval.sessionId,
          approval.requestId,
          decision === "allow_always" ? "allow" : decision
        )
      } finally {
        // Scope the clear to the approval's own session so resolving a gate in
        // one pane never disturbs another pane's pending queue.
        store.getState().clearApproval(approval.requestId, approval.sessionId)
      }
    },
    [store]
  )

  const close = useCallback(
    async (sessionId: string) => {
      try {
        await closeSession(sessionId)
      } catch (err) {
        console.error("close session failed", err)
      } finally {
        // Tear down this session's pane state: cancel its coalescing, drop its
        // streaming mirror, and remove its store slice / tab.
        chatTurnPerformance.finish(sessionId, "cancelled")
        registry.release(sessionId)
        messagesMirrorRef.current.delete(sessionId)
        useChatStore.getState().closeSession(sessionId)
        clearSessionGrants(sessionId)
        // Drop this session's nested-dispatch state (budget guard + resolved
        // permission ceiling) so neither leaks for the renderer's lifetime. Both
        // are keyed by session id and kept alive across a turn's multiple
        // dispatch_agent calls, so teardown is the only safe release point.
        const { releaseDispatchStateForSession } =
          await import("@/lib/claude/agents/dispatch-agent-handler")
        releaseDispatchStateForSession(sessionId)
      }
    },
    [registry]
  )

  /**
   * Resend a user message with edited content, keeping the original as a
   * sibling branch.
   *
   * This used to `truncateAfter(..., { inclusive: true })` — the original
   * question and every reply beneath it were deleted from Dexie outright, so
   * rewording a question halfway up a long thread silently destroyed the rest
   * of it with no undo. Regenerate had kept its alternatives as branches since
   * it was written; editing is the same shape of operation and now behaves the
   * same way. `tagEditSibling` stamps the original into a branch group and
   * re-parents its tail, and `selectVisibleMessages` hides that tail while the
   * new variant is selected. Nothing is deleted; flipping the navigator back
   * brings the original question and its whole subtree with it.
   *
   * Users who genuinely want the old behaviour have the explicit "delete this
   * message and everything after it" action, which still truncates.
   */
  const editAndResend = useCallback(
    async (
      messageId: string,
      newContent: SendContent,
      targetSessionId?: string,
      resourceContext?: string
    ) => {
      const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return
      // Rebuilding the branch base invalidates this session's streaming mirror;
      // drop it (and pending coalescing work) so the rebuilt base wins.
      registry.release(sessionId)
      messagesMirrorRef.current.delete(sessionId)

      const messages = store.getState().sessions[sessionId]?.messages ?? []
      const editedIdx = messages.findIndex((m) => m.id === messageId)
      if (editedIdx < 0) return

      const { merged, groupId, nextIndex } = tagEditSibling(messages, editedIdx)
      store.getState().replaceSessionMessages(sessionId, merged)
      await persistMessages(sessionId, merged)

      await send(newContent, undefined, {
        sessionId,
        resourceContext: resourceContext ?? lastResourceContextRef.current.get(sessionId),
        // The replacement is a *user* message, created inside `send` itself,
        // so it is tagged there rather than through the assistant-event path
        // `regenerate` uses.
        branchTag: { groupId, index: nextIndex },
      })
    },
    [send, store, registry]
  )

  /**
   * Re-issue the most recent user turn. Drops the assistant reply that
   * followed it (and anything after) and resends the original content.
   */
  const regenerate = useCallback(
    async (targetSessionId?: string, resourceContext?: string) => {
      const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return

      // Rebuilding the branch base invalidates this session's streaming mirror;
      // drop it (and pending coalescing work).
      registry.release(sessionId)
      messagesMirrorRef.current.delete(sessionId)

      const messages = useChatStore.getState().sessions[sessionId]?.messages ?? []
      let lastUserIdx = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          lastUserIdx = i
          break
        }
      }
      if (lastUserIdx < 0) return

      const anchor = messages[lastUserIdx]
      // Existing assistant siblings — every assistant message after the anchor
      // belongs to the same branch group (direct chat = one reply per turn).
      // We retain them with branchGroupId metadata so the user can switch back
      // via the BranchNavigator.
      const groupId = anchor.id
      const { merged, nextIndexByGroup } = tagBranchSiblings(messages, lastUserIdx, () => groupId)

      // Persist the tagged siblings (and untouched prefix) before the new send.
      store.getState().replaceSessionMessages(sessionId, merged)
      await persistMessages(sessionId, merged)

      // Stash the next-branch tag in a ref so handleEvent can stamp the
      // freshly-arrived assistant message with branchGroupId + the next index.
      const nextIndex = nextIndexByGroup.get(groupId) ?? 0
      pendingBranchTagRef.current.set(sessionId, { groupId, index: nextIndex })

      // Prefer the original SendContent if we have it (preserves attachments);
      // fall back to reconstructing from text parts.
      const cached = lastUserContentRef.current.get(sessionId)
      const content: SendContent =
        cached ??
        anchor.parts
          .filter((p): p is { type: "text"; text: string } => {
            const t = (p as { type?: string }).type
            return t === "text"
          })
          .map((p) => p.text)
          .join("")
      await send(content, undefined, {
        skipUserAppend: true,
        sessionId,
        resourceContext: resourceContext ?? lastResourceContextRef.current.get(sessionId),
      })
    },
    [send, store, registry]
  )

  return {
    send,
    stop,
    interruptAndSteer,
    flushSteer,
    respondToApproval,
    close,
    editAndResend,
    regenerate,
  }
}

async function buildSendOptions(
  session: ChatSession | null | undefined,
  userMessage?: string
): Promise<SendOptions> {
  const appSettings = useSettingsStore.getState().settings
  // The composer keeps @-referenced files/folders in the chat store. Hand
  // them to resolveSendOptions so each turn announces the directories the
  // SDK's Read tool may need.
  const referencedPaths = useChatStore
    .getState()
    .referencedPaths.map((r) => ({ absolute: r.absolute, isDir: r.isDir }))

  // `@agent` single-turn routing: resolve the first @-mentioned subagent in the
  // message to its dispatcher id. `resolveSendOptions` only honours it when the
  // id is actually registered in this turn's agent map (membership guard), so a
  // stale / unknown mention is harmless here. The target list unions the
  // reactive subagents with on-disk markdown agents (`.cognia/agents/*.md`) —
  // the SAME projection the composer `@` picker shows — so a picked markdown
  // handle (handle === id === the `opts.agents` key) actually routes. Discovery
  // is cached (3s) and returns `[]` off-Tauri, so this stays cheap.
  let targetAgentId: string | undefined
  if (userMessage) {
    const ps = useProjectStore.getState()
    const activeProjectForAgents = ps.activeProjectId
      ? (ps.projects.find((p) => p.id === ps.activeProjectId) ?? null)
      : null
    const markdownTargets = await discoverMarkdownAgentTargets({
      cwd: session?.workingDir ?? undefined,
      roots: activeProjectForAgents ? allRootPaths(activeProjectForAgents) : [],
    })
    const mentionTargets = [...buildChatMentionTargets(), ...markdownTargets]
    targetAgentId = resolveTargetAgentId(userMessage, mentionTargets) ?? undefined
  }

  // Active workspace (project). Its `rootDir` joins the cwd resolution chain
  // and its `additionalDirs` are unioned into `additionalDirectories` for this
  // turn. `null` when no workspace is active (resolver falls back as before).
  const projectState = useProjectStore.getState()
  const activeProject = projectState.activeProjectId
    ? (projectState.projects.find((p) => p.id === projectState.activeProjectId) ?? null)
    : null

  // Workspace Trust gate: an untrusted active workspace runs in Restricted Mode
  // (disk/host tools denied by `resolveSendOptions`). Authoritative at send time
  // — independent of the React banner state. Web + disabled setting bypass.
  const workspaceRestricted = await isWorkspaceRestricted(activeProject, {
    enabled: appSettings?.workspaceTrust?.enabled !== false,
    onWeb: !isTauri(),
  })

  // Twin runtime injection: when the user has populated the runtime config
  // (vector store + embedding API key) and the message is a plain string,
  // hand resolveSendOptions the deps so it can call applyTwinContext for
  // any twin-bound character. resolveSendOptions itself decides whether to
  // run the injection based on `character.twinId`.
  const twinHandshake = userMessage?.trim() ? await tryBuildTwinDeps() : undefined

  // Embed the user message ONCE per turn (when twin deps exist) so the twin RAG
  // leg and the memory recall leg share one query vector instead of embedding
  // the same text twice. Memory's vector backend shares the twin embedding model
  // (resolveMemoryBackend), so the vector is valid for both. Best-effort — on
  // failure the resolver falls back to per-leg embedding.
  let turnEmbedding: number[] | undefined
  if (twinHandshake && userMessage?.trim()) {
    try {
      turnEmbedding = (await generateEmbedding(userMessage, twinHandshake.embedding)).embedding
    } catch {
      turnEmbedding = undefined
    }
  }

  // Long-term memory: build the read-runtime deps when memory is enabled and
  // the turn carries a user message. `resolveSendOptions` decides (per its own
  // enabled/temporary gate) whether to actually recall + inject.
  const memoryHandshake = userMessage?.trim()
    ? await tryBuildMemoryDeps(resolveMemoryConfig(appSettings?.memory), twinHandshake)
    : undefined

  // Per-message ephemeral skills attached via the composer's SkillPicker.
  // These are unioned with character.skillIds in resolveSendOptions and
  // cleared after the send dispatches.
  const ephemeralSkillIds = useChatStore.getState().ephemeralSkillIds ?? []

  // ADR-0019 — when this session has an active goal, hand it to the resolver
  // so the goal's `<objective>` system section is appended to this turn. The
  // resolver only injects when `status === "active"`, so a paused goal (e.g.
  // after the user typed a fresh message) is correctly skipped.
  const activeGoal = session?.id
    ? ((await getGoalRuntime().getActiveGoalForSession(session.id)) ?? null)
    : null

  // ADR-0045 — same contract for an EXECUTING plan: hand it to the resolver so
  // `appendPlanContext` appends the plan's checklist + current-step callout to
  // this turn. `getExecutingPlanForSession` already filters by status, and the
  // resolver re-checks, so a paused / awaiting-approval plan never injects.
  // Lazy import (like the other plan touchpoints in this file) keeps the plan
  // runtime + its Dexie tables off the eager module graph; best-effort, since a
  // read hiccup must not block the send.
  let activePlan: AgentPlan | null = null
  try {
    if (session?.id) {
      const { getPlanRuntime } = await import("@/lib/agent/plan/runtime")
      activePlan = (await getPlanRuntime().getExecutingPlanForSession(session.id)) ?? null
    }
  } catch {
    activePlan = null
  }

  // When a `/loop` run is driving this session, flag it so the surface-aware
  // goal/loop guidance skill activates (parallel to `activeGoal` above; the
  // loop has no per-turn Dexie context block of its own). Best-effort.
  let activeLoop = false
  try {
    activeLoop = session?.id
      ? Boolean(await getLoopRuntime().getActiveLoopForSession(session.id))
      : false
  } catch {
    activeLoop = false
  }

  // One-shot post-compaction recovery: if a compaction boundary just landed and
  // no assistant turn has followed it yet, this upcoming turn is the first of a
  // new context phase — re-inject the recovery preamble. Stateless (derived from
  // the transcript), so it fires exactly once per boundary.
  const chatState = useChatStore.getState()
  const sessionMessages = session?.id
    ? chatState.activeSessionId === session.id
      ? chatState.messages
      : (chatState.sessions[session.id]?.messages ?? [])
    : chatState.messages
  const recoveryPhase = pendingRecoveryPhase(sessionMessages)
  const postCompaction = recoveryPhase !== null ? { phaseNumber: recoveryPhase } : undefined
  const memoryBranch = useGitStore.getState().status?.branch ?? undefined
  const primaryRoot = activeProject ? primaryRootOf(activeProject)?.path : undefined
  const referencedMemoryPath =
    primaryRoot && referencedPaths
      ? referencedPaths
          .map((item) => item.absolute)
          .find((absolute) => absolute === primaryRoot || absolute.startsWith(`${primaryRoot}/`))
      : undefined
  const memoryPath =
    referencedMemoryPath && primaryRoot
      ? referencedMemoryPath.slice(primaryRoot.length).replace(/^\/+/, "") || undefined
      : undefined

  return resolveSendOptions({
    postCompaction,
    session,
    appSettings,
    activeProject,
    workspaceRestricted,
    referencedPaths,
    targetAgentId,
    memoryBranch,
    memoryPath,
    twinDeps: twinHandshake,
    twinUserMessage: twinHandshake ? userMessage : undefined,
    memoryDeps: memoryHandshake,
    memoryUserMessage: memoryHandshake ? userMessage : undefined,
    // Project-scoped RAG (workspace knowledge base). Reuses the same twin deps
    // (shared vector store + embedding); `resolveSendOptions` gates injection on
    // the active workspace having knowledge files + project RAG enabled. Shares
    // the turn's query embedding — no extra embed call.
    projectKnowledgeDeps: twinHandshake,
    projectKnowledgeUserMessage: twinHandshake ? userMessage : undefined,
    precomputedQueryEmbedding: turnEmbedding,
    // Routing context-window pre-check input (B4): always pass the raw user
    // message (unlike twin/memory it needs no handshake gate).
    routingContextHint: userMessage ? { promptText: userMessage } : undefined,
    routingSurface: "chat",
    ephemeralSkillIds,
    activeGoal,
    activePlan,
    activeLoop,
    // Open this turn's agent-trace ROOT span here (one mint per turn). The hook
    // owns `endSpan` (result / error branches of `handleEvent`, keyed off the
    // cached `sendOptions.spanId`). The inline `startSpan` fallback below stays
    // only for the `opts`-bypass path (retry / loop) where buildSendOptions —
    // and thus this resolver — is skipped.
    emitTrace: true,
    traceSurface: "chat",
  })
}

/** Sub-session ids used by team chat embed `::char::` between the team
 * session id and the character id (see hooks/use-team-chat.ts). The direct
 * chat handler should ignore those — useTeamChat handles them. */
function isTeamSubSession(sessionId: string): boolean {
  return isSubSessionId(sessionId)
}

/**
 * Per-session coalescing registry + authoritative mirror threaded in from the
 * hook. Every *open* session (active or a background pane) coalesces through
 * the registry so it streams live into its own slice; sessions with no open
 * pane persist immediately to Dexie and surface via unread badges as before.
 */
interface StreamCoalescing {
  messagesMirrorRef: React.MutableRefObject<Map<string, UIMessage[]>>
  registry: SessionCoalescingRegistry
}

/**
 * Upper bound on how long the renderer waits for Auto-mode's optional model
 * judge before giving up and showing the manual approval modal. Prevents a
 * wedged utility-LLM call from freezing a turn with no visible dialog.
 */
const AUTO_MODE_DECISION_TIMEOUT_MS = 12_000

/** Read a session's current slice messages (its streaming base). */
function sliceMessages(sessionId: string): UIMessage[] {
  return useChatStore.getState().sessions[sessionId]?.messages ?? []
}

/** Drain a session's queued steer through this hook's send (direct replay). */
function drainSteerVia(sessionId: string, sendRef: React.MutableRefObject<SendFn | null>) {
  maybeDrainSteer(
    sessionId,
    (payload) => void sendRef.current?.(payload, undefined, { sessionId, steerDrain: true })
  )
}

/**
 * Run Auto-mode command-safety evaluation for a permission request and resolve
 * it when the decision is definitive. Returns `true` when the ask was answered
 * (allow/deny), `false` when it should fall through to the manual approval
 * modal. Fail-open: any error is treated as undecided (`false`). Shared by the
 * subagent-ask routing branch and the normal open-pane branch.
 */
async function tryAutoModeDecision(evt: {
  sessionId: string
  requestId: string
  toolName: string
  input: unknown
}): Promise<boolean> {
  try {
    const settings = useSettingsStore.getState().settings
    const judgeClient = buildUtilityLlmClient({
      session: null,
      appSettings: settings,
      override: settings?.agentPermissions?.autoApprove?.judgeModel,
      featureId: "command-safety",
    })
    // The model judge tier (`rules+model`) has no internal timeout, so a wedged
    // utility-LLM fetch would otherwise hang this handler forever with NO
    // approval dialog shown. Bound it: on timeout fall through to the manual
    // modal (treat as undecided) instead of swallowing the request.
    const decision = await Promise.race([
      runAutoModeForTool({
        toolName: evt.toolName,
        input: evt.input,
        settings,
        client: judgeClient,
        locale: settings?.language,
        pluginRules: getPluginCommandRulesets(),
      }),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), AUTO_MODE_DECISION_TIMEOUT_MS)
      }),
    ])
    if (decision && decision.decision === "allow") {
      await approveTool(evt.sessionId, evt.requestId, "allow")
      return true
    }
    if (decision && decision.decision === "deny") {
      await approveTool(
        evt.sessionId,
        evt.requestId,
        "deny",
        `auto-denied (${decision.source}): ${decision.reason}`
      )
      return true
    }
  } catch (err) {
    console.error("auto-mode evaluation failed", err)
  }
  return false
}

async function handleEvent(
  evt: ClaudeEvent,
  activeRef: React.MutableRefObject<string | null>,
  allowListRef: React.MutableRefObject<string[]>,
  pendingBranchTagRef: React.MutableRefObject<Map<string, { groupId: string; index: number }>>,
  sendRef: React.MutableRefObject<SendFn | null>,
  coalescing: StreamCoalescing
) {
  const { messagesMirrorRef, registry } = coalescing
  // Skip events for team sub-sessions outright — useTeamChat handles them.
  if (
    (evt.type === "event" ||
      evt.type === "session_ended" ||
      evt.type === "permission_request" ||
      evt.type === "sdk_session_id") &&
    typeof evt.sessionId === "string" &&
    isTeamSubSession(evt.sessionId)
  ) {
    return
  }
  switch (evt.type) {
    case "ready":
    case "log":
      return
    case "sidecar_exited": {
      // The sidecar process died. It will NOT emit the per-session
      // `session_ended` events for the turns it was serving, so every
      // streaming / awaiting-approval session would otherwise freeze forever
      // (composer disabled, chat lease + in-flight counter stuck). Settle each
      // one exactly as a terminal errored `session_ended` would: stop the
      // in-flight counter, drop backstops / open tool spans, interrupt any live
      // approval, seal the slice, and surface a retryable error (which also
      // releases the chat lease via the status→error subscription). Mirrors the
      // mobile transport's sidecar_exited handling (use-remote-session-stream).
      const chat = useChatStore.getState()
      for (const [sid, slice] of Object.entries(chat.sessions)) {
        if (slice.status !== "streaming" && slice.status !== "awaiting_approval") continue
        useInFlightStore.getState().settle(sid)
        clearApprovalBackstops(sid)
        clearToolSpansForSession(sid)
        // A dead sidecar can't emit `permission_interrupted`, so interrupt any
        // pending approval here — the same honest "interrupted" treatment.
        for (const approval of slice.pendingApprovals) {
          chat.markApprovalInterrupted(approval.requestId, sid, "sidecar exited")
        }
        if (isSessionOpen(sid)) {
          registry.get(sid).commit.flush()
          registry.get(sid).persist.flush()
          registry.release(sid)
          messagesMirrorRef.current.delete(sid)
        }
        chat.setSessionDiagnostic(
          sid,
          createDiagnostic("sidecarExited", { source: "chat", meta: { sessionId: sid } })
        )
        const cached = chat.lastSendBySession[sid] as
          { options?: { spanId?: string; provider?: string } } | undefined
        if (cached?.options?.spanId) {
          endSpan(cached.options.spanId, {
            errorType: "turn_error",
            errorMessage: SIDECAR_EXITED_TRACE_MESSAGE,
          })
        }
        chatTurnPerformance.finish(sid, "failed")
        const durationMs = finishBehaviorTurn(sid)
        if (durationMs !== undefined) {
          void trackEvent("chat.turn.failed", {
            sessionId: sid,
            surface: "chat",
            errorType: "sidecar_exited",
            durationMs,
            ...(cached?.options?.provider ? { provider: cached.options.provider } : {}),
          })
        }
        chat.clearLastSend(sid)
      }
      return
    }
    case "sdk_session_id": {
      // Persist the SDK conversation id so the next send can pass it as
      // `resumeSessionId` after a sidecar restart or app reload.
      await setSdkSessionId(evt.sessionId, evt.sdkSessionId).catch((err) => {
        console.error("setSdkSessionId failed", err)
      })
      return
    }
    case "session_ended": {
      // The turn is over — settle the in-flight counter FIRST (idempotent;
      // success, error, and abort all land here). A fallback retry below
      // re-begins against the next provider in the chain.
      useInFlightStore.getState().settle(evt.sessionId)
      // Cancel any backstop deny still pending for a remote-routed approval
      // on this session (Remote Session Control).
      clearApprovalBackstops(evt.sessionId)
      // Drop any open tool spans for this session — every tool_use should
      // have already paired with its tool_result, but cleanup keeps the
      // module-scope map from leaking entries when the SDK aborts mid-turn.
      clearToolSpansForSession(evt.sessionId)
      // Per-session sealing: any *open* session (focused or a background pane)
      // settles its own slice. Closed sessions only settled the in-flight
      // counter above.
      const sealOpen = isSessionOpen(evt.sessionId)
      const sealSession = (sid: string) => {
        registry.get(sid).commit.flush()
        registry.get(sid).persist.flush()
        registry.release(sid)
        messagesMirrorRef.current.delete(sid)
      }
      if (sealOpen) {
        if (evt.error) {
          // ADR-0043 Phase 4 — record the failure against the provider that
          // errored BEFORE any fallback re-issues against the next chain entry
          // (which overwrites the cached send). Trips its breaker after repeats.
          const failedSend = useChatStore.getState().lastSendBySession[evt.sessionId]
          const failedProvider = failedSend?.options.provider
          if (failedProvider) {
            recordProviderOutcome({
              providerId: failedProvider,
              ok: false,
              latencyMs: 0,
              errorMessage: evt.error,
              // Real HTTP status + Retry-After captured by the sidecar — drive
              // the breaker's dynamic cooldown off authoritative data.
              httpStatus: evt.httpStatus,
              retryAfterMs: evt.retryAfterMs,
              modelId: failedSend?.options.model,
              sessionId: evt.sessionId,
              // Provider child span nests under this turn's root span.
              traceId: failedSend?.options.traceId,
              parentSpanId: failedSend?.options.spanId,
              surface: "chat",
            })
          }
          // P4 routing-fallback: re-issue against the next entry in the
          // chain when the cached send carried fallbackEntries and the
          // error class is transient. `attemptRoutingFallback` returns
          // `true` when a retry was scheduled — in that case suppress
          // the error toast so the UI stays in `streaming`.
          const retried = isStandaloneChatMode()
            ? false
            : await attemptRoutingFallback(evt.sessionId, evt.error, {
                httpStatus: evt.httpStatus,
                retryAfterMs: evt.retryAfterMs,
              })
          if (!retried) {
            // Permanent failure — commit + persist the final partial and drop
            // the mirror. (A retry re-issues `send`, which clears it itself.)
            sealSession(evt.sessionId)
            useChatStore.getState().setSessionDiagnostic(
              evt.sessionId,
              toDiagnostic(evt.error, {
                source: "provider",
                meta: {
                  sessionId: evt.sessionId,
                  ...(typeof evt.httpStatus === "number" ? { httpStatus: evt.httpStatus } : {}),
                  ...(typeof evt.retryAfterMs === "number"
                    ? { retryAfterMs: evt.retryAfterMs }
                    : {}),
                  ...(failedProvider ? { providerId: failedProvider } : {}),
                },
              })
            )
            // End the agent-trace span on permanent failure (no retry). The
            // success path closes the span via the `sdkResult` branch in
            // case "event" instead.
            const cached = useChatStore.getState().lastSendBySession[evt.sessionId]
            const spanId = cached?.options.spanId
            if (spanId) {
              endSpan(spanId, {
                errorType: "turn_error",
                errorMessage: evt.error,
              })
            }
            chatTurnPerformance.finish(evt.sessionId, "failed")
            const durationMs = finishBehaviorTurn(evt.sessionId)
            if (durationMs !== undefined) {
              void trackEvent("chat.turn.failed", {
                sessionId: evt.sessionId,
                surface: "chat",
                durationMs,
                errorType:
                  typeof evt.httpStatus === "number" ? `http_${evt.httpStatus}` : "provider_error",
                ...(failedProvider ? { provider: failedProvider } : {}),
              })
            }
            useChatStore.getState().clearLastSend(evt.sessionId)
          }
        } else {
          // Clean end without a content-bearing result event (e.g. tool-only
          // turn): flush pending streaming work and drop the mirror.
          sealSession(evt.sessionId)
          useChatStore.getState().setSessionStatus(evt.sessionId, "idle")
          chatTurnPerformance.finish(evt.sessionId, "completed")
          const cached = useChatStore.getState().lastSendBySession[evt.sessionId]
          const durationMs = finishBehaviorTurn(evt.sessionId)
          if (durationMs !== undefined) {
            void trackEvent("chat.turn.completed", {
              sessionId: evt.sessionId,
              provider: cached?.options.provider ?? "unknown",
              surface: "chat",
              durationMs,
            })
          }
          useChatStore.getState().clearLastSend(evt.sessionId)
        }
        // Turn settled — replay any steer the user queued mid-run. A clean end
        // always drains; an errored end drains only when an explicit
        // "interrupt & steer" armed it (a natural error keeps the queue).
        if (!evt.error || steerArmed.has(evt.sessionId)) {
          drainSteerVia(evt.sessionId, sendRef)
        } else {
          // Errored end with nothing armed: the queue is deliberately preserved,
          // but no settle is coming to deliver it. Say so on the bubbles so the
          // user gets retry / discard instead of a message stuck on "queued".
          markPendingSteersFailed(evt.sessionId, evt.error)
        }
        // Then deliver any settled background-run results. Steer wins: if the
        // steer replay just started a new turn, the idle check inside defers
        // this to the NEXT settle.
        maybeDrainBackgroundResults(evt.sessionId)
      }
      return
    }
    case "permission_interrupted": {
      // The sidecar waiter died (turn aborted / session closed) — the tool was
      // already denied SDK-side. Mark the approval instead of dropping it so
      // the dialog shows an honest "interrupted" notice with Dismiss. Team
      // sub-session ids are re-bucketed inside the store action (same routing
      // as pushApproval), so this handles direct and team sessions alike.
      useChatStore.getState().markApprovalInterrupted(evt.requestId, evt.sessionId, evt.reason)
      return
    }
    case "permission_request": {
      // Remember the call for the post-tool (`tool_result_review`) hook.
      rememberChatToolCall(
        evt.toolUseID ?? "",
        evt.toolName,
        (evt.input as Record<string, unknown>) ?? {}
      )
      // Plugin tool firewall (`onPreToolUse`, W3.1): a deny short-circuits
      // before every user-facing approval flow (allowlist, auto-mode, modal);
      // a modify approves with the plugin's rewritten args (same semantics as
      // the agent-executor responder). Fail-open — adapter-hooks swallows
      // dispatcher errors and returns `allow`.
      {
        const pre = await dispatchPluginPreToolUse(evt.toolName, evt.input, evt.sessionId)
        if (pre.action === "deny") {
          try {
            await approveTool(
              evt.sessionId,
              evt.requestId,
              "deny",
              pre.reason ?? "denied by plugin onPreToolUse"
            )
          } catch (err) {
            console.error("plugin pre-tool deny failed", err)
          }
          return
        }
        if (pre.action === "modify" && pre.modifiedArgs) {
          try {
            await approveTool(evt.sessionId, evt.requestId, "allow", undefined, pre.modifiedArgs)
          } catch (err) {
            console.error("plugin pre-tool modify failed", err)
          }
          return
        }
      }
      // Auto-approve if the user has previously allowed this tool.
      if (allowListRef.current.includes(evt.toolName)) {
        try {
          await approveTool(evt.sessionId, evt.requestId, "allow")
        } catch (err) {
          console.error("auto-approve failed", err)
        }
        return
      }
      // Dispatched-subagent ask: the run is on an ephemeral (never-open)
      // session, so the legacy `!isOpen` branch below would silently
      // auto-deny it. Route it to the PARENT chat session instead (Claude Code
      // v2.1.186 parity) — unless the user opted back into auto-deny. The ask
      // still runs through the auto-mode command-safety evaluation.
      const subagentRoute = getSubagentApprovalRoute(evt.sessionId)
      if (subagentRoute) {
        const mode = useSettingsStore.getState().settings?.agentPermissions?.subagentAsks
        if (mode === "auto-deny") {
          try {
            await approveTool(
              evt.sessionId,
              evt.requestId,
              "deny",
              "auto-denied: subagent asks disabled"
            )
          } catch (err) {
            console.error("subagent auto-deny failed", err)
          }
          return
        }
        const decided = await tryAutoModeDecision(evt)
        if (decided) return
        useChatStore.getState().pushApproval({
          sessionId: evt.sessionId,
          requestId: evt.requestId,
          toolUseID: evt.toolUseID,
          toolName: evt.toolName,
          input: evt.input,
          title: evt.title,
          displayName: evt.displayName,
          description: evt.description,
          blockedPath: evt.blockedPath,
          decisionReason: evt.decisionReason,
          origin: "subagent",
          subagentId: subagentRoute.subagentId,
          subagentRunId: subagentRoute.runId,
        })
        return
      }
      // An open pane (focused OR background tab/split) surfaces the approval
      // inline in *its* pane — `pushApproval` routes by `approval.sessionId`,
      // so a gate in session B never blocks or is confused with session A's.
      const isOpen = isSessionOpen(evt.sessionId)
      if (!isOpen) {
        // Remote Session Control: if a remote device is watching this
        // (non-open) session, route the approval to it instead of
        // auto-denying. The remote already received this permission_request
        // frame over /ws/v1/events and will resolve it via claude_approve.
        // The sidecar's canUseTool has no timeout of its own, so arm a
        // backstop deny that fires only if the remote never answers — the
        // next SDK event for this session (the turn proceeding) cancels it.
        if (isSessionAttached(evt.sessionId)) {
          armApprovalBackstop(evt.sessionId, evt.requestId, () => {
            void approveTool(
              evt.sessionId,
              evt.requestId,
              "deny",
              "auto-denied: remote approval timed out"
            ).catch((err) => console.error("remote backstop deny failed", err))
          })
          // Notify a backgrounded (WS-closed) watcher via push so it can come
          // back and decide before the backstop denies.
          void notifyRemoteNeedsInput({
            sessionId: evt.sessionId,
            requestId: evt.requestId,
            toolName: evt.toolName,
          })
          return
        }
        // No remote watcher — default-deny rather than block silently.
        try {
          await approveTool(evt.sessionId, evt.requestId, "deny", "auto-denied: session not open")
        } catch (err) {
          console.error("non-open deny failed", err)
        }
        return
      }
      // Auto mode: auto-decide shell-command safety (deterministic rules +
      // optional small-model judge). A non-"ask" decision short-circuits the
      // approval modal; anything uncertain falls through to the manual prompt.
      if (await tryAutoModeDecision(evt)) return
      const approval: PendingApproval = {
        sessionId: evt.sessionId,
        requestId: evt.requestId,
        toolUseID: evt.toolUseID,
        toolName: evt.toolName,
        input: evt.input,
        title: evt.title,
        displayName: evt.displayName,
        description: evt.description,
        blockedPath: evt.blockedPath,
        decisionReason: evt.decisionReason,
      }
      useChatStore.getState().pushApproval(approval)
      return
    }
    case "tool_result_review": {
      // Plugin PostToolUse rewrite (W3.1): the sidecar paused before feeding
      // this tool result to the model. Dispatch to plugins; a returned
      // `modifiedResult` becomes the model-visible output. Always answer —
      // the sidecar is blocked on `claude_tool_result_decision`.
      const call = evt.toolUseId ? chatToolCallsById.get(evt.toolUseId) : undefined
      let updatedToolOutput: unknown
      try {
        const post = await dispatchPluginPostToolUse(
          evt.toolName || call?.name || "",
          call?.input ?? {},
          evt.result,
          evt.sessionId
        )
        updatedToolOutput = post.modifiedResult
      } catch {
        updatedToolOutput = undefined
      }
      try {
        await toolResultDecision(
          evt.sessionId,
          evt.reviewId,
          updatedToolOutput,
          (evt as typeof evt & { remoteExecutionContext?: RemoteExecutionContext })
            .remoteExecutionContext
        )
      } catch (err) {
        console.error("tool result decision failed", err)
      }
      return
    }
    case "event": {
      const env = evt as SDKEventEnvelope
      const sessionId = env.sessionId
      // A proceeding SDK event means any approval that was routed to a remote
      // device for this session has been answered (or the turn moved past
      // it) — cancel its backstop deny (Remote Session Control).
      clearApprovalBackstops(sessionId)
      const isActive = sessionId === activeRef.current
      // Any open pane streams live into its slice; a closed (no-pane) session
      // only touches Dexie. `isOpen ⊇ isActive` — the active session is always
      // open.
      const isOpen = isSessionOpen(sessionId)

      // Source of truth lives in Dexie. Load → apply → save → maybe sync store.
      // Mirror-first for an open session: the store commit may be a frame
      // behind (coalesced), so the mirror holds the true latest base. The base
      // is that session's *own* slice — never the focused session's — so a
      // background pane accumulates its own stream.
      const current = isOpen
        ? (messagesMirrorRef.current.get(sessionId) ?? sliceMessages(sessionId))
        : await listMessages(sessionId)

      // Track assistant tool_use blocks so the post-tool hook can correlate
      // `tool_result_review` events with the call's name + input.
      rememberToolCallsFromSdkEvent(env.event)

      const {
        messages: appliedMessages,
        turnComplete,
        result: sdkResult,
      } = applySdkEvent(current, env.event)

      // Emit `execute_tool` child spans for every `tool_use` / `tool_result`
      // pair in this SDK event. The parent invoke_agent span was opened by
      // `send()` and its ids live on the cached SendOptions — we read them
      // here so child spans nest correctly under the same trace.
      const turnSpanForTools = useChatStore.getState().lastSendBySession[sessionId]?.options
      if (turnSpanForTools?.spanId && turnSpanForTools.traceId) {
        handleSdkEventForToolSpans({
          sessionId,
          traceId: turnSpanForTools.traceId,
          parentSpanId: turnSpanForTools.spanId,
          event: env.event as unknown as Parameters<typeof handleSdkEventForToolSpans>[0]["event"],
        })
      }

      // If `regenerate` queued a branch tag for this session, stamp it onto
      // the freshly-appended assistant message. The tag is one-shot — once
      // consumed we drop it so subsequent assistant turns are untouched.
      let nextMessages = appliedMessages
      const pendingTag = pendingBranchTagRef.current.get(sessionId)
      if (pendingTag && appliedMessages !== current && appliedMessages.length > current.length) {
        const lastIdx = appliedMessages.length - 1
        const last = appliedMessages[lastIdx]
        if (last?.role === "assistant") {
          const meta = (last as { metadata?: Record<string, unknown> }).metadata ?? {}
          const stamped = {
            ...last,
            metadata: {
              ...meta,
              branchGroupId: pendingTag.groupId,
              branchIndex: pendingTag.index,
            },
          }
          nextMessages = [...appliedMessages.slice(0, lastIdx), stamped]
          pendingBranchTagRef.current.delete(sessionId)
          if (isOpen) {
            useChatStore
              .getState()
              .setSessionActiveBranch(sessionId, pendingTag.groupId, stamped.id)
          }
        }
      }

      // Plan-mode → tasks bridge: forward TodoWrite / TaskCreate / TaskUpdate
      // / TaskList / ExitPlanMode tool_use blocks to the agent-team store so
      // the workspace tasks panel surfaces the agent's own plan. Wrapped so
      // a bridge throw never breaks the chat event loop.
      //
      // Skipped for `stream_event` (token-delta) envelopes: every bridge below
      // consumes only assistant / user / system frames and would no-op — but
      // only AFTER this block paid a Dexie `getSession` read per token batch.
      // Gating here keeps the streaming hot path free of per-token IO.
      if (env.event.type !== "stream_event") {
        try {
          const session = await getSession(sessionId)
          applyPlanModeBridge(env.event, sessionId, session?.teamId)
          // Bridge SDK-native subagents (the `opts.agents` / Task-tool path used by
          // workflow-editor and direct chat) into the runtime store so they render
          // in the chat subagent tree alongside `dispatch_agent` runs.
          const { applySdkSubagentBridge } = await import("@/lib/claude/sdk-subagent-bridge")
          applySdkSubagentBridge(env.event, sessionId)
          // ExitPlanMode capture (ADR-0045): project the SDK plan-mode plan into
          // a structured draft AgentPlan so it can be approved + executed through
          // the unified plan pipeline. Runs once per turn (turnComplete). Lazy
          // import keeps the plan runtime out of the hot path until used.
          const { captureExitPlanMode } = await import("@/lib/agent/plan/exit-plan-capture")
          await captureExitPlanMode(env.event, sessionId, session?.characterId)
        } catch (err) {
          console.warn("planModeBridge failed", err)
        }
      }

      // Twin sources injection — runs once per turn at `turnComplete`. The
      // `applyTwinContext` runtime data was stashed onto sendOptions.twinContext
      // during `resolveSendOptions`; we read it back from the lastSend cache
      // (the same place routing-fallback uses) and merge twin + style sources
      // onto the last assistant message's SourcesPart.
      if (turnComplete) {
        const last = useChatStore.getState().lastSendBySession[sessionId]
        const twinCtx = last?.options.twinContext
        if (twinCtx) {
          const withTwin = mergeTwinSourcesIntoLastAssistant(nextMessages, twinCtx)
          if (withTwin !== nextMessages) {
            nextMessages = withTwin
          }
        }
        // Long-term memory sources — same lastSend-cache read as twin, stashed
        // by `resolveSendOptions` onto `options.memoryContext`.
        const memoryCtx = last?.options.memoryContext
        if (memoryCtx) {
          const withMemory = mergeMemorySourcesIntoLastAssistant(nextMessages, memoryCtx)
          if (withMemory !== nextMessages) {
            nextMessages = withMemory
          }
        }
      }

      if (nextMessages !== current) {
        const currentAssistant = [...current]
          .reverse()
          .find((message) => message.role === "assistant")
        const nextAssistant = [...nextMessages]
          .reverse()
          .find((message) => message.role === "assistant")
        if (nextAssistant && nextAssistant !== currentAssistant) {
          chatTurnPerformance.markFirstResponse(sessionId)
        }
        const grewWithAssistant =
          nextMessages.length > current.length &&
          nextMessages[nextMessages.length - 1]?.role === "assistant"
        if (grewWithAssistant) {
          // The first visible assistant frame (including tool_use) is the
          // routing commit point. A later provider error must preserve the
          // partial turn instead of replaying user-visible or side-effecting
          // work against another deployment.
          const cachedSend = useChatStore.getState().lastSendBySession[sessionId]
          if (!cachedSend?.routingCommitted && cachedSend?.options.spanId) {
            recordEvent(cachedSend.options.spanId, {
              name: "routing.commit",
              at: Date.now(),
              attributes: {
                providerId: cachedSend.options.provider,
                modelId: cachedSend.options.model,
                attemptIndex: cachedSend.attemptIndex,
              },
            })
          }
          useChatStore.getState().markLastSendCommitted?.(sessionId)
        }
        if (isOpen) {
          // Mirror is the authoritative base for the next event (the slice
          // commit below may be coalesced a frame behind). Always write it
          // synchronously before scheduling any deferred work. Keyed per
          // session so concurrent streams never share a base.
          messagesMirrorRef.current.set(sessionId, nextMessages)
          const coalesce = registry.get(sessionId)
          if (turnComplete) {
            // Seal the turn: drop any coalesced/debounced work from earlier
            // tokens and commit + durably persist the final state now. Use an
            // explicit synchronous commit (not commit.flush()) because the
            // twin-sources merge above may have rewritten `nextMessages` after
            // the last commit.call — flush would re-commit the pre-merge args.
            coalesce.commit.cancel()
            coalesce.persist.cancel()
            useChatStore.getState().replaceSessionMessages(sessionId, nextMessages)
            await persistMessages(sessionId, nextMessages)
          } else {
            // Mid-stream: coalesce the React commit to ≤1/frame and debounce
            // the Dexie write. The mirror keeps the read path correct.
            coalesce.commit.call(nextMessages)
            coalesce.persist.call(nextMessages)
          }
        } else {
          // No open pane — persist straight to Dexie (no live slice to feed).
          if (turnComplete) chatTurnPerformance.beginFinalPersistence(sessionId)
          await persistMessages(sessionId, nextMessages)
          if (turnComplete) chatTurnPerformance.endFinalPersistence(sessionId)
        }
        // A reply landing for any *non-focused* session (open background pane
        // or fully-backgrounded) bumps its unread badge.
        if (sessionId !== activeRef.current && grewWithAssistant) {
          await bumpUnread(sessionId).catch(() => {})
        }
      }

      // Persist per-turn usage + cost. Runs for every result event regardless
      // of `isActive` so background sessions still accumulate cost. Idempotent
      // on (messageId) — re-applying the same result overwrites the row.
      if (sdkResult) {
        const lastAssistant = [...nextMessages].reverse().find((m) => m.role === "assistant")
        // The actual provider/model sent to the sidecar may differ from the
        // session record when alias routing or preset model_mapping changed it.
        const lastSendForSpan = useChatStore.getState().lastSendBySession[sessionId]
        if (lastAssistant) {
          const session = await getSession(sessionId).catch(() => undefined)
          await recordResultUsage({
            sessionId,
            messageId: lastAssistant.id,
            characterId: session?.characterId,
            model: lastSendForSpan?.options.model ?? session?.model,
            providerId: lastSendForSpan?.options.provider,
            result: sdkResult,
          }).catch((err) => {
            console.warn("recordResultUsage failed", err)
          })
        }
        // Finalise the agent-trace span we opened in `send`. The spanId is
        // cached on `lastSendBySession.options` (set right after
        // `sendPrompt` in `send`). `endSpan` is idempotent — fallback retries
        // that reuse the same spanId are safe.
        // ADR-0043 Phase 4 — feed provider reliability telemetry on a clean
        // turn (drives the health-metrics + circuit-breaker stores the routing
        // engine reads). Best-effort; recordProviderOutcome never throws.
        const telemetryProvider = lastSendForSpan?.options.provider
        const turnUsage = extractUsage(sdkResult)
        if (telemetryProvider) {
          const r = sdkResult as unknown as { duration_ms?: number; total_cost_usd?: number }
          recordProviderOutcome({
            providerId: telemetryProvider,
            ok: true,
            latencyMs: typeof r.duration_ms === "number" ? r.duration_ms : 0,
            estimatedCostUsd: typeof r.total_cost_usd === "number" ? r.total_cost_usd : undefined,
            modelId: lastSendForSpan?.options.model,
            tokensUsed: turnUsage
              ? (turnUsage.inputTokens ?? 0) + (turnUsage.outputTokens ?? 0)
              : undefined,
            // Token breakdown lets the sink estimate cost when the SDK reports
            // none (ai-sdk / non-Anthropic path → total_cost_usd 0), keeping the
            // budget mirror + daily rollup accurate for those providers.
            inputTokens: turnUsage?.inputTokens,
            outputTokens: turnUsage?.outputTokens,
            cacheReadTokens: turnUsage?.cacheReadInputTokens,
            cacheCreationTokens: turnUsage?.cacheCreationInputTokens,
            sessionId,
            // Provider child span nests under this turn's root span, carrying
            // the resolved tokens + cost into the trace.
            traceId: lastSendForSpan?.options.traceId,
            parentSpanId: lastSendForSpan?.options.spanId,
            surface: "chat",
          })
          const durationMs = finishBehaviorTurn(sessionId)
          if (durationMs !== undefined) {
            void trackEvent("chat.turn.completed", {
              sessionId,
              provider: telemetryProvider,
              surface: "chat",
              durationMs,
            })
          }
        }
        // Plugin token-usage observability (System-A onTokenUsage) — previously
        // dormant on the built-in chat path. Fail-open + no-op when no plugin
        // registered the hook; fires regardless of whether a trace span is open.
        if (turnUsage) {
          dispatchPluginTokenUsage(sessionId, {
            inputTokens: turnUsage.inputTokens ?? 0,
            outputTokens: turnUsage.outputTokens ?? 0,
            cacheCreationTokens: turnUsage.cacheCreationInputTokens,
            cacheReadTokens: turnUsage.cacheReadInputTokens,
          })
        }
        const turnSpanId = lastSendForSpan?.options.spanId
        if (turnSpanId) {
          const usage = extractUsage(sdkResult)
          const sdkResultObj = sdkResult as unknown as {
            total_cost_usd?: number
            stop_reason?: string
          }
          endSpan(turnSpanId, {
            usage: usage
              ? {
                  inputTokens: usage.inputTokens ?? 0,
                  outputTokens: usage.outputTokens ?? 0,
                  cacheCreationTokens: usage.cacheCreationInputTokens ?? 0,
                  cacheReadTokens: usage.cacheReadInputTokens ?? 0,
                }
              : undefined,
            costUsdEstimate:
              typeof sdkResultObj.total_cost_usd === "number"
                ? sdkResultObj.total_cost_usd
                : undefined,
            finishReasons:
              typeof sdkResultObj.stop_reason === "string" ? [sdkResultObj.stop_reason] : undefined,
            responseModel: lastSendForSpan?.options.model,
          })
        }
      }

      if (turnComplete && isOpen) {
        // Streaming sealed. Commit the last visual frame, cancel the
        // fire-and-forget debounced writer, and await one canonical durable
        // snapshot before exposing the idle state. A result envelope commonly
        // leaves `nextMessages === current`; merely flushing the debouncer in
        // that case launched an unobserved Dexie promise, so a reload could
        // terminate the page after the full reply appeared but before it was
        // stored.
        registry.get(sessionId).commit.flush()
        registry.get(sessionId).persist.cancel()
        chatTurnPerformance.beginFinalPersistence(sessionId)
        await persistMessages(sessionId, nextMessages)
        chatTurnPerformance.endFinalPersistence(sessionId)
        registry.release(sessionId)
        messagesMirrorRef.current.delete(sessionId)
        chatTurnPerformance.finish(sessionId, "completed")

        // Don't immediately flip to idle if this session's approvals are still
        // pending; the store helper handles the precedence. Read the session's
        // own slice so a background pane's approval doesn't gate the focused one.
        const sessionPending = useChatStore.getState().sessions[sessionId]?.pendingApprovals ?? []
        if (sessionPending.length === 0) {
          // Plugin bus: SDK-path agent run sealed successfully (ids only).
          emitSystemBusEvent(SystemEvents.MESSAGE_RECEIVED, { sessionId })
          emitSystemBusEvent(SystemEvents.AGENT_COMPLETED, { sessionId })
          // Plugin post-turn hook (onPostChatReceive) — fires once the assistant
          // turn truly sealed (no pending approvals). This is the canonical
          // post-turn observation seam; it was previously dormant (no host call
          // site). In-process hook (not the ids-only bus), so it may carry the
          // assistant content. Fully guarded: a plugin-observability dispatch
          // must never break turn completion (mirrors the artifacts block below).
          try {
            const sealedAssistant = [...nextMessages].reverse().find((m) => m.role === "assistant")
            if (sealedAssistant) {
              // Content extraction is isolated so it can never prevent the
              // observability dispatch (the hook is fail-open by design).
              let content = ""
              try {
                content = extractAssistantText(sealedAssistant) ?? ""
              } catch {
                /* fall back to empty content */
              }
              void dispatchPluginPostChatReceive({
                sessionId,
                message: { id: sealedAssistant.id, role: "assistant", content },
                metadata: {
                  model: useChatStore.getState().lastSendBySession[sessionId]?.options.model,
                },
              })
              // Pipeline hook (W3.3): `onMessageReceive` — plugins may rewrite
              // the sealed assistant message. Applied asynchronously after the
              // seal (store + Dexie) so a slow plugin never blocks the turn.
              void (async () => {
                try {
                  const piped = await dispatchPluginAssistantMessage({
                    id: sealedAssistant.id,
                    role: "assistant",
                    content,
                  })
                  if (typeof piped?.content !== "string" || piped.content === content) return
                  const base = useChatStore.getState().sessions[sessionId]?.messages ?? []
                  const rewritten = base.map((m) =>
                    m.id === sealedAssistant.id
                      ? {
                          ...m,
                          parts: m.parts.map((p) =>
                            p.type === "text" ? { ...p, text: piped.content } : p
                          ),
                        }
                      : m
                  )
                  useChatStore.getState().setSessionMessages(sessionId, rewritten)
                  await persistMessages(sessionId, rewritten)
                } catch {
                  // Pipeline rewrite is best-effort — never break the seal.
                }
              })()
            }
          } catch {
            // onPostChatReceive is best-effort observability — never block the seal.
          }
          // Wrap the streaming→idle flip in `startTransition` so the heavy
          // commit it triggers — unmounting Streamdown, mounting react-markdown
          // + sanitize, and lazy-loading any Mermaid/Math/Diff blocks via
          // next/dynamic — lands at transition priority. The user's scroll
          // and keyboard input remain interruptible during the swap.
          startTransition(() => {
            useChatStore.getState().setSessionStatus(sessionId, "idle")
          })
        }

        // The turn-driver block below (artifacts, utility-model titling, /goal
        // + /loop auto-continuation) mutates the focused conversation and
        // schedules continuations guarded by `activeRef`; it runs only for the
        // focused session. Background panes still seal + go idle above.
        const completedSession = await getSession(sessionId).catch(() => undefined)

        // Auto-detect artifacts in the assistant turn that just sealed.
        // Honors the artifacts settings block; off by default for
        // power-users that flip the toggle.
        if (isActive || completedSession?.kind === "resource-workbench") {
          try {
            const settings = useSettingsStore.getState().settings
            const artifactsCfg = settings?.artifacts
            const lastAssistant = [...nextMessages].reverse().find((m) => m.role === "assistant")
            const text = extractAssistantText(lastAssistant)
            if (text && lastAssistant) {
              const reviewEnabled = artifactsCfg?.reviewBeforeApply !== false
              const editTarget =
                useChatStore.getState().pendingArtifactEditTarget?.[sessionId] ?? null

              // Codex-style review gate: when the user aimed this turn at an
              // existing artifact (via a selection chip) and review is on, stage
              // the revision as a pending diff proposal instead of auto-creating
              // a duplicate artifact.
              let routedToReview = false
              if (editTarget && reviewEnabled) {
                const { detectArtifacts, DEFAULT_DETECTION_CONFIG } =
                  await import("@/lib/ai/generation/artifact-detector")
                // Low line threshold so even a small targeted edit surfaces.
                const detected = detectArtifacts(text, {
                  ...DEFAULT_DETECTION_CONFIG,
                  autoCreate: true,
                  minLines: 1,
                })
                const targetArtifact = useArtifactStore
                  .getState()
                  .getArtifact(editTarget.artifactId)
                const route = routeAiRevision({
                  reviewEnabled,
                  target: editTarget,
                  targetArtifactType: targetArtifact?.type,
                  detected,
                })
                // The target is single-use — consume it regardless of outcome.
                useChatStore.getState().setPendingArtifactEditTarget(sessionId, null)
                if (route.action === "propose") {
                  const proposal = useArtifactStore
                    .getState()
                    .proposeArtifactUpdate(route.artifactId, route.content, {
                      requestId: route.requestId,
                    })
                  // A null proposal (artifact gone / identical content) falls
                  // through to the normal auto-create path below — no lost work.
                  routedToReview = proposal !== null
                }
              }

              const binding = completedSession?.surfaceBinding
              if (
                !routedToReview &&
                reviewEnabled &&
                completedSession?.kind === "resource-workbench" &&
                binding?.kind === "canvas-document"
              ) {
                const { detectArtifacts, DEFAULT_DETECTION_CONFIG } =
                  await import("@/lib/ai/generation/artifact-detector")
                const detected = detectArtifacts(text, {
                  ...DEFAULT_DETECTION_CONFIG,
                  autoCreate: true,
                  minLines: 1,
                })
                const proposed = detected[0]?.content ?? text
                routedToReview =
                  useArtifactStore.getState().proposeCanvasReview(binding.documentId, proposed, {
                    requestId: lastAssistant.id,
                  }) !== null
              }

              if (
                !routedToReview &&
                reviewEnabled &&
                completedSession?.kind === "resource-workbench" &&
                binding?.kind === "project-file"
              ) {
                const { detectArtifacts, DEFAULT_DETECTION_CONFIG } =
                  await import("@/lib/ai/generation/artifact-detector")
                const detected = detectArtifacts(text, {
                  ...DEFAULT_DETECTION_CONFIG,
                  autoCreate: true,
                  minLines: 1,
                })
                const { getProjectFileResourceKey, proposeProjectFileUpdate } =
                  await import("@/lib/context-workbench/project-file-proposals")
                routedToReview =
                  proposeProjectFileUpdate(
                    getProjectFileResourceKey(binding),
                    detected[0]?.content ?? text,
                    lastAssistant.id
                  ) !== null
              }

              // Auto-detect artifacts in the assistant turn that just sealed.
              // Honors the artifacts settings block; off by default for
              // power-users that flip the toggle.
              if (!routedToReview && artifactsCfg?.autoCreate !== false) {
                void useArtifactStore.getState().autoCreateFromContent({
                  sessionId,
                  messageId: lastAssistant.id,
                  content: text,
                  config: {
                    autoCreate: true,
                    minLines: artifactsCfg?.minLines,
                    enabledTypes: artifactsCfg?.enabledTypes,
                    showNotification: artifactsCfg?.showNotification !== false,
                  },
                })
              }
            }
          } catch (err) {
            console.warn("artifact turn-complete routing failed", err)
          }
        }

        if (!isActive) return

        // Background utility-model work: upgrade the auto title to an
        // LLM-generated one on the first turn, and (opt-in) generate a
        // timeline-minimap label. Fire-and-forget so it never blocks the
        // per-session event queue.
        runUtilityModelTasks(sessionId, nextMessages)
        // Long-term memory: extract + consolidate durable facts from this turn.
        runMemoryTasks(sessionId, nextMessages)

        // ── ADR-0019: drive the self-driving `/goal` loop forward ───────────
        // Runs once the turn truly sealed and no tool approval is pending.
        // `handleTurnComplete` is pure (no IPC) and returns a decision; we
        // own dispatch here. The per-session event queue serializes this with
        // the next turn's events; the generationId guard + AbortController
        // make a mid-turn pause/stop/update return `stale`/`aborted`.
        if (useChatStore.getState().pendingApprovals.length === 0) {
          // Set once a self-driving mechanism has queued the next turn, so the
          // plan driver below stands down instead of dispatching a second one.
          let selfDrivenContinuation = false
          // Self-paced /loop driver — mutually exclusive with an active goal
          // (enforced at create on both sides), so this only runs when the
          // goal block below finds nothing.
          try {
            const activeLoop = await getLoopRuntime().getActiveLoopForSession(sessionId)
            if (activeLoop?.mode === "self_paced") {
              const lastAssistant = [...nextMessages].reverse().find((m) => m.role === "assistant")
              const lastResponse = extractAssistantText(lastAssistant)
              const usage = sdkResult ? extractUsage(sdkResult) : null
              const tokensDelta = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
              const capturedGenerationId = activeLoop.generationId
              const ac = new AbortController()
              const unregister = getLoopRuntime().registerAbortController(activeLoop.id, ac)
              let outcome: Awaited<ReturnType<typeof handleLoopTurnComplete>>
              try {
                outcome = await handleLoopTurnComplete({
                  loopId: activeLoop.id,
                  lastResponse,
                  tokensDelta,
                  signal: ac.signal,
                  capturedGenerationId,
                })
              } finally {
                unregister()
              }
              if (outcome.kind === "exit") {
                useChatStore.getState().appendMessage({
                  id: `sys-loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  role: "system",
                  parts: [
                    {
                      type: "text",
                      text: renderLoopExitCard(outcome.resultingStatus, outcome.reason),
                    },
                  ],
                })
                await persistMessages(sessionId, useChatStore.getState().messages).catch(() => {})
              } else if (outcome.kind === "continue") {
                selfDrivenContinuation = true
                scheduleLoopContinuation(
                  activeLoop.id,
                  sessionId,
                  outcome.userMessage,
                  sendRef,
                  activeRef
                )
              }
              // aborted | stale | no_loop → no-op; a pause/stop owns the next step.
            }
          } catch (err) {
            console.warn("loop turn-driver failed", err)
          }
          try {
            const goal = await getGoalRuntime().getActiveGoalForSession(sessionId)
            if (goal) {
              const appSettings = useSettingsStore.getState().settings
              const goalSession = await getSession(sessionId).catch(() => undefined)
              const judgeClient = buildGoalJudgeClient(goalSession, appSettings, {
                // Per-goal judge model/provider (ADR-0019 Phase 2); undefined
                // → falls back to the session/app-default provider.
                model: goal.config.judgeModel,
                provider: goal.config.judgeProvider,
              })
              if (!judgeClient) {
                // Legacy env-key setup — can't judge from the renderer. Warn
                // once and pause so the loop doesn't appear to silently stall.
                if (!goalJudgeClientWarned.has(goal.id)) {
                  goalJudgeClientWarned.add(goal.id)
                  useChatStore.getState().appendMessage({
                    id: `sys-goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    role: "system",
                    parts: [
                      {
                        type: "text",
                        text: "⚠️ **Goal paused — no judge model available.** Add a provider API key in Settings → Providers so the goal loop can evaluate progress. (A legacy ANTHROPIC_API_KEY environment variable alone can't drive the renderer-side judge.)",
                      },
                    ],
                  })
                  await getGoalRuntime().pauseGoal(goal.id)
                  await persistMessages(sessionId, useChatStore.getState().messages).catch(() => {})
                }
              } else {
                const lastAssistant = [...nextMessages]
                  .reverse()
                  .find((m) => m.role === "assistant")
                const lastResponse = extractAssistantText(lastAssistant)
                const usage = sdkResult ? extractUsage(sdkResult) : null
                const tokensDelta = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
                const capturedGenerationId = goal.generationId
                const ac = new AbortController()
                const unregister = getGoalRuntime().registerAbortController(goal.id, ac)
                let outcome: Awaited<ReturnType<typeof handleTurnComplete>>
                try {
                  outcome = await handleTurnComplete({
                    goalId: goal.id,
                    lastResponse,
                    tokensDelta,
                    usage: usage ?? undefined,
                    budgetExceeded:
                      (sdkResult as unknown as { subtype?: string } | null)?.subtype ===
                      "error_max_budget_usd",
                    modelMessageId: lastAssistant?.id,
                    judgeClient,
                    signal: ac.signal,
                    capturedGenerationId,
                    firer: defaultLifecycleFirer,
                    hookContext: { agentId: "goal-judge", sessionId: goal.id },
                  })
                } finally {
                  unregister()
                }
                if (outcome.kind === "exit") {
                  useChatStore.getState().appendMessage({
                    id: `sys-goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    role: "system",
                    parts: [
                      {
                        type: "text",
                        text: renderGoalExitCard(outcome.resultingStatus, outcome.reason),
                      },
                    ],
                  })
                  await persistMessages(sessionId, useChatStore.getState().messages).catch(() => {})
                } else if (outcome.kind === "continue") {
                  // Pacing gate (ADR-0019 Phase 2): dispatch now / hold for a
                  // manual "Continue" / defer past quiet-hours or the interval.
                  // The scheduler re-reads the goal so a pause/stop in the tiny
                  // window after handleTurnComplete returned cancels cleanly.
                  // Adaptive pacing: the model's <next-delay/> trailer (opt-in)
                  // feeds the gate as a slow-down-only suggestion.
                  const suggested = goal.config.adaptivePacing
                    ? parseSuggestedDelay(lastResponse)
                    : null
                  selfDrivenContinuation = true
                  scheduleGoalContinuation(
                    goal.id,
                    sessionId,
                    outcome.userMessage,
                    sendRef,
                    activeRef,
                    suggested?.ms
                  )
                }
                // aborted | stale | no_goal → no-op: a pause/stop/update owns
                // the next step and the live-query pill reflects the status.
              }
            }
          } catch (err) {
            console.warn("goal turn-driver failed", err)
          }

          // ── ADR-0045: drive an in-session plan forward ────────────────────
          // Same contract as the goal/loop drivers above: `handlePlanTurnComplete`
          // decides (marks the finished step done, picks the next runnable one)
          // and we dispatch. Skipped when a goal/loop already queued a
          // continuation for this turn — two drivers dispatching would double the
          // next turn. The strategy re-check is what keeps this off an
          // ORCHESTRATED plan: such a plan also sits at `executing` while the
          // workflow runtime owns its steps, and advancing it here would race
          // the orchestrator writing the same rows.
          if (!selfDrivenContinuation) {
            try {
              const { getPlanRuntime } = await import("@/lib/agent/plan/runtime")
              const activePlan = await getPlanRuntime().getExecutingPlanForSession(sessionId)
              if (activePlan) {
                const { resolvePlanStrategy } = await import("@/lib/agent/plan/strategy")
                if (resolvePlanStrategy(activePlan) === "in_session") {
                  const { handlePlanTurnComplete } = await import("@/lib/agent/plan/turn-driver")
                  const lastAssistant = [...nextMessages]
                    .reverse()
                    .find((m) => m.role === "assistant")
                  const ac = new AbortController()
                  const unregister = getPlanRuntime().registerAbortController(activePlan.id, ac)
                  let outcome: Awaited<ReturnType<typeof handlePlanTurnComplete>>
                  try {
                    outcome = await handlePlanTurnComplete({
                      planId: activePlan.id,
                      lastResponse: extractAssistantText(lastAssistant),
                      capturedGenerationId: activePlan.generationId,
                      signal: ac.signal,
                    })
                  } finally {
                    unregister()
                  }
                  if (outcome.kind === "exit") {
                    useChatStore.getState().appendMessage({
                      id: `sys-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                      role: "system",
                      parts: [
                        {
                          type: "text",
                          text: renderPlanExitCard(
                            activePlan.title,
                            outcome.status,
                            outcome.reason
                          ),
                        },
                      ],
                    })
                    await persistMessages(sessionId, useChatStore.getState().messages).catch(
                      () => {}
                    )
                  } else if (outcome.kind === "continue" && sessionId === activeRef.current) {
                    // No pacing gate: a plan has a finite step list, so the next
                    // step follows immediately (the user pauses via the tracker
                    // dock, which rotates the generation and makes this `stale`).
                    void sendRef.current?.(outcome.userMessage, undefined, {
                      skipUserAppend: true,
                    })
                  }
                  // aborted | stale | no_plan → no-op: a pause/cancel/refine owns
                  // the next step and the tracker dock reflects the status.
                }
              }
            } catch (err) {
              console.warn("plan turn-driver failed", err)
            }
          }
        }
      }
      if (turnComplete && !isOpen) {
        chatTurnPerformance.finish(sessionId, "completed")
      }
      return
    }
  }
}
