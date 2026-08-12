"use client"

import { getGoalRuntime } from "@/lib/goal/runtime"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import {
  runTitleTask,
  shouldGenerateTitle,
  isPlaceholderTitle,
} from "@/lib/ai/generation/run-title-task"
import { markTitleFailed, clearTitleRetry } from "@/lib/ai/generation/title-retry"
import { smartContentPreview } from "@/lib/ai/generation/smart-preview"
import { generateTurnLabel } from "@/lib/ai/generation/turn-label"
import { gateContinuation } from "@/lib/goal/pacing"
import { getLoopRuntime } from "@/lib/loop/runtime"
import { gateLoopContinuation } from "@/lib/loop/pacing"
import type { LoopStatus } from "@/types/loop"
import type { GoalStatus } from "@/types/goal"
import type { PlanStatus } from "@/types/agent/plan"
import { updateMessageMetadata } from "@/lib/db/messages"
import { getSession, updateSession } from "@/lib/db/sessions"
import { runTurnMemory } from "@/lib/memory/run-turn-memory"
import type { SendContent, SendOptions } from "@cognia/agent-config-types"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import type { UIMessage } from "ai"

/**
 * Pull plain assistant text out of a UIMessage's parts. Used to feed the
 * artifact detector; only the rendered text content is meaningful — tool
 * calls and reasoning blocks are ignored.
 */
export function extractAssistantText(message: UIMessage | undefined): string {
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
export function extractPlainText(message: UIMessage | undefined): string {
  if (!message) return ""
  return message.parts
    .map((part) => {
      const p = part as { type?: string; text?: string }
      return p.type === "text" && typeof p.text === "string" ? p.text : ""
    })
    .filter(Boolean)
    .join("\n")
}

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
export const SIDECAR_EXITED_TRACE_MESSAGE =
  "The assistant process stopped unexpectedly. Your last turn was interrupted — retry to continue."

/**
 * Write the instant first-message title preview onto a session — but only when
 * the session still carries a placeholder title (never clobber a user rename),
 * re-reading a *fresh* row so a concurrent write can't be overwritten from a
 * stale snapshot. Shared by both the external-agent and SDK send paths.
 */
export async function applyInstantTitle(sessionId: string, content: SendContent): Promise<void> {
  const preview = smartContentPreview(content, 40)
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
export function runUtilityModelTasks(sessionId: string, messages: UIMessage[]): void {
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
        const sourceText = extractPlainText(firstUser)
        const resultText = extractAssistantText(firstAssistant)
        const titleResult = await runTitleTask({
          session: sessionRow,
          appSettings: settings,
          override: titleCfg,
          featureId: "conversation-title",
          sourceText,
          resultText,
          locale,
          currentTitle: sessionRow.title,
          dedupKey: sessionId,
          // Re-read titleAuto before writing — the user may have renamed the
          // session while the model call was in flight.
          isStillAuto: async () => {
            const fresh = await getSession(sessionId).catch(() => undefined)
            return !fresh || fresh.titleAuto !== false
          },
          persist: (title) => updateSession(sessionId, { title, titleAuto: true }),
        })
        if (titleResult) {
          clearTitleRetry(sessionId)
        } else {
          // Title generation failed — mark for retry on next session focus / app resume.
          markTitleFailed(sessionId, { sourceText, resultText, locale })
        }
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
export function runMemoryTasks(sessionId: string, messages: UIMessage[]): void {
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
export type SendFn = (
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
export const goalJudgeClientWarned = new Set<string>()

/** Epoch ms of the last dispatched auto-continuation, per goal (interval gating). */
export const goalLastContinuationAt = new Map<string, number>()

/** Active manual-continue unsubscribe fns, per goal (one held continuation at a time). */
export const goalManualUnsub = new Map<string, () => void>()

/** Active defer timers, per goal (quiet-hours / interval). */
export const goalDeferTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Tear down any pending continuation (defer timer + manual subscription) for a goal. */
export function clearPendingContinuation(goalId: string): void {
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
export function scheduleGoalContinuation(
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
export const loopDeferTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Tear down any pending continuation timer for a loop. */
export function clearPendingLoopContinuation(loopId: string): void {
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
export function scheduleLoopContinuation(
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
export function renderLoopExitCard(resultingStatus: LoopStatus, reason: string): string {
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
export function renderPlanExitCard(title: string, status: PlanStatus, reason: string): string {
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
export function renderGoalExitCard(resultingStatus: GoalStatus, reason: string): string {
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
