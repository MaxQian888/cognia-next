"use client"

import { startTransition, useCallback, useEffect, useRef } from "react"
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
import { getGoalRuntime } from "@/lib/goal/runtime"
import { handleTurnComplete } from "@/lib/goal/turn-driver"
import { defaultLifecycleFirer } from "@/lib/claude/hooks/lifecycle-firer"
import { buildGoalJudgeClient } from "@/lib/goal/judge-client"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { runAutoModeForTool } from "@/lib/claude/permissions/auto-mode-runner"
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
import { attemptRoutingFallback } from "@/lib/claude/routing-fallback"
import { notifyOverBudgetOnce } from "@/lib/claude/over-budget-toast"
import { applyPlanModeBridge } from "@/lib/agent/plan-mode-bridge"
import {
  approveTool,
  closeSession,
  deleteMessage,
  interruptSession,
  onClaudeMessage,
  sendPrompt,
} from "@/lib/claude/ipc"
import { detectPlatform } from "@/hooks/use-platform"

// ADR-0020 W3 — the chat-modal session grant only ever applies to the
// three plugin MCP tools that the `cognia-computer-use` plugin
// contributes. Hard-coded as a tight const so a typo in a future tool
// rename won't silently flip permissions on the wrong tool.
const COMPUTER_USE_PLUGIN_TOOL_NAMES = new Set([
  "computer_use",
  "bash",
  "text_editor",
  // The sidecar surfaces them through the cognia-plugin-tools MCP, so
  // the prefixed form lands on the chat side. Match both bare and
  // prefixed in case the upstream renames the bridge.
  "mcp__cognia-plugin-tools__computer_use",
  "mcp__cognia-plugin-tools__bash",
  "mcp__cognia-plugin-tools__text_editor",
])

function isComputerUsePluginToolName(name: string): boolean {
  return COMPUTER_USE_PLUGIN_TOOL_NAMES.has(name)
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
  truncateAfter,
  updateMessageMetadata,
} from "@/lib/db/messages"
import { getDb } from "@/lib/db/schema"
import { useRafThrottle, type RafThrottleHandle } from "@/hooks/workflow/use-raf-throttle"
import {
  useDebouncedCallback,
  type DebouncedCallbackHandle,
} from "@/hooks/workflow/use-debounced-callback"
import {
  getSession,
  setSdkSessionId,
  touchSession,
  updateSession,
  clearBranchSeed,
} from "@/lib/db/sessions"
import { recordResultUsage } from "@/lib/db/session-usage"
import { recordProviderOutcome } from "@/lib/claude/provider-telemetry"
import { useInFlightStore } from "@/stores/settings/in-flight-store"
import { endSpan, startSpan } from "@/lib/agent-trace/emitter"
import {
  clearToolSpansForSession,
  handleSdkEventForToolSpans,
} from "@/lib/agent-trace/chat-tool-spans"
import { bumpUnread } from "@/lib/db/session-state"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { useProjectStore } from "@/stores/project/project-store"
import { isWorkspaceRestricted } from "@/lib/workspace/trust-gate"
import {
  dispatchChatError as dispatchPluginChatError,
  dispatchUserPromptSubmit as dispatchPluginUserPromptSubmit,
  dispatchTokenUsage as dispatchPluginTokenUsage,
} from "@/lib/claude/adapter-hooks"
import { tryBuildTwinDeps } from "@/lib/twin/runtime/build-deps"
import { tryBuildMemoryDeps } from "@/lib/memory/runtime/build-deps"
import { runTurnMemory } from "@/lib/memory/run-turn-memory"
import { resolveMemoryConfig } from "@/types/memory/memory"
import type {
  ApprovalDecision,
  ChatSession,
  ClaudeEvent,
  PendingApproval,
  SDKEventEnvelope,
  SendContent,
  SendOptions,
} from "@/lib/claude/types"
import { useChatStore } from "@/stores/chat"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import {
  selectSessionSubagents,
  applySubagentsToMessages,
  subagentSignature,
} from "@/lib/claude/subagent-bridge"
import { useSettingsStore } from "@/stores/settings"
import { useAgentRuntimeStore, useExternalAgentStore } from "@/stores/agent"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { isTauri } from "@/lib/tauri"
import { mark as perfMark } from "@/lib/perf"
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
    transcript: messages.map((m) => ({ role: m.role, text: extractPlainText(m) })),
  })
}

/** Signature of the hook's `send`, threaded into `handleEvent` via a ref. */
type SendFn = (
  content: SendContent,
  opts?: SendOptions,
  callOptions?: { skipUserAppend?: boolean; bypassDelegation?: boolean }
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
      if (activeRef.current !== s.activeSessionId) {
        // Session switched — the prior session's streaming mirror is no longer
        // the active base; drop the whole map so the next read hits the store.
        messagesMirrorRef.current.clear()
      }
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

  /**
   * Coalesce the React-visible store commit to ≤1 per animation frame during
   * streaming. SDK events can arrive dozens of times per second; without this
   * each one triggers a synchronous re-render of the message-list subtree.
   * Latest snapshot wins.
   */
  const commit = useRafThrottle((msgs: UIMessage[]) => {
    useChatStore.getState().replaceMessages(msgs)
  })

  /**
   * Debounce the Dexie write during streaming so we don't run a transaction
   * per token. Flushed (and the final state awaited) on turnComplete. 0ms in
   * tests degrades to synchronous so existing persist-ordering assertions hold.
   */
  const PERSIST_DEBOUNCE_MS = process.env.NODE_ENV === "test" ? 0 : 250
  const persistDebounced = useDebouncedCallback((sid: string, msgs: UIMessage[]) => {
    void persistMessages(sid, msgs).catch((err) =>
      console.error("debounced persistMessages failed", err)
    )
  }, PERSIST_DEBOUNCE_MS)

  // The handle objects are recreated each render (only their `call`/`flush`/
  // `cancel` members are stable), so we read them through refs — both from the
  // long-lived event handler and from the send/stop/edit/regenerate callbacks —
  // to keep their dependency arrays free of an unstable object.
  const commitRef = useRef<RafThrottleHandle<[UIMessage[]]>>(commit)
  const persistRef = useRef<DebouncedCallbackHandle<[string, UIMessage[]]>>(persistDebounced)
  useEffect(() => {
    commitRef.current = commit
    persistRef.current = persistDebounced
  })

  // Best-effort flush of any pending streaming write on unmount so the last
  // partial isn't lost when the hook tears down mid-turn.
  useEffect(() => {
    const persist = persistRef
    return () => {
      persist.current.flush()
    }
  }, [])

  // Subscribe to sidecar events once.
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: UnlistenFn | null = null
    let cancelled = false

    onClaudeMessage((evt) => {
      // Key by session so same-session events serialize; events without a
      // session id (ready/log/sidecar_exited) share one chain — they're cheap
      // no-ops in handleEvent but still kept in arrival order.
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
            commitRef,
            persistRef,
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
    })
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
  }, [])

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
      }
    ) => {
      const sessionId = useChatStore.getState().activeSessionId
      if (!sessionId) {
        useChatStore.getState().setError("No session selected")
        return
      }
      if (typeof content === "string" && !content.trim()) return
      if (Array.isArray(content) && content.length === 0) return

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
        useChatStore.getState().setError(error.message)
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

      // Advisory daily-budget overage — the routing engine selected a provider
      // that is past its dailyCostBudget because nothing under budget was
      // available. Surface once per provider per local day; never blocks.
      notifyOverBudgetOnce(sendOptions.routingDecision?.overBudgetWarning, (v) =>
        tRouting("overBudgetToast", v)
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
        store.getState().setError(promptDecision.reason ?? "A plugin blocked this prompt.")
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

      // Capture text from the (possibly plugin-modified) effective content.
      const effectiveText =
        typeof effectiveContent === "string"
          ? effectiveContent
          : ((effectiveContent.find((b) => b.type === "text") as { text?: string } | undefined)
              ?.text ?? "")

      // New turn: drop any coalesced/debounced streaming work and the mirror
      // from a prior turn so this turn's events read the fresh optimistic base.
      commitRef.current.cancel()
      persistRef.current.cancel()
      messagesMirrorRef.current.delete(sessionId)

      // Optimistic user-message append. Skipped during regenerate so the
      // existing user anchor stays the single source of truth for that turn.
      const previousMessages = useChatStore.getState().messages
      const userMsg = makeUserMessage(effectiveContent)
      const next = callOptions?.skipUserAppend ? previousMessages : [...previousMessages, userMsg]
      if (!callOptions?.skipUserAppend) {
        store.getState().replaceMessages(next)
      }
      store.getState().setStatus("streaming")
      perfMark("stream-start")
      store.getState().setError(null)
      lastUserContentRef.current.set(sessionId, effectiveContent)

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
              import("@/lib/twin/ingest/redact"),
            ])
            const decision = routeDelegation(
              { prompt: effectiveText, context: { sessionId } },
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
          store.getState().replaceMessages(previousMessages)
          store.getState().setError("No external agent selected")
          store.getState().setStatus("idle")
          return
        }
        // The text sent to the external agent: the PII-filtered prompt when
        // delegated by rule, else the raw composer text.
        const externalSendText = delegation ? delegation.filteredPrompt : effectiveText
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
            store.getState().replaceMessages(next)
            store.getState().setError(null)
            await sendRef.current?.(effectiveContent, opts, {
              ...callOptions,
              skipUserAppend: true,
              bypassDelegation: true,
            })
            return
          }
          store.getState().replaceMessages(previousMessages)
          store.getState().setError(message)
          store.getState().setStatus("idle")
          if (error) dispatchPluginChatError(sessionId, error)
        }

        try {
          await persistMessages(sessionId, next)
          await touchSession(sessionId)
          await applyInstantTitle(sessionId, effectiveContent)

          const { executeOnExternalAgent } = await import("@/lib/ai/agent/external/manager")
          const { applyExternalAgentEventToParts } =
            await import("@/lib/ai/agent/external/event-to-parts")

          // Pre-allocate the assistant message so partial deltas land in it
          // without flickering the chat list. Parts start empty and grow as
          // ExternalAgentEvents arrive via the onEvent callback below.
          const assistantId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          let assistantParts: UIMessage["parts"] = [] as unknown as UIMessage["parts"]
          const baseList = useChatStore.getState().messages

          const writeAssistant = () => {
            // Guard against a mid-run session switch: writing the in-flight
            // external turn into the visible store would clobber whatever
            // session is now active (the SDK path guards every write the same
            // way via `activeRef`).
            if (activeRef.current !== sessionId) return
            const assistantMsg: UIMessage = {
              id: assistantId,
              role: "assistant",
              parts: assistantParts,
              ...(delegatedMeta ? { metadata: delegatedMeta } : {}),
            }
            store.getState().replaceMessages([...baseList, assistantMsg])
          }

          const result = await executeOnExternalAgent(externalSendText, {
            agentId: extAgentId,
            onEvent: (event) => {
              const nextParts = applyExternalAgentEventToParts(assistantParts, event)
              if (nextParts !== assistantParts) {
                assistantParts = nextParts as UIMessage["parts"]
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
            writeAssistant()
          }

          // Persist always targets this session's Dexie rows, but only read the
          // live store when this session is still active — otherwise build the
          // final list locally so a session switch mid-run can't persist the
          // now-active session's messages under this session id.
          const finalAssistant: UIMessage = {
            id: assistantId,
            role: "assistant",
            parts: assistantParts,
            ...(delegatedMeta ? { metadata: delegatedMeta } : {}),
          }
          const finalMessages =
            activeRef.current === sessionId
              ? useChatStore.getState().messages
              : [...baseList, finalAssistant]
          await persistMessages(sessionId, finalMessages)
          store.getState().setStatus("idle")
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err))
          await handleExternalFailure(error.message, error)
        }
        return
      }
      // ── End external agent branch ──────────────────────────────────────

      try {
        await persistMessages(sessionId, next)
        await touchSession(sessionId)
        // If the session has no title yet, derive one from the first prompt.
        // `titleAuto` marks the title as machine-set so the turn-complete path
        // may later upgrade it to an LLM-generated title (until the user
        // manually renames, which clears the flag).
        await applyInstantTitle(sessionId, effectiveContent)
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
            inputPreview: effectiveText || undefined,
          })
          sendOptions = { ...sendOptions, traceId: handle.traceId, spanId: handle.spanId }
        }
        await sendPrompt(sessionId, effectiveContent, sendOptions)
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
        store.getState().setError(error.message)
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
      }
    },
    [store, tRouting]
  )

  // Keep the module-scope `handleEvent` pointed at the latest `send` so it can
  // dispatch a silent goal continuation (ADR-0019) without closing over it.
  useEffect(() => {
    sendRef.current = send
    return () => {
      if (sendRef.current === send) sendRef.current = null
    }
  }, [send])

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

  const stop = useCallback(async () => {
    const sessionId = useChatStore.getState().activeSessionId
    if (!sessionId) return
    try {
      await interruptSession(sessionId)
      // Commit + persist whatever partial we have, then drop the mirror; the
      // sidecar's follow-up session_ended is also flush-safe (idempotent).
      commitRef.current.flush()
      persistRef.current.flush()
      messagesMirrorRef.current.delete(sessionId)
      store.getState().setStatus("idle")
    } catch (err) {
      console.error("interrupt failed", err)
    }
  }, [store])

  const respondToApproval = useCallback(
    async (approval: PendingApproval, decision: ApprovalDecision): Promise<void> => {
      // Persist always-allow choice.
      if (decision === "allow_always") {
        await useSettingsStore.getState().toggleAlwaysAllow(approval.toolName, true)
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
        store.getState().clearApproval(approval.requestId)
      }
    },
    [store]
  )

  const close = useCallback(async (sessionId: string) => {
    try {
      await closeSession(sessionId)
    } catch (err) {
      console.error("close session failed", err)
    } finally {
      // Drop this session's nested-dispatch budget guard so it doesn't leak
      // for the renderer's lifetime (it's kept alive across a turn's multiple
      // dispatch_agent calls, so teardown is the only safe release point).
      const { releaseDispatchBudgetForSession } =
        await import("@/lib/claude/agents/dispatch-agent-handler")
      releaseDispatchBudgetForSession(sessionId)
    }
  }, [])

  /**
   * Truncate the message log starting from `messageId` (inclusive) and resend
   * the supplied content. Used for "edit and resend" on a user message.
   *
   * On mobile (Capacitor), the truncate also fans out to the desktop's
   * Dexie via the companion RPC bridge so the authoritative store stays
   * in lockstep with the phone. On desktop / web the local `truncateAfter`
   * is the only mutation.
   */
  const editAndResend = useCallback(
    async (messageId: string, newContent: SendContent) => {
      const sessionId = useChatStore.getState().activeSessionId
      if (!sessionId) return
      // Truncating the history invalidates any in-flight streaming mirror for
      // this session; drop it (and pending work) so the rebuilt base wins.
      commitRef.current.cancel()
      persistRef.current.cancel()
      messagesMirrorRef.current.delete(sessionId)
      if (detectPlatform() === "mobile") {
        await mirrorTruncateToDesktop(sessionId, messageId)
      }
      // Drop everything from this message onward, including the message itself.
      await truncateAfter(sessionId, messageId, { inclusive: true })
      // Re-hydrate the store from Dexie so the optimistic append in send() is
      // applied to the correct base.
      const remaining = await listMessages(sessionId)
      store.getState().replaceMessages(remaining)
      await send(newContent)
    },
    [send, store]
  )

  /**
   * Re-issue the most recent user turn. Drops the assistant reply that
   * followed it (and anything after) and resends the original content.
   */
  const regenerate = useCallback(async () => {
    const sessionId = useChatStore.getState().activeSessionId
    if (!sessionId) return

    // Rebuilding the branch base invalidates any streaming mirror; drop it.
    commitRef.current.cancel()
    persistRef.current.cancel()
    messagesMirrorRef.current.delete(sessionId)

    const messages = useChatStore.getState().messages
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
    // belongs to the same branch group. We retain them with branchGroupId
    // metadata so the user can switch back via the BranchNavigator.
    const groupId = anchor.id
    const existingSiblings = messages.slice(lastUserIdx + 1).filter((m) => m.role === "assistant")
    const taggedSiblings = existingSiblings.map((m, i) => {
      const meta = (m as { metadata?: Record<string, unknown> }).metadata ?? {}
      // Preserve any prior branchGroupId — only stamp if missing.
      const stampedGroup =
        typeof meta.branchGroupId === "string" ? (meta.branchGroupId as string) : groupId
      const stampedIndex = typeof meta.branchIndex === "number" ? (meta.branchIndex as number) : i
      return {
        ...m,
        metadata: { ...meta, branchGroupId: stampedGroup, branchIndex: stampedIndex },
      } as typeof m
    })

    // Persist the tagged siblings (and untouched prefix) before the new send.
    const prefix = messages.slice(0, lastUserIdx + 1)
    const merged = [...prefix, ...taggedSiblings]
    store.getState().replaceMessages(merged)
    await persistMessages(sessionId, merged)

    // Stash the next-branch tag in a ref so handleEvent can stamp the
    // freshly-arrived assistant message with branchGroupId + the next index.
    const nextIndex = existingSiblings.length
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
    await send(content, undefined, { skipUserAppend: true })
  }, [send, store])

  return {
    send,
    stop,
    respondToApproval,
    close,
    editAndResend,
    regenerate,
  }
}

/**
 * Mobile-only: mirror a `truncateAfter(sessionId, anchorId, { inclusive: true })`
 * to the desktop's Dexie by calling `message_delete` for the anchor + every
 * subsequent message. Reads from the local Dexie to compute the set, which
 * is fine because mobile sync keeps the local store in lockstep before
 * any edit operation.
 *
 * Errors from individual deletes are logged but never thrown — the local
 * truncate (and subsequent send) is the load-bearing path; a desktop write
 * failure surfaces later through sync rather than blocking the user.
 */
async function mirrorTruncateToDesktop(sessionId: string, anchorMessageId: string): Promise<void> {
  try {
    const db = getDb()
    const anchor = await db.messages.get(anchorMessageId)
    if (!anchor || anchor.sessionId !== sessionId) return
    const ids = await db.messages
      .where("[sessionId+createdAt]")
      .between([sessionId, anchor.createdAt], [sessionId, Number.MAX_SAFE_INTEGER])
      .primaryKeys()
    for (const rawId of ids) {
      const id = rawId as string
      try {
        await deleteMessage(sessionId, id)
      } catch (err) {
        console.warn("mirrorTruncateToDesktop: deleteMessage failed", { id, err })
      }
    }
  } catch (err) {
    console.warn("mirrorTruncateToDesktop failed", err)
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

  // Long-term memory: build the read-runtime deps when memory is enabled and
  // the turn carries a user message. `resolveSendOptions` decides (per its own
  // enabled/temporary gate) whether to actually recall + inject.
  const memoryHandshake = userMessage?.trim()
    ? await tryBuildMemoryDeps(resolveMemoryConfig(appSettings?.memory))
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

  return resolveSendOptions({
    session,
    appSettings,
    activeProject,
    workspaceRestricted,
    referencedPaths,
    twinDeps: twinHandshake,
    twinUserMessage: twinHandshake ? userMessage : undefined,
    memoryDeps: memoryHandshake,
    memoryUserMessage: memoryHandshake ? userMessage : undefined,
    // Routing context-window pre-check input (B4): always pass the raw user
    // message (unlike twin/memory it needs no handshake gate).
    routingContextHint: userMessage ? { promptText: userMessage } : undefined,
    ephemeralSkillIds,
    activeGoal,
    activeLoop,
  })
}

/** Sub-session ids used by team chat embed `::char::` between the team
 * session id and the character id (see hooks/use-team-chat.ts). The direct
 * chat handler should ignore those — useTeamChat handles them. */
function isTeamSubSession(sessionId: string): boolean {
  return sessionId.includes("::char::")
}

/**
 * Coalescing handles + authoritative mirror threaded in from the hook. Only the
 * active session uses these; background sessions persist immediately as before.
 */
interface StreamCoalescing {
  messagesMirrorRef: React.MutableRefObject<Map<string, UIMessage[]>>
  commitRef: React.MutableRefObject<RafThrottleHandle<[UIMessage[]]>>
  persistRef: React.MutableRefObject<DebouncedCallbackHandle<[string, UIMessage[]]>>
}

async function handleEvent(
  evt: ClaudeEvent,
  activeRef: React.MutableRefObject<string | null>,
  allowListRef: React.MutableRefObject<string[]>,
  pendingBranchTagRef: React.MutableRefObject<Map<string, { groupId: string; index: number }>>,
  sendRef: React.MutableRefObject<SendFn | null>,
  coalescing: StreamCoalescing
) {
  const { messagesMirrorRef, commitRef, persistRef } = coalescing
  const commit = commitRef.current
  const persistDebounced = persistRef.current
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
    case "sidecar_exited":
      return
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
      const isActive = evt.sessionId === activeRef.current
      if (isActive) {
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
              modelId: failedSend?.options.model,
              sessionId: evt.sessionId,
            })
          }
          // P4 routing-fallback: re-issue against the next entry in the
          // chain when the cached send carried fallbackEntries and the
          // error class is transient. `attemptRoutingFallback` returns
          // `true` when a retry was scheduled — in that case suppress
          // the error toast so the UI stays in `streaming`.
          const retried = await attemptRoutingFallback(evt.sessionId, evt.error)
          if (!retried) {
            // Permanent failure — commit + persist the final partial and drop
            // the mirror. (A retry re-issues `send`, which clears it itself.)
            commit.flush()
            persistDebounced.flush()
            messagesMirrorRef.current.delete(evt.sessionId)
            useChatStore.getState().setError(evt.error)
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
            useChatStore.getState().clearLastSend(evt.sessionId)
          }
        } else {
          // Clean end without a content-bearing result event (e.g. tool-only
          // turn): flush pending streaming work and drop the mirror.
          commit.flush()
          persistDebounced.flush()
          messagesMirrorRef.current.delete(evt.sessionId)
          useChatStore.getState().setStatus("idle")
          useChatStore.getState().clearLastSend(evt.sessionId)
        }
      }
      return
    }
    case "permission_request": {
      // Auto-approve if the user has previously allowed this tool.
      if (allowListRef.current.includes(evt.toolName)) {
        try {
          await approveTool(evt.sessionId, evt.requestId, "allow")
        } catch (err) {
          console.error("auto-approve failed", err)
        }
        return
      }
      const isActive = evt.sessionId === activeRef.current
      if (!isActive) {
        // Remote Session Control: if a remote device is watching this
        // (non-foreground) session, route the approval to it instead of
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
          await approveTool(evt.sessionId, evt.requestId, "deny", "auto-denied: session not active")
        } catch (err) {
          console.error("non-active deny failed", err)
        }
        return
      }
      // Auto mode: auto-decide shell-command safety (deterministic rules +
      // optional small-model judge). A non-"ask" decision short-circuits the
      // approval modal; anything uncertain falls through to the manual prompt.
      // Fail-open: any error here just shows the normal approval.
      try {
        const settings = useSettingsStore.getState().settings
        const judgeClient = buildUtilityLlmClient({
          session: null,
          appSettings: settings,
          override: settings?.agentPermissions?.autoApprove?.judgeModel,
          featureId: "command-safety",
        })
        const decision = await runAutoModeForTool({
          toolName: evt.toolName,
          input: evt.input,
          settings,
          client: judgeClient,
          locale: settings?.language,
          pluginRules: getPluginCommandRulesets(),
        })
        if (decision && decision.decision === "allow") {
          await approveTool(evt.sessionId, evt.requestId, "allow")
          return
        }
        if (decision && decision.decision === "deny") {
          await approveTool(
            evt.sessionId,
            evt.requestId,
            "deny",
            `auto-denied (${decision.source}): ${decision.reason}`
          )
          return
        }
      } catch (err) {
        console.error("auto-mode evaluation failed", err)
      }
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
    case "event": {
      const env = evt as SDKEventEnvelope
      const sessionId = env.sessionId
      // A proceeding SDK event means any approval that was routed to a remote
      // device for this session has been answered (or the turn moved past
      // it) — cancel its backstop deny (Remote Session Control).
      clearApprovalBackstops(sessionId)
      const isActive = sessionId === activeRef.current

      // Source of truth lives in Dexie. Load → apply → save → maybe sync store.
      // Mirror-first for the active session: the store commit may be a frame
      // behind (coalesced), so the mirror holds the true latest base.
      const current = isActive
        ? (messagesMirrorRef.current.get(sessionId) ?? useChatStore.getState().messages)
        : await listMessages(sessionId)

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
          if (isActive) {
            useChatStore.getState().setActiveBranch(pendingTag.groupId, stamped.id)
          }
        }
      }

      // Plan-mode → tasks bridge: forward TodoWrite / TaskCreate / TaskUpdate
      // / TaskList / ExitPlanMode tool_use blocks to the agent-team store so
      // the workspace tasks panel surfaces the agent's own plan. Wrapped so
      // a bridge throw never breaks the chat event loop.
      try {
        const session = await getSession(sessionId)
        applyPlanModeBridge(env.event, sessionId, session?.teamId)
        // ExitPlanMode capture (ADR-0045): project the SDK plan-mode plan into
        // a structured draft AgentPlan so it can be approved + executed through
        // the unified plan pipeline. Runs once per turn (turnComplete). Lazy
        // import keeps the plan runtime out of the hot path until used.
        const { captureExitPlanMode } = await import("@/lib/agent/plan/exit-plan-capture")
        await captureExitPlanMode(env.event, sessionId, session?.characterId)
      } catch (err) {
        console.warn("planModeBridge failed", err)
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
        if (isActive) {
          // Mirror is the authoritative base for the next event (the store
          // commit below may be coalesced a frame behind). Always write it
          // synchronously before scheduling any deferred work.
          messagesMirrorRef.current.set(sessionId, nextMessages)
          if (turnComplete) {
            // Seal the turn: drop any coalesced/debounced work from earlier
            // tokens and commit + durably persist the final state now. Use an
            // explicit synchronous commit (not commit.flush()) because the
            // twin-sources merge above may have rewritten `nextMessages` after
            // the last commit.call — flush would re-commit the pre-merge args.
            commit.cancel()
            persistDebounced.cancel()
            useChatStore.getState().replaceMessages(nextMessages)
            await persistMessages(sessionId, nextMessages)
          } else {
            // Mid-stream: coalesce the React commit to ≤1/frame and debounce
            // the Dexie write. The mirror keeps the read path correct.
            commit.call(nextMessages)
            persistDebounced.call(sessionId, nextMessages)
          }
        } else {
          await persistMessages(sessionId, nextMessages)
          if (
            nextMessages.length > current.length &&
            nextMessages[nextMessages.length - 1]?.role === "assistant"
          ) {
            // Background reply landed for a non-active session — bump the
            // unread count so the channel list shows a dot.
            await bumpUnread(sessionId).catch(() => {})
          }
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
          })
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

      if (turnComplete && isActive) {
        // Streaming sealed. Flush any still-pending coalesced commit / debounced
        // write (covers the no-delta seal where the commit block above was
        // skipped because nextMessages === current), then drop the mirror so the
        // next turn's first event reads a fresh base from the store. Idempotent
        // when the delta branch already committed + canceled above.
        commit.flush()
        persistDebounced.flush()
        messagesMirrorRef.current.delete(sessionId)

        // Don't immediately flip to idle if approvals are still pending; the
        // store helper handles the precedence.
        const { pendingApprovals } = useChatStore.getState()
        if (pendingApprovals.length === 0) {
          perfMark("stream-end")
          // Wrap the streaming→idle flip in `startTransition` so the heavy
          // commit it triggers — unmounting Streamdown, mounting react-markdown
          // + sanitize, and lazy-loading any Mermaid/Math/Diff blocks via
          // next/dynamic — lands at transition priority. The user's scroll
          // and keyboard input remain interruptible during the swap.
          startTransition(() => {
            useChatStore.getState().setStatus("idle")
          })
        }

        // Auto-detect artifacts in the assistant turn that just sealed.
        // Honors the artifacts settings block; off by default for
        // power-users that flip the toggle.
        try {
          const settings = useSettingsStore.getState().settings
          const artifactsCfg = settings?.artifacts
          if (artifactsCfg?.autoCreate !== false) {
            const lastAssistant = [...nextMessages].reverse().find((m) => m.role === "assistant")
            const text = extractAssistantText(lastAssistant)
            if (text && lastAssistant) {
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
          console.warn("autoCreateFromContent failed", err)
        }

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
        }
      }
      return
    }
  }
}
