"use client"

import { startTransition } from "react"
import {
  applySdkEvent,
  extractUsage,
  mergeAgentKnowledgeSourcesIntoLastAssistant,
  mergeMemorySourcesIntoLastAssistant,
  mergeProjectKnowledgeSourcesIntoLastAssistant,
  mergeTwinSourcesIntoLastAssistant,
} from "@/lib/claude/adapter"
import { createDiagnostic } from "@cognia/diagnostics"
import { toDiagnostic } from "@/lib/diagnostics/to-diagnostic"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { handleTurnComplete } from "@/lib/goal/turn-driver"
import { defaultLifecycleFirer } from "@/lib/claude/hooks/lifecycle-firer"
import { buildGoalJudgeClient } from "@/lib/goal/judge-client"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { runAutoModeForTool } from "@/lib/claude/permissions/auto-mode-runner"
import { getPluginCommandRulesets } from "@/lib/plugin/registries/command-safety-registry"
import { parseSuggestedDelay } from "@/lib/goal/prompts"
import { getLoopRuntime } from "@/lib/loop/runtime"
import { handleLoopTurnComplete } from "@/lib/loop/turn-driver"
import { attemptRoutingFallback } from "@/lib/claude/routing-fallback"
import { applyPlanModeBridge } from "@/lib/agent/plan-mode-bridge"
import {
  isSessionOpen,
  markPendingSteersFailed,
  maybeDrainSteer,
  steerArmed,
} from "./steer-runtime"
import { drainSessionPeerMessages } from "@/lib/chat/session-peer-messaging"
import { completeAttachedSession } from "@/lib/chat/attached-session"
import { maybeDrainBackgroundResults } from "./background-result-runtime"
import { getSubagentApprovalRoute } from "@/lib/claude/agents/subagent-approval-routes"
import { approveTool, toolResultDecision } from "@/lib/claude/ipc"
import type { RemoteExecutionContext } from "@/lib/claude/remote-execution"
import { releaseSkillLoadContext } from "@/lib/skills/runtime-loader"
import {
  armApprovalBackstop,
  clearApprovalBackstops,
  isSessionAttached,
} from "@/lib/companion/remote-attach-registry"
import { notifyRemoteNeedsInput } from "@/lib/companion/needs-input-notifier"
import { listMessages, persistMessages } from "@/lib/db/messages"
import { SessionCoalescingRegistry } from "@/hooks/chat/stream-coalescing"
import { getSession, setSdkSessionId } from "@/lib/db/sessions"
import { recordResultUsage } from "@/lib/db/session-usage"
import { recordProviderOutcome } from "@/lib/claude/provider-telemetry"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { useInFlightStore } from "@/stores/settings/in-flight-store"
import { endSpan, recordEvent } from "@cognia/agent-trace/emitter"
import {
  clearToolSpansForSession,
  handleSdkEventForToolSpans,
} from "@cognia/agent-trace/chat-tool-spans"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"
import { bumpUnread } from "@/lib/db/session-state"
import {
  attachRunMetadataToLastAssistant,
  buildCompletedRunMetadata,
} from "@/lib/chat/message-run-metadata"
import { type AgentExecutionHandle } from "@/lib/ai/agent/execution/agent-execution-handle"
import { attachInteractiveGrounding } from "@/lib/rag/chat-grounding"
import { attachCheckpointCapture, captureCompactionCheckpoint } from "@/lib/rag/compaction-runtime"
import {
  dispatchTokenUsage as dispatchPluginTokenUsage,
  dispatchPostChatReceive as dispatchPluginPostChatReceive,
  dispatchPreToolUse as dispatchPluginPreToolUse,
  dispatchPostToolUse as dispatchPluginPostToolUse,
  dispatchOnAssistantMessage as dispatchPluginAssistantMessage,
} from "@/lib/claude/adapter-hooks"
import { isStandaloneChatMode } from "@/lib/runtime/standalone-mode"
import type { ClaudeEvent, PendingApproval, SDKEventEnvelope } from "@cognia/agent-config-types"
import { isSubSessionId } from "@/lib/claude/team-session-id"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { routeAiRevision } from "@/lib/artifacts/route-ai-revision"
import { chatTurnPerformance } from "@/lib/perf/chat-turn-performance"
import {
  finishDirectChatExecutionRun,
  projectDirectChatSdkMessage,
} from "@/lib/execution/direct-chat-run"
import type { UIMessage } from "ai"
import {
  chatToolCallsById,
  behaviorTurnStartedAt,
  finishBehaviorTurn,
  rememberChatToolCall,
  rememberToolCallsFromSdkEvent,
} from "./claude-chat-tool-hooks"
import {
  SIDECAR_EXITED_TRACE_MESSAGE,
  extractAssistantText,
  goalJudgeClientWarned,
  renderGoalExitCard,
  renderLoopExitCard,
  renderPlanExitCard,
  runMemoryTasks,
  runUtilityModelTasks,
  scheduleGoalContinuation,
  scheduleLoopContinuation,
} from "./claude-chat-turn-tasks"
import type { SendFn } from "./claude-chat-turn-tasks"

/** Sub-session ids used by team chat embed `::char::` between the team
 * session id and the character id (see hooks/use-team-chat.ts). The direct
 * chat handler should ignore those — useTeamChat handles them. */
export function isTeamSubSession(sessionId: string): boolean {
  return isSubSessionId(sessionId)
}

/**
 * Per-session coalescing registry + authoritative mirror threaded in from the
 * hook. Every *open* session (active or a background pane) coalesces through
 * the registry so it streams live into its own slice; sessions with no open
 * pane persist immediately to Dexie and surface via unread badges as before.
 */
export interface StreamCoalescing {
  messagesMirrorRef: React.MutableRefObject<Map<string, UIMessage[]>>
  registry: SessionCoalescingRegistry
  getExecutionHandle: (sessionId: string) => AgentExecutionHandle | undefined
}

/**
 * Upper bound on how long the renderer waits for Auto-mode's optional model
 * judge before giving up and showing the manual approval modal. Prevents a
 * wedged utility-LLM call from freezing a turn with no visible dialog.
 */
export const AUTO_MODE_DECISION_TIMEOUT_MS = 12_000

/** Read a session's current slice messages (its streaming base). */
export function sliceMessages(sessionId: string): UIMessage[] {
  return useChatStore.getState().sessions[sessionId]?.messages ?? []
}

/** Drain a session's queued steer through this hook's send (direct replay). */
export function drainSteerVia(sessionId: string, sendRef: React.MutableRefObject<SendFn | null>) {
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
export async function tryAutoModeDecision(evt: {
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

export async function handleEvent(
  evt: ClaudeEvent,
  activeRef: React.MutableRefObject<string | null>,
  allowListRef: React.MutableRefObject<string[]>,
  pendingBranchTagRef: React.MutableRefObject<Map<string, { groupId: string; index: number }>>,
  sendRef: React.MutableRefObject<SendFn | null>,
  coalescing: StreamCoalescing
) {
  const { messagesMirrorRef, registry, getExecutionHandle } = coalescing
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
        // Open panes flush their coalesced React commit; closed panes have no
        // commit pending but (ADR-0127) may hold a debounced Dexie write and an
        // in-flight mirror — flush + drop those for every streaming session.
        if (isSessionOpen(sid)) registry.get(sid).commit.flush()
        registry.get(sid).persist.flush()
        registry.release(sid)
        messagesMirrorRef.current.delete(sid)
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
        await finishDirectChatExecutionRun(sid, "failed", Date.now(), "Sidecar exited")
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
        releaseSkillLoadContext(sid)
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
            await finishDirectChatExecutionRun(evt.sessionId, "failed", Date.now(), evt.error)
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
          await finishDirectChatExecutionRun(evt.sessionId, "completed")
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
        void drainSessionPeerMessages(evt.sessionId).catch(() => undefined)
      }
      if (!sealOpen) {
        await finishDirectChatExecutionRun(
          evt.sessionId,
          evt.error ? "failed" : "completed",
          Date.now(),
          evt.error
        )
      }
        // ADR-0127: a closed pane now debounces its Dexie writes too, so its
        // end-of-turn must flush whatever is pending and drop the in-flight
        // mirror — otherwise the last delta of a background turn could sit in
        // the debouncer past the session's end.
        registry.get(evt.sessionId).persist.flush()
        registry.release(evt.sessionId)
        messagesMirrorRef.current.delete(evt.sessionId)
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
        // frame over /ws/events and will resolve it via claude_approve.
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
      await projectDirectChatSdkMessage(sessionId, env.event)
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
        : (messagesMirrorRef.current.get(sessionId) ?? (await listMessages(sessionId)))

      // Track assistant tool_use blocks so the post-tool hook can correlate
      // `tool_result_review` events with the call's name + input.
      rememberToolCallsFromSdkEvent(env.event)

      const {
        messages: appliedMessages,
        turnComplete,
      // A closed pane used to re-read Dexie for every event, which is what
      // forced it to write Dexie for every event too (ADR-0127 §1). It now
      // keeps the same in-flight mirror as an open pane, so its writes can
      // ride the debounced persist path; the mirror is dropped once the turn
      // has been durably persisted.
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
      const systemEvent = env.event as {
        type?: string
        subtype?: string
        compact_metadata?: { pre_tokens?: number; post_tokens?: number }
      }
      if (systemEvent.type === "system" && systemEvent.subtype === "compact_boundary") {
        const boundary = [...appliedMessages]
          .reverse()
          .find(
            (message) =>
              message.role === "system" &&
              (message.parts[0] as { type?: string } | undefined)?.type === "compact-boundary"
          )
        if (boundary) {
          const checkpoint = await captureCompactionCheckpoint({
            boundaryId: boundary.id,
            sessionId,
            metadata: systemEvent.compact_metadata ?? {},
            options: useChatStore.getState().lastSendBySession[sessionId]?.options,
          })
          nextMessages = attachCheckpointCapture(nextMessages, checkpoint)
        }
      }
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
          const handle = getExecutionHandle(sessionId)
          if (handle) applySdkSubagentBridge(env.event, sessionId, handle)
          else applySdkSubagentBridge(env.event, sessionId)
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
        const projectKnowledgeCtx = last?.options.projectKnowledgeContext
        if (projectKnowledgeCtx) {
          const withProjectKnowledge = mergeProjectKnowledgeSourcesIntoLastAssistant(
            nextMessages,
            projectKnowledgeCtx
          )
          if (withProjectKnowledge !== nextMessages) nextMessages = withProjectKnowledge
        }
        const agentKnowledgeCtx = last?.options.agentKnowledgeContext
        if (agentKnowledgeCtx) {
          const withAgentKnowledge = mergeAgentKnowledgeSourcesIntoLastAssistant(
            nextMessages,
            agentKnowledgeCtx
          )
          if (withAgentKnowledge !== nextMessages) nextMessages = withAgentKnowledge
        }
        const completedAt = Date.now()
        const startedAt = behaviorTurnStartedAt.get(sessionId)
        const result = sdkResult as { duration_ms?: number; subtype?: string } | undefined
        nextMessages = attachRunMetadataToLastAssistant(
          nextMessages,
          buildCompletedRunMetadata({
            providerId: last?.options.provider,
            modelId: last?.options.model,
            startedAt,
            completedAt,
            reportedDurationMs: result?.duration_ms,
            finishReason: result?.subtype,
          })
        )
        nextMessages = attachInteractiveGrounding(nextMessages, last?.options)
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
          // No open pane — no live slice to feed, but the Dexie write is still
          // debounced through the same per-session coalescer as an open pane
          // (ADR-0127 §1: one write policy for every rail). The mirror is the
          // base for the next event; the turn seal writes the canonical list
          // synchronously and drops the in-flight state.
          messagesMirrorRef.current.set(sessionId, nextMessages)
          const coalesce = registry.get(sessionId)
          if (turnComplete) {
            coalesce.persist.cancel()
            chatTurnPerformance.beginFinalPersistence(sessionId)
            await persistMessages(sessionId, nextMessages)
            chatTurnPerformance.endFinalPersistence(sessionId)
            messagesMirrorRef.current.delete(sessionId)
            registry.release(sessionId)
          } else {
            coalesce.persist.call(nextMessages)
          }
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

      if (turnComplete) {
        void import("@/lib/skills/runtime-loader").then((runtime) =>
          runtime.releaseSkillLoadContext(sessionId)
        )
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
        if (completedSession?.attachedChild) {
          const finalAssistant = [...nextMessages].reverse().find((m) => m.role === "assistant")
          const summary = finalAssistant ? (extractAssistantText(finalAssistant) ?? "").trim() : ""
          if (summary) {
            void completeAttachedSession(sessionId, {
              summary,
              messageId: finalAssistant?.id,
            }).catch((error) => console.warn("attached session completion state failed", error))
          }
        }

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
