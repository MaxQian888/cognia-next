"use client"

import { externalAgentPresetIdOf } from "@/lib/ai/agent/external/config/preset-identity"

import { useCallback, useEffect, useRef, useState } from "react"
import { hasCaptureResponder } from "@/lib/connectors/hitl/approval-registry"
import { useTranslations } from "next-intl"
import { isCapabilityUsable } from "@cognia/agent-config-types/external-agent-capability"
import { isCogniaProjectedTool } from "@/lib/ai/agent/external/policy/tool-preapproval"
import type { UnlistenFn } from "@tauri-apps/api/event"
import { persistMessageSessionAssets } from "@/lib/db/session-assets"
import { makeUserMessage } from "@/lib/claude/adapter"
import { clearProjectHistoryEvidence } from "@/lib/claude/project-history-evidence-registry"
import { toast } from "sonner"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { enforceVideoDeliveryForRoute } from "@/lib/chat/attachments/video/route-guard"
import { videoRouteFacts } from "@/lib/chat/attachments/video/route-facts"
import { prefixReplyContext, withReplyContextLines } from "@/lib/chat/reply-to"
import type { ContextRef } from "@/lib/chat/mentions/types"
import {
  carryPromptPreamble,
  chipCitationsOf,
  readPromptPreambleSummary,
  stripPromptPreamble,
  type PromptPreambleSummary,
} from "@/lib/chat/prompt-preamble"
import { createDiagnostic, type CogniaDiagnostic } from "@cognia/diagnostics"
import { createSilenceWatchdog, type SilenceWatchdog } from "@/lib/chat/silence-watchdog"
import { resolveTurnSquad } from "@/lib/ai/agent/team/squad/resolve-turn-squad"
import {
  resolveExternalAgentModelAxis,
  resolveExternalAgentCogniaModelAxis,
} from "@/lib/ai/agent/external/session/session-models"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { toDiagnostic } from "@/lib/diagnostics/to-diagnostic"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"
import { flushProjectEditorEdits } from "@/lib/files/project-editor-bridge"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { deriveAllowRuleFromApproval } from "@/lib/claude/permissions/approval-rule"
import { setToolRule } from "@/lib/claude/permissions/ruleset-edit"
import { getLoopRuntime } from "@/lib/loop/runtime"
import { renderLoopIterationMessage } from "@/lib/loop/prompts"
import { notifyDroppedCapabilityOnce } from "@/lib/claude/dropped-capability-toast"
import { notifyOverBudgetOnce } from "@/lib/claude/over-budget-toast"
import { steerBlocksOf, steerTextOf, type SteerMessageMeta } from "@/lib/claude/steer"
import {
  appendSteerMessage,
  isSessionOpen,
  markPendingSteersFailed,
  mergeSteerWebSearchIntoLastSend,
  sessionExternalLane,
  sessionStatusOf,
  setSessionExternalLane,
  setSteerMessageState,
  steerArmed,
} from "./steer-runtime"
import { supersedePendingApprovals } from "./approval-supersede"
import { invalidateJudgeContext } from "@/lib/claude/permissions/command-judge"
import {
  drainSessionPeerMessages,
  registerSessionPeerRuntime,
} from "@/lib/chat/session-peer-messaging"
import {
  buildSessionPeerInboundMessage,
  renderSessionPeerModelPrompt,
} from "@/lib/chat/session-peer-delivery"
import { expireSessionPeerMessages } from "@/lib/db/session-peer-messages"
import { markAttachedSessionRunning } from "@/lib/chat/attached-session"
import { externalTokenUsageToUsageInfo } from "@/lib/claude/usage"
import { recordExternalAgentUsage } from "@/lib/db/session-usage"
import {
  attachRunMetadataToLastAssistant,
  attachUsageToLastAssistant,
  buildCompletedRunMetadata,
  buildRoutingRunMetadata,
} from "@/lib/chat/message-run-metadata"
import { turnAgentStamp } from "@/lib/claude/turn-agent-mode"
import {
  maybeDrainBackgroundResults,
  registerBackgroundReplaySend,
} from "./background-result-runtime"
import { registerChatRetryBridge, registerChatSendBridge } from "./chat-send-bridge"
import { tagBranchSiblings, tagEditSibling } from "@/lib/chat/branch-regen"
import {
  approveTool,
  closeSession,
  compactSession,
  interruptSession,
  onClaudeMessage,
  sendPrompt,
  setSessionModel,
} from "@/lib/claude/ipc"
import { recordChatToolApprovalDecision } from "@/lib/policy/action-review/chat-tool-channel"
import { isEmbeddedSession } from "@/lib/chat/session-exposure"
import { gateWorkbenchProviderPayload } from "@/lib/context-workbench/provider-payload"
import { clearSessionGrants } from "@/lib/claude/computer-use-session-grants"
import { releaseSkillLoadContext } from "@/lib/skills/runtime-loader"
import {
  commitMessageDelta,
  listMessages,
  persistMessages,
  persistStreamingMessages,
} from "@/lib/db/messages"
import { enqueueHostStateIntentIfAvailable } from "@/lib/db/mobile-outbound-queue"
import { SessionCoalescingRegistry } from "@/hooks/chat/stream-coalescing"
import {
  getSession,
  touchSession,
  updateSession,
  clearBranchSeed,
  freezeImportedSession,
} from "@/lib/db/sessions"
import { assertSessionWritable } from "@/lib/chat/session-write-guard"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { useInFlightStore } from "@/stores/settings/in-flight-store"
import { endSpan, recordEvent, startSpan } from "@cognia/agent-trace/emitter"
import { toTraceparent } from "@/lib/agent-trace/trace-context"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"
import { beginCodeAdoptionTurn } from "@/lib/code-adoption/client"
import { compositionForSession, useAgentRuntimeStore } from "@/stores/agent/agent-runtime-store"
import {
  markTaskWorkspaceTurnCancelled,
  markTaskWorkspaceTurnUnowned,
} from "@/lib/code-adoption/turn-tracker"
import {
  acquireWorkspaceBundle,
  isWorkspaceBusyRefusal,
  runIdForTurn,
  taskIdForMessage,
} from "@/lib/task-workspace/client"
import { sandboxSessionRuntime } from "@/lib/sandbox/session-runtime"
import {
  finishDirectChatExecutionRun,
  projectDirectChatCaptureEvent,
  startDirectChatExecutionRun,
} from "@/lib/execution/direct-chat-run"
import {
  beginSharedSessionRun,
  authorizeSharedSessionApproval,
  sendSharedSessionMessage,
  sharedRequestTranscript,
  canAutomaticallyDrainSharedQueue,
} from "@/lib/collab/shared-run-coordinator"
import {
  acceptChatTurn,
  bindChatTurnContext,
  chatSubmissionId,
  claimChatTurnForDispatch,
  markChatTurnStarted,
  settleChatTurnForSession,
} from "@/lib/work-submission/chat-adapter"
import { startWorkSubmissionLeaseHeartbeat } from "@/lib/work-submission/lease-heartbeat"
import {
  canonicalEventFromExternalEvent,
  captureEventFromCanonical,
} from "@/lib/ai/agent/execution/event-envelope"
import { openWorkspaceBundleTurnLease } from "@/lib/task-workspace/run-lease"
import {
  ensureSessionExecutionBundle,
  type SessionBundleBinding,
} from "@/lib/task-workspace/session-bundle"
import {
  repairManagedContextProjectId,
  bindExecutionBundleTurn,
  bindExecutionRun,
  resolveSessionWorkspaceRoot,
  transitionManagedWorktree,
} from "@/lib/task-workspace/session-execution-context"
import { getProjectEnvironment } from "@/lib/db/project-environments"
import { executeProjectEnvironment } from "@/lib/project-environment/executor"
import { resolveEnvironmentForRun } from "@/lib/project-environment/resolve-environment"
import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"
import {
  createAgentExecutionHandle,
  type AgentExecutionHandle,
} from "@/lib/ai/agent/execution/agent-execution-handle"
import { useAgentExecutionHandleDirectory } from "@/components/providers/agent-execution-handle-provider"
import { useGitStore } from "@/stores/git/git-store"
import { refreshGitStatus } from "@/lib/git/load"
import { chatMentionResolvers } from "@/lib/claude/agents/chat-mention-targets"
import {
  routeTargetsFromStores,
  snapshotRouteContext,
  type RouteContextSnapshot,
} from "@/lib/chat/turn-route/snapshot"
import { buildRouteStamp, resolveRouteLane, routeCharacter } from "@/lib/chat/turn-route/resolve"
import { parseLeadingRoute, stripLeadingRouteToken } from "@/lib/chat/turn-route/parse"
import {
  foreignTurnsHandoffText,
  prefixForeignTurnsContext,
  unseenForeignTurns,
} from "@/lib/chat/turn-route/history"
import {
  isRoutableSession,
  readTurnRoute,
  type RouteLane,
  type TurnRoute,
} from "@/lib/chat/turn-route/types"
import type { MessageRunRouteStamp } from "@/lib/chat/message-run-metadata"
import { resolveTurnContextRefs } from "@/lib/chat/mentions/resolve-mentions"
import { isTranscriptEntityRefId } from "@/lib/collab/shared-reference-scan"
import type { ChatTemplateRun } from "@/lib/chat/template/run"
import {
  dispatchChatError as dispatchPluginChatError,
  dispatchUserPromptSubmit as dispatchPluginUserPromptSubmit,
  dispatchOnMessageSend as dispatchPluginMessageSend,
  hasPostToolUseListeners,
} from "@/lib/claude/adapter-hooks"
import { isStandaloneChatMode } from "@/lib/runtime/standalone-mode"
import { runStandaloneTurn } from "@/lib/ai/chat/standalone-engine"
import type {
  ApprovalDecision,
  ClaudeEvent,
  PendingApproval,
  SendContent,
  SendOptions,
  MessageReplyTo,
} from "@cognia/agent-config-types"
import {
  selectComposerCitedRefs,
  selectComposerEphemeralSkillIds,
  selectComposerPendingCommandOverrides,
  selectVisibleMessages,
  useChatStore,
} from "@/stores/chat"
import { getExecutionBroker } from "@/lib/execution/broker"
import { slotKeyForTurn } from "@/lib/execution/slot-key"
import { resolveEffectiveCwdForSession } from "@/hooks/chat/use-effective-cwd"
import {
  acquireChatLease,
  isChatTurnQueued,
  isQueuedChatTurnCancellation,
} from "@/lib/execution/chat-lease"
import { workingCopyConflict } from "@/lib/execution/lease-conflict"
import {
  markTurnAdmission,
  turnMessageId,
  waitFromBlocker,
  type TurnAdmissionMeta,
} from "@/lib/chat/turn-admission"
import {
  classifyExternalTurnFailure,
  planHaltCauseForCode,
} from "@/lib/ai/agent/external/turn-failure"
import { driveInSessionPlanAfterTurn, haltInSessionPlanOnTurnFailure } from "./plan-turn-settle"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import {
  selectSessionSubagents,
  applySubagentsToMessages,
  subagentSignature,
} from "@/lib/claude/subagent-bridge"
import { useSettingsStore } from "@/stores/settings"
import { useProjectStore } from "@/stores/project/project-store"
import { useExternalAgentStore } from "@/stores/agent"
import { runtimeRefForSession } from "@/stores/agent/agent-runtime-store"
import type { AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import { isSameRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import { isTauri } from "@/lib/tauri"
import { isCapacitor } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { chatTurnPerformance } from "@/lib/perf/chat-turn-performance"
import { enforceCostBudget, isCostBudgetConfigured } from "@/lib/usage/cost-budget-gate"
import { cancelRouterFusionTurn } from "@/lib/router-fusion/gate/chat-events"
import { abortRouterFusionSend, prepareRouterFusionSend } from "@/lib/router-fusion/gate/chat-send"
import { routerFusionRefusalDiagnostic } from "@/lib/router-fusion/gate/refusal-diagnostic"
import { RouterFusionRefusalError } from "@/lib/router-fusion/gate/faults"
import type { UIMessage } from "ai"
import { registerInteractiveWorkSubmissionEvents } from "@/lib/work-submission/terminal-events"
import {
  behaviorTurnStartedAt,
  finishBehaviorTurn,
  isComputerUsePluginToolName,
} from "./claude-chat-tool-hooks"
import {
  applyInstantTitle,
  clearPendingLoopContinuation,
  extractAssistantText,
} from "./claude-chat-turn-tasks"
import type { SendFn } from "./claude-chat-turn-tasks"
import { buildSendOptions } from "./claude-chat-send-options"
import { routingPlanTraceAttributes } from "@/lib/routing/plan-trace-attributes"
import { drainSteerVia, handleEvent, tryAutoModeDecision } from "./claude-chat-events"
import {
  fusionChatTurnActive,
  routerFusionSendDiagnostic,
  runFusionChatTurn,
  stopFusionChatTurn,
} from "./router-fusion-chat-turn"

/**
 * Sessions whose live shared send already warned about embedded references.
 * Once per session is deliberate: every send carrying a `@chat:`/`@msg:`
 * snapshot publishes it to every member, but a toast per message is spam —
 * the first one is when the user can still change their mind cheaply.
 */
const sharedReferenceWarnedSessions = new Set<string>()

/** Plugins receive only the user-authored block following the attachment manifest. */
export function userPromptText(content: SendContent, attachmentCount = 0): string {
  if (typeof content === "string") return content
  const block = content.find((entry, index) => index >= attachmentCount && entry.type === "text")
  return block?.type === "text" ? block.text : ""
}

export function rewriteUserPromptText(
  content: SendContent,
  text: string,
  attachmentCount = 0
): SendContent {
  if (typeof content === "string") return text
  const index = content.findIndex(
    (entry, position) => position >= attachmentCount && entry.type === "text"
  )
  return content.map((block, position) =>
    position === index && block.type === "text" ? { ...block, text } : block
  )
}

/**
 * What an external agent (Codex, ACP, a paired host's agent) is sent for a turn.
 *
 * Both external executors take one prompt string, so that string is the only
 * way a turn's attachments reach the agent. This lane used to send the payload's
 * FIRST text block, which is the extracted document or OCR text whenever one is
 * attached (`buildSendContent` puts attachment blocks first), so the agent got
 * the file and never the question.
 *
 * - `request` is what the user typed: the first text block past the
 *   attachments, read at the offset `userPromptText` uses. Delegation rules
 *   match on it, not on a file's contents.
 * - `prompt` is what the agent reads: the text blocks in front of the request
 *   (the provider lines put ahead of the turn, then the attachments' text),
 *   then the request, in the order the builtin lane sends them. Non-text blocks
 *   (images, native video) cannot ride a string. Blocks after the request
 *   (fetched link context) were never part of this lane's prompt and still
 *   are not.
 * - `omitted` is what `prompt` leaves out, so the lane can say so instead of
 *   dropping it silently: the manifest indexes of attachment blocks that are
 *   not text, any other non-text block (no manifest names it), and the
 *   non-empty text blocks after the request.
 *
 * `leadingCount` is how many blocks the provider pipeline put in front of the
 * turn's own blocks (the reply line, the resource context); the attachments
 * start right after them. A plain-string payload is sent whole, as before.
 */
export function externalTurnPrompt(
  content: SendContent,
  attachmentCount = 0,
  leadingCount = 0
): { request: string; prompt: string; omitted: ExternalTurnOmissions } {
  const omitted: ExternalTurnOmissions = { attachments: [], unnamed: 0, trailingText: 0 }
  if (typeof content === "string") return { request: content, prompt: content, omitted }
  const request = userPromptText(content.slice(leadingCount), attachmentCount)
  const attachmentsEnd = leadingCount + attachmentCount
  const ahead = content
    .slice(0, attachmentsEnd)
    .flatMap((block) => (block.type === "text" && block.text.trim() ? [block.text] : []))
  const requestIndex = content.findIndex(
    (block, index) => index >= attachmentsEnd && block.type === "text"
  )
  content.forEach((block, index) => {
    if (block.type !== "text") {
      if (index >= leadingCount && index < attachmentsEnd) {
        omitted.attachments.push(index - leadingCount)
      } else {
        omitted.unnamed += 1
      }
    } else if (requestIndex >= 0 && index > requestIndex && block.text.trim()) {
      omitted.trailingText += 1
    }
  })
  return {
    request,
    prompt: [...ahead, ...(request.trim() ? [request] : [])].join("\n\n"),
    omitted,
  }
}

/** What an external agent's one-string prompt could not carry of a turn. */
export interface ExternalTurnOmissions {
  /** Manifest indexes of attachment blocks that are not text (an image, a native video). */
  attachments: number[]
  /** Non-text blocks outside the attachments, which no manifest names. */
  unnamed: number
  /** Non-empty text blocks after the typed request: fetched link context. */
  trailingText: number
}

export function resolveChatTurnAttemptIdentity(input: {
  sessionId: string
  runId: string
  messages: readonly UIMessage[]
  reuseLastUserTurn: boolean
  attempts: Map<string, number>
  mintTurnId?: () => string
}): { runId: string; turnId: string; attemptId: string } {
  const anchor = input.reuseLastUserTurn
    ? [...input.messages].reverse().find((message) => message.role === "user")
    : undefined
  const turnId = anchor?.id ?? (input.mintTurnId ?? (() => `user-${crypto.randomUUID()}`))()
  const attemptKey = `${input.sessionId}:${turnId}`
  const ordinal = (input.attempts.get(attemptKey) ?? 0) + 1
  input.attempts.set(attemptKey, ordinal)
  return { runId: input.runId, turnId, attemptId: `a${ordinal}` }
}

/**
 * Owns the direct-chat runtime. Only ClaudeChatRuntimeProvider mounts this
 * controller; surfaces consume the shared public useClaudeChat hook.
 */
export function useClaudeChat() {
  const store = useChatStore
  const tRouting = useTranslations("providers.routingView")
  const tInlineErr = useTranslations("chat.inlineError")
  const tDiagnostics = useTranslations("diagnostics")
  const tVideo = useTranslations("chat.composer.attachments.video")
  const tAttachments = useTranslations("chat.composer.attachments")
  const tCollab = useTranslations("chatCollaboration")
  /**
   * Name what a text-only recipient could not be handed of a turn: the
   * attached files whose images or native video were left out (any text
   * extracted from them was sent), and the fetched pages after the question.
   * An external agent takes one prompt string; a Squad takes one goal string.
   */
  const warnTextOnlyOmissions = useCallback(
    (
      recipient: "external" | "squad",
      omitted: ExternalTurnOmissions,
      manifest: readonly AttachmentManifestEntry[] | undefined
    ) => {
      const names = [
        ...new Set([
          ...omitted.attachments.map(
            (index) => manifest?.[index]?.filename || tAttachments("fallbackName")
          ),
          ...(omitted.unnamed > 0 ? [tAttachments("fallbackName")] : []),
        ]),
      ]
      const files = { count: names.length, names: names.join(", ") }
      const links = { count: omitted.trailingText }
      const lines = [
        ...(names.length > 0
          ? [
              recipient === "squad"
                ? tAttachments("squadOmitted.files", files)
                : tAttachments("externalOmitted.files", files),
            ]
          : []),
        ...(omitted.trailingText > 0
          ? [
              recipient === "squad"
                ? tAttachments("squadOmitted.links", links)
                : tAttachments("externalOmitted.links", links),
            ]
          : []),
      ]
      if (lines.length > 0) toast.warning(lines.join(" "))
    },
    [tAttachments]
  )
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
  // subagent-bridge docstring promised. It folds each run's tree onto the
  // spawning assistant turn, deduped by a cheap signature so progress ticks
  // don't rewrite the message array needlessly.
  //
  // Every OPEN session, not just the focused one. This used to read
  // `activeSessionId`, so a background pane that dispatched subagents never got
  // their tree folded in — and because the signature is only recomputed on a
  // runtime change, switching to that pane later did not fix it either: its
  // transcript was permanently missing the subagent trees for that turn.
  const subagentSigRef = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    const apply = () => {
      const runtime = useSubagentRuntimeStore.getState().subAgents
      const chat = useChatStore.getState()
      const ids = new Set([...chat.openSessionIds, ...Object.keys(chat.paneIdsBySession ?? {})])
      if (chat.activeSessionId) ids.add(chat.activeSessionId)
      for (const sid of ids) {
        const subs = selectSessionSubagents(runtime, sid)
        const sig = subagentSignature(subs)
        if (sig === subagentSigRef.current.get(sid)) continue
        subagentSigRef.current.set(sid, sig)
        if (subs.length === 0) continue
        // Re-read per session: an earlier iteration may already have written.
        const state = useChatStore.getState()
        const current =
          sid === state.activeSessionId ? state.messages : (state.sessions[sid]?.messages ?? [])
        const next = applySubagentsToMessages(current, subs)
        if (next !== current) state.replaceMessagesForSession(sid, next)
      }
    }
    apply()
    const unsubscribeRuntime = useSubagentRuntimeStore.subscribe(apply)
    const unsubscribePanes = useChatStore.subscribe((state, previous?: typeof state) => {
      if (
        previous &&
        state.paneIdsBySession === previous.paneIdsBySession &&
        state.openSessionIds === previous.openSessionIds &&
        state.activeSessionId === previous.activeSessionId
      )
        return
      // A newly revealed pane may have hydrated its messages after the last
      // subagent update. Re-project even when the runtime signature is unchanged.
      subagentSigRef.current.clear()
      apply()
    })
    return () => {
      unsubscribeRuntime()
      unsubscribePanes()
    }
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

  // Track the last user content per session so a regenerate resends exactly
  // what was sent: a natively sent video's file is not in the row. The
  // manifest travels with it (an attachment's text reads as the question
  // without it), and the row id says which turn it was, so a regenerate of
  // any other turn rebuilds from that turn's own row instead.
  const lastUserContentRef = useRef<
    Map<
      string,
      {
        messageId: string
        content: SendContent
        manifest: readonly AttachmentManifestEntry[] | undefined
      }
    >
  >(new Map())
  // Private resource context is kept outside the message log. It is reused for
  // regenerate/edit-resend, but is only attached after plugin prompt hooks.
  const lastResourceContextRef = useRef<Map<string, string>>(new Map())
  /** Retry/regenerate keeps turnId stable and advances only attemptId. */
  const skillAttemptByTurnRef = useRef<Map<string, number>>(new Map())
  /**
   * Pending branch tag set by `regenerate` and consumed by the first
   * assistant message that arrives afterward. Keyed by sessionId so a regen
   * fired from another session doesn't taint the active turn.
   */
  const pendingBranchTagRef = useRef<Map<string, { groupId: string; index: number }>>(new Map())
  /**
   * The replacement user message an edit-as-branch send just appended, keyed by
   * sessionId. `handleEvent` stamps it as `branchOwnerId` on every message the
   * turn writes, so flipping the navigator back to the original hides the new
   * turn's replies along with the variant they answer. Consumed at turn end.
   */
  const pendingBranchOwnerRef = useRef<Map<string, string>>(new Map())

  /**
   * Holds the latest `send` so the module-scope `handleEvent` can dispatch a
   * silent goal continuation (ADR-0019). `handleEvent` is defined outside the
   * hook (can't close over `send`), so we thread the live reference through a
   * ref kept fresh by the effect below.
   */
  const sendRef = useRef<SendFn | null>(null)
  const sharedApprovalResponseRef = useRef<
    ((approval: PendingApproval, decision: ApprovalDecision) => Promise<void>) | null
  >(null)

  /**
   * Live Squad-run settlement watchers, one per session.
   *
   * A Squad turn holds its session `streaming` until its run ends, so the
   * watcher that releases the hold has to outlive the `send` call that armed
   * it. Keyed by session so a second Squad turn replaces the first's watcher
   * rather than leaving a stale one to settle a hold it no longer represents.
   */
  const squadWatchersRef = useRef<Map<string, () => void>>(new Map())

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
  const externalGatewayAbortRef = useRef<Map<string, AbortController>>(new Map())
  const externalToolHostsRef = useRef(
    new Map<
      string,
      {
        host: ReturnType<
          typeof import("@/lib/ai/agent/external/session/renderer-tool-host").createRendererToolHost
        >
        agentId: string
        nativeSessionId?: string
        launchContextSignature?: string
      }
    >()
  )
  const releaseExternalToolHost = useCallback(async (sessionId: string) => {
    const entry = externalToolHostsRef.current.get(sessionId)
    if (!entry) return
    externalToolHostsRef.current.delete(sessionId)
    try {
      const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
      if (getExternalAgentManager().getAgent(entry.agentId))
        getExternalAgentManager().setSessionHostFacts(entry.agentId, sessionId, null)
      if (entry.nativeSessionId) {
        await getExternalAgentManager().closeSession(entry.agentId, entry.nativeSessionId)
      }
    } finally {
      await entry.host.close()
    }
  }, [])
  // Session-owned handles live beside the existing coalescing resources. The
  // resolver callback supplies the exact spec used for the outgoing send, so
  // this hook never resolves execution a second time.
  const executionHandlesRef = useRef<Map<string, AgentExecutionHandle>>(new Map())
  const executionHandleDirectory = useAgentExecutionHandleDirectory()
  const getExecutionHandle = useCallback(
    (sessionId: string) =>
      executionHandlesRef.current.get(sessionId) ?? executionHandleDirectory.get(sessionId),
    [executionHandleDirectory]
  )

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
          useChatStore.getState().syncToolTimestamps?.(sid, msgs)
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
    const executionHandles = executionHandlesRef.current
    const squadWatchers = squadWatchersRef.current
    const gatewayControllers = externalGatewayAbortRef.current
    const toolHosts = externalToolHostsRef.current
    return () => {
      for (const sessionId of toolHosts.keys()) {
        void releaseExternalToolHost(sessionId).catch((error) =>
          console.error("external tool host close failed", error)
        )
      }
      for (const controller of gatewayControllers.values()) controller.abort()
      gatewayControllers.clear()
      registry.flushAllPersist()
      registry.clear()
      executionHandles.clear()
      // Each watcher owns a Dexie subscription and an interval. The Squad run
      // itself is unaffected — it is fire-and-forget and reports through the
      // run surfaces; only this hook's hold on the session goes away with it.
      for (const stop of squadWatchers.values()) stop()
      squadWatchers.clear()
    }
  }, [registry, releaseExternalToolHost])

  /**
   * Turn-silence watchdog (see `lib/chat/silence-watchdog`).
   *
   * Armed once the send is dispatched, fed by every inbound frame, and disarmed
   * by the store watcher below when the session leaves an active status. It
   * raises a persistent `turnSilent` warning and nothing else — it never ends
   * the turn, because a long tool call is indistinguishable from a dropped one
   * at this layer.
   */
  const silenceWatchdogRef = useRef<SilenceWatchdog | null>(null)
  // Created on demand rather than in the render body, because the effect below
  // disposes and clears the ref on cleanup. StrictMode replays mount → cleanup
  // → mount with NO re-render in between, so a render-body lazy init left the
  // second mount reading `null`, returning early, and installing no
  // subscription — the watchdog was inert for the whole of development. Making
  // the effect the thing that guarantees an instance keeps the two in step:
  // whatever is subscribed is what `arm` / `notice` reach.
  const ensureSilenceWatchdog = useCallback((): SilenceWatchdog => {
    const existing = silenceWatchdogRef.current
    if (existing) return existing
    const created = createSilenceWatchdog({
      onSilent: (sessionId, silentForMs) => {
        const session = useChatStore.getState().sessions[sessionId]
        // Never overwrite a real failure with "we heard nothing": a diagnostic
        // already on the session is strictly more informative than this one.
        if (session?.errorDiagnostic) return
        // And never warn about a turn that is not running. The store watcher
        // disarms on every settle, but it can only disarm what is armed — so
        // this is the backstop for any path that settles a session the clock
        // has not been told about yet. A card offering "Interrupt" on an idle
        // conversation is worse than no card.
        if (session?.status !== "streaming" && session?.status !== "awaiting_approval") return
        useChatStore.getState().setSessionDiagnostic(
          sessionId,
          createDiagnostic("turnSilent", {
            source: "chat",
            meta: { sessionId, extra: { silentForMs } },
          })
        )
      },
      onRecovered: (sessionId) => {
        // Clear only our own warning. Anything else on the session came from a
        // producer that knows more than the clock does.
        const current = useChatStore.getState().sessions[sessionId]?.errorDiagnostic
        if (current?.code === "turnSilent") {
          useChatStore.getState().setSessionDiagnostic(sessionId, null)
        }
      },
    })
    silenceWatchdogRef.current = created
    return created
  }, [])

  useEffect(() => {
    const watchdog = ensureSilenceWatchdog()
    // Same shape as the execution-broker lease watcher: one subscription
    // covers every settle path (session_ended, error, interrupt, external-agent
    // completion) instead of a disarm call per exit.
    //
    // Scoped to the ARMED sessions, not to every open one. This store writes
    // once per streaming delta, so an `Object.entries(state.sessions)` sweep
    // here ran the full session list thousands of times a turn to answer a
    // question about (normally) one of them. `state.sessions` identity is the
    // cheap first cut — most writes are composer/projection fields that leave
    // it alone — and `watchdog.armed()` is the second.
    //
    // `previous` is optional on purpose. Zustand always passes it, but it is
    // only ever an OPTIMISATION here — the armed scan below is correct on its
    // own — so a caller that notifies with just the new state (a test double,
    // a wrapper store) must still get the disarm, not a TypeError inside a
    // subscription every other producer shares.
    const unsubscribe = useChatStore.subscribe((state, previous?: typeof state) => {
      if (previous && state.sessions === previous.sessions) return
      for (const sessionId of watchdog.armed()) {
        const session = state.sessions[sessionId]
        // A closed pane drops its slice entirely; that is a settle too, and the
        // old sweep could not see it because it only walked what still existed.
        if (
          !session ||
          (session.status !== "streaming" && session.status !== "awaiting_approval")
        ) {
          watchdog.disarm(sessionId)
        }
      }
    })
    return () => {
      unsubscribe()
      watchdog.dispose()
      if (silenceWatchdogRef.current === watchdog) silenceWatchdogRef.current = null
    }
  }, [ensureSilenceWatchdog])

  // Route one ClaudeEvent into the per-session serialized queue → `handleEvent`.
  // Keyed by session so same-session events serialize; events without a session
  // id (ready/log/sidecar_exited) share one chain. Shared by the Tauri transport
  // subscription AND the standalone (BYOK) engine, so both producers drive the
  // identical store/coalescing/persistence path.
  const enqueueClaudeEvent = useCallback(
    (evt: ClaudeEvent) => {
      // Snapshot ownership before queuing: the capture may settle and release
      // its turn before this session's queued transcript work drains.
      if (hasCaptureResponder(evt)) return Promise.resolve()
      const key =
        typeof (evt as { sessionId?: unknown }).sessionId === "string"
          ? (evt as { sessionId: string }).sessionId
          : "__nosession__"
      // Any frame naming a session is a sign of life for that turn. Fed here
      // rather than from a second subscription so there is one demux, not two.
      if (key !== "__nosession__") silenceWatchdogRef.current?.notice(key)
      const queues = eventQueuesRef.current
      const tail = (queues.get(key) ?? Promise.resolve())
        // A prior failure must not break the chain for later events.
        .catch(() => {})
        .then(() =>
          handleEvent(
            evt,
            activeRef,
            allowListRef,
            pendingBranchTagRef,
            pendingBranchOwnerRef,
            sendRef,
            {
              messagesMirrorRef,
              registry,
              getExecutionHandle,
            }
          )
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
    [registry, getExecutionHandle]
  )

  // Subscribe to sidecar events once. Desktop gets them via Tauri events;
  // Capacitor / web-companion renderers get the same `claude://message`
  // channel mirrored over the companion events WebSocket (event_bus.rs), which
  // is what carries the mobile workflow copilot's streamed turns. Plain web
  // (WebStubTransport) has no event source — skip the subscription.
  useEffect(() => {
    if (!isTauri() && !isCapacitor() && !hasWebCompanionTarget()) return
    let unlisten: UnlistenFn | null = null
    let unregisterWorkSubmissionEvents: UnlistenFn | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false

    const subscribe = () => {
      void onClaudeMessage((evt) => enqueueClaudeEvent(evt as ClaudeEvent))
        .then((u) => {
          if (cancelled) u()
          else {
            unlisten = u
            unregisterWorkSubmissionEvents = registerInteractiveWorkSubmissionEvents()
          }
        })
        .catch((err) => {
          console.error("listen claude events failed", err)
          if (!cancelled) retryTimer = setTimeout(subscribe, 1_000)
        })
    }
    subscribe()

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
      unlisten?.()
      unregisterWorkSubmissionEvents?.()
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
        sharedRequest?: { messageId: string; queueItemId: string; takeover?: boolean }
        skipUserAppend?: boolean
        /** Let approval continuations retain a retry action when dispatch is refused. */
        throwOnError?: boolean
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
        /** What this turn was written from, when a template with parameters
         *  produced it. Persisted on the user message row so the turn can be
         *  re-run with different values — the sent text has the values
         *  substituted in and no longer marks which words they were. */
        templateRun?: ChatTemplateRun | null
        /** Search sources resolved by the composer before this turn dispatches. */
        webSearchContext?: SendOptions["webSearchContext"]
        /** Explicit user choice after a failed interactive setup. Scheduled
         * runs never expose or honor this bypass. */
        bypassEnvironmentSetup?: boolean
        /** Stamp the optimistic USER message into a branch group.
         *
         *  Set by `editAndResend`, which keeps the original question as a
         *  sibling instead of deleting it. Passed explicitly rather than via a
         *  pending-tag ref (the shape `regenerate` uses) because the message
         *  being tagged is created right here — a ref would have to survive
         *  until an SDK event arrives, which is only necessary when the target
         *  is an assistant message that does not exist yet. */
        branchTag?: { groupId: string; index: number }
        /** Own this turn's replies by an edit's replacement row that is
         *  already in the transcript (set by the external-delegation fallback
         *  when it re-issues an `editAndResend`, alongside `skipUserAppend`).
         *
         *  Only the owner half of `branchTag`: the send that appended the row
         *  already stamped it into its group and selected it. Re-running
         *  `branchTag` here would stamp and select the fresh user message this
         *  send builds but never appends, and own the reply by that id — a row
         *  that does not exist, so the reply shows under every sibling. */
        branchOwnerId?: string
        /** Re-issue the thread's last user turn as a new branch (set by
         *  `regenerate`, alongside `skipUserAppend`).
         *
         *  The replies under `anchorId` become siblings in its branch group
         *  and the reply this turn produces is armed to take the next slot.
         *  Applied here, past every gate that can refuse the turn before it
         *  starts, rather than by `regenerate` up front: a tag armed for a turn
         *  that never runs is consumed by the NEXT turn's first reply. */
        regenerateBranch?: { anchorId: string }
        /**
         * The message this turn answers (ADR-0177 batch 2). Persisted as
         * `metadata.replyTo` on the user row, and read to the model as one
         * line ahead of the prompt, so the quoted text never becomes part of
         * what the user is recorded as having typed.
         */
        replyTo?: MessageReplyTo
        /**
         * What the context envelope in front of the typed text carries
         * (`lib/chat/prompt-preamble.ts`). Persisted as
         * `metadata.promptPreamble` so the bubble can name the references.
         */
        promptPreamble?: PromptPreambleSummary
        /**
         * The records this turn cites, assembled by the composer from the
         * chips it sent. Preferred over the store's `citedRefs`, which are
         * keyed by conversation and so empty for a first message staged in
         * the new-chat composer. Absent for sends that do not come from a
         * composer.
         */
        citations?: readonly ContextRef[]
        /** The executor chosen for THIS turn only (ADR-0117 axes).
         *
         *  Deliberately not persisted: a sticky override would quietly become
         *  a session-level switch, leaving nothing on screen to name what the
         *  conversation is actually bound to. The composer resets after send;
         *  the durable binding is `ChatSession.squadId`. */
        compositionOverride?:
          import("@cognia/agent-config-types/agent-composition").AgentCompositionSelectionV1 | null
        /**
         * The runtime this turn is addressed to by its leading `@claude` /
         * `@codex` / `@<Squad member>` (`lib/chat/turn-route/`).
         *
         * Re-resolved here against the stores at commit time: a lane that
         * cannot run refuses the turn before anything is written, and it NEVER
         * falls back to the conversation's own runtime. Persisted as
         * `metadata.turnRoute` on the user row so a regenerate re-runs the turn
         * where it was addressed. Nothing about the session changes.
         */
        turnRoute?: TurnRoute | null
      }
    ) => {
      const sessionId = callOptions?.sessionId ?? useChatStore.getState().activeSessionId
      // Branch bookkeeping this send arms for the turn it starts: a
      // regenerate's pending reply tag, and an edit's owner entry plus the
      // navigator pick that shows the edit. Every refusal goes through
      // `rejectSend`, which disarms whatever is still armed — `handleEvent`
      // only drops these on `session_ended`, which a turn that never ran does
      // not produce, so a leftover would stamp the NEXT turn's reply.
      let armedTag: { groupId: string; index: number } | null = null
      let armedOwner: string | null = null
      let armedPick: { groupId: string; messageId: string; previous: string | undefined } | null =
        null
      const disarmBranch = (): void => {
        if (!sessionId) return
        if (armedTag && pendingBranchTagRef.current.get(sessionId) === armedTag) {
          pendingBranchTagRef.current.delete(sessionId)
        }
        armedTag = null
        if (armedOwner && pendingBranchOwnerRef.current.get(sessionId) === armedOwner) {
          pendingBranchOwnerRef.current.delete(sessionId)
        }
        armedOwner = null
        const pick = armedPick
        armedPick = null
        if (!pick) return
        const slice = store.getState().sessions[sessionId]
        // A refusal that kept the edited row (it is marked failed, with its own
        // retry) keeps it selected. One that never appended it, or rolled it
        // back, returns the navigator to the variant it showed before.
        if (slice?.messages.some((message) => message.id === pick.messageId)) return
        const picks = slice?.activeBranchByGroup ?? {}
        if (picks[pick.groupId] !== pick.messageId) return
        const restored = { ...picks }
        if (pick.previous === undefined) delete restored[pick.groupId]
        else restored[pick.groupId] = pick.previous
        store.getState().hydrateSessionActiveBranches(sessionId, restored)
      }
      // The reply half of the same bookkeeping, for the lanes that write their
      // own assistant message instead of streaming it through `handleEvent`
      // (the external agent, a Squad handoff). Stamps `replyId` the way
      // `handleEvent` stamps a sidecar reply — a regenerate's armed slot, which
      // is also selected so the new answer is the one shown, and an edit's
      // owner — and consumes both, so neither outlives this turn. Only entries
      // this send armed and that are still pending: a later send's are its own.
      const claimReplyBranch = (replyId: string): Record<string, unknown> => {
        const stamp: Record<string, unknown> = {}
        if (!sessionId) return stamp
        if (armedTag && pendingBranchTagRef.current.get(sessionId) === armedTag) {
          pendingBranchTagRef.current.delete(sessionId)
          stamp.branchGroupId = armedTag.groupId
          stamp.branchIndex = armedTag.index
          store.getState().setSessionActiveBranch(sessionId, armedTag.groupId, replyId)
        }
        if (armedOwner && pendingBranchOwnerRef.current.get(sessionId) === armedOwner) {
          pendingBranchOwnerRef.current.delete(sessionId)
          stamp.branchOwnerId = armedOwner
        }
        return stamp
      }
      const rejectSend = (error?: unknown): void => {
        disarmBranch()
        if (!callOptions?.throwOnError) return
        const diagnostic = sessionId
          ? useChatStore.getState().sessions[sessionId]?.errorDiagnostic
          : null
        throw error instanceof Error
          ? error
          : new Error(
              typeof error === "string"
                ? error
                : diagnostic?.message || diagnostic?.code || "chat_turn_not_accepted"
            )
      }
      if (!sessionId) {
        useChatStore.getState().setError(tInlineErr("noSession"))
        rejectSend(tInlineErr("noSession"))
        return
      }
      if (
        (typeof content === "string" && !content.trim()) ||
        (Array.isArray(content) && content.length === 0)
      ) {
        rejectSend("empty_chat_turn")
        return
      }

      const persistAttachments = async (message: UIMessage): Promise<UIMessage | null> => {
        try {
          return await persistMessageSessionAssets(sessionId, message)
        } catch (error) {
          store
            .getState()
            .setSessionDiagnostic(
              sessionId,
              toDiagnostic(error, { source: "chat", meta: { sessionId } })
            )
          rejectSend(error)
          return null
        }
      }

      const sharedTarget = await getSession(sessionId)
      const turnRoute = callOptions?.turnRoute ?? null
      // An addressed turn that cannot run: refused with the reason, before
      // anything reaches the transcript.
      const refuseRoute = (route: TurnRoute, reason: string, detail?: string): void => {
        store.getState().setSessionDiagnostic(
          sessionId,
          createDiagnostic("turnRouteUnavailable", {
            source: "chat",
            ...(detail ? { message: detail } : {}),
            meta: { sessionId, extra: { handle: route.handle, reason } },
          })
        )
        rejectSend(`turn_route_unavailable:${reason}`)
      }
      // Only a direct chat has a lane of its own to leave for one turn. The
      // composer never offers a route anywhere else; a programmatic send that
      // carries one is refused rather than run unrouted.
      if (turnRoute && !isRoutableSession(sharedTarget)) {
        refuseRoute(turnRoute, "unroutable-session")
        return
      }
      // Route handles resolve to `agent` mentions over THIS conversation's
      // targets, the same list its `@` panel offered.
      const routeMentionTargets = routeTargetsFromStores(sharedTarget)
      // Only a NEW user turn is published to the shared transcript. The
      // internal re-entries (regenerate / routing fallback pass
      // `skipUserAppend`, the queue's replay passes `steerDrain`) already have
      // their user message on the server, so routing them here would append a
      // duplicate `message.created` and never run the turn they asked for.
      if (
        sharedTarget?.collaboration &&
        !callOptions?.sharedRequest &&
        !callOptions?.skipUserAppend &&
        !callOptions?.steerDrain
      ) {
        // A shared transcript publishes user parts to the server as they are,
        // so a native video would upload the file itself: always its sampled
        // payload here (the composer's gate says the same).
        const shared = enforceVideoDeliveryForRoute(content, callOptions?.attachmentManifest, {
          providerId: null,
          modelId: null,
          runtimeAdapter: null,
          protocol: null,
          supportsVideo: false,
          sharedCollaboration: true,
        })
        const sharedManifest = shared.manifest
        const message = makeUserMessage(shared.content, crypto.randomUUID(), sharedManifest)
        if (Array.isArray(shared.content)) {
          message.parts = shared.content.flatMap((block, index) =>
            block.type === "document"
              ? [
                  {
                    ...makeUserMessage(
                      [block],
                      undefined,
                      sharedManifest?.[index] ? [sharedManifest[index]] : undefined
                    ).parts[0],
                    ...(sharedManifest?.[index]
                      ? {
                          filename: sharedManifest[index].filename,
                          ...(sharedManifest[index].extractedContent
                            ? { extractedContent: sharedManifest[index].extractedContent }
                            : {}),
                          ...(sharedManifest[index].original
                            ? { attachmentOriginal: sharedManifest[index].original }
                            : {}),
                        }
                      : {}),
                    type: "file" as const,
                    mediaType: block.source.media_type,
                    url: `data:${block.source.media_type};base64,${block.source.data}`,
                  },
                ]
              : makeUserMessage(
                  [block],
                  undefined,
                  sharedManifest?.[index] ? [sharedManifest[index]] : undefined
                ).parts
          )
        }
        // A shared turn still cites what its chips/tokens named. The local row
        // is written by the sync projection of this very event, so the
        // citations must ride the event payload or no member — sender
        // included — ever gets a backlink.
        const sharedMentions = resolveTurnContextRefs(
          shared.content,
          chatMentionResolvers(routeMentionTargets),
          callOptions?.citations ?? selectComposerCitedRefs(store.getState(), sessionId)
        )
        const sharedMetadata = {
          ...(sharedMentions.length > 0 ? { mentions: sharedMentions } : {}),
          ...(callOptions?.promptPreamble ? { promptPreamble: callOptions.promptPreamble } : {}),
        }
        // A snapshot embedded in this message publishes the quoted
        // conversation's text to every member — including ones who could not
        // open the source. Warn once so the first send is an informed choice.
        if (
          !sharedReferenceWarnedSessions.has(sessionId) &&
          sharedMentions.some((ref) => ref.kind === "entity" && isTranscriptEntityRefId(ref.id))
        ) {
          sharedReferenceWarnedSessions.add(sessionId)
          toast.info(tCollab("shareReferencesLiveToast"))
        }
        const persistedMessage = await persistAttachments(message)
        if (!persistedMessage) return
        await sendSharedSessionMessage(sharedTarget, {
          id: persistedMessage.id,
          parts: persistedMessage.parts,
          ...(Object.keys(sharedMetadata).length > 0 ? { metadata: sharedMetadata } : {}),
        })
        return
      }

      // Concurrency cap backstop: never start a turn over the global execution
      // ceiling. The composer already disables send + shows the inline over-cap
      // notice; this guards programmatic sends too. A session that is already
      // streaming is a continuation and never blocked (the broker exempts it).
      // The cap now reflects the unified ExecutionBroker occupancy — headless
      // legs (scheduler / connector / workflow / team) included — not just the
      // renderer's streaming panels.
      if (getExecutionBroker().isAtCapacity("ai-turn", sessionId)) {
        console.warn("send blocked: concurrent stream cap reached", { sessionId })
        rejectSend("concurrent_stream_cap_reached")
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
        // A turn still waiting for its working tree has not started, but it is
        // this session's next turn all the same. A second send is a follow-up
        // to it, not a rival: sent through the normal path it would wait on the
        // same tree and then run with a transcript that predates the first
        // turn's reply.
        const turnQueued = isChatTurnQueued(sessionId)
        if (st === "streaming" || st === "awaiting_approval" || turnQueued) {
          if (turnRoute) {
            // A live follow-up can only reach the runtime already answering, and
            // queued follow-ups merge into one payload — neither can move a turn
            // to another runtime. Refused, not demoted to an unaddressed steer.
            // On the bus, not the session: the running turn keeps its status.
            dispatchDiagnostic(
              createDiagnostic("turnRouteWhileBusy", {
                source: "chat",
                meta: { sessionId, extra: { handle: turnRoute.handle } },
              })
            )
            rejectSend("turn_route_while_busy")
            return
          }
          const text = steerTextOf(content, callOptions?.attachmentManifest?.length ?? 0)
          const blocks = steerBlocksOf(content, callOptions?.attachmentManifest?.length ?? 0)
          if (!text && blocks.length === 0) return

          const optimistic = await persistAttachments(
            makeUserMessage(content, undefined, callOptions?.attachmentManifest)
          )
          if (!optimistic) return

          // A new instruction supersedes the context the pending approvals
          // were asked under (Codex 0.154 parity): deny each through its own
          // channel so the waiter resolves, then let the turn continue under
          // the new instruction. The judge cache is re-armed too — a "safe"
          // verdict reached under the old instruction must not auto-approve
          // the retried command under this one. Awaited so the denial lands
          // before the steer text the model reads next.
          invalidateJudgeContext(sessionId)
          try {
            await supersedePendingApprovals(sessionId, { getExecutionHandle })
          } catch (err) {
            console.warn("approval supersede failed", err)
          }

          // Show it immediately, in the user's own words. The model-facing
          // framing (`STEER_PREFIX`) is added only on the replay payload; the
          // transcript renders the original text via `stripSteerPrefix`. The
          // `steer` metadata rides along into Dexie so a restart can tell a
          // delivered follow-up from one that never arrived.
          const entryId = crypto.randomUUID()
          const steerMeta: SteerMessageMeta = { entryId, state: "queued" }
          // The normal send path's reference stamp, applied here too: a steer
          // still cites what its chips/tokens named, whether it is delivered
          // live, replayed from the queue, or never delivered at all.
          const steerMentions = resolveTurnContextRefs(
            content,
            chatMentionResolvers(routeMentionTargets),
            callOptions?.citations ?? selectComposerCitedRefs(store.getState(), sessionId)
          )
          ;(optimistic as { metadata?: Record<string, unknown> }).metadata = {
            ...((optimistic as { metadata?: Record<string, unknown> }).metadata ?? {}),
            steer: steerMeta,
            ...(steerMentions.length > 0 ? { mentions: steerMentions } : {}),
            ...(callOptions?.promptPreamble ? { promptPreamble: callOptions.promptPreamble } : {}),
          }

          const externalAgentId = sessionExternalLane(sessionId)
          // A cascade or panel run takes no steer (ADR-0188 D19): the
          // follow-up waits in the queue and becomes the next turn.
          const fusionTurn = fusionChatTurnActive(sessionId)
          if (
            !fusionTurn &&
            !turnQueued &&
            !externalAgentId &&
            text &&
            blocks.length === 0 &&
            !isStandaloneChatMode()
          ) {
            try {
              const queued = await enqueueHostStateIntentIfAvailable({
                sessionId,
                action: {
                  kind: "turn.steer",
                  text,
                  ...(steerMentions.length > 0 ? { mentions: steerMentions } : {}),
                  ...(callOptions?.promptPreamble
                    ? { promptPreamble: callOptions.promptPreamble }
                    : {}),
                },
              })
              if (queued) {
                appendSteerMessage(sessionId, optimistic)
                mergeSteerWebSearchIntoLastSend(sessionId, callOptions?.webSearchContext)
                setSteerMessageState(sessionId, entryId, "accepted")
                return
              }
            } catch (error) {
              store
                .getState()
                .setSessionDiagnostic(
                  sessionId,
                  toDiagnostic(error, { source: "chat", meta: { sessionId } })
                )
              return
            }
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
          if (fusionTurn || turnQueued) {
            // Queued below: a verified run has no live input, and a turn that
            // has not been admitted has no input open at all.
          } else if (externalAgentId) {
            // Adapter steering carries text only (`turn/steer` takes a string),
            // so an attachment-only follow-up has to queue on this lane.
            if (text) {
              try {
                const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
                const mgr = getExternalAgentManager()
                if (mgr.supportsSteering(externalAgentId)) {
                  await mgr.steerSession(externalAgentId, undefined, text)
                  mergeSteerWebSearchIntoLastSend(sessionId, callOptions?.webSearchContext)
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
              const handle = getExecutionHandle(sessionId)
              if (handle) await handle.steer(content)
              else {
                const { steerSession } = await import("@/lib/claude/ipc")
                await steerSession(sessionId, content)
              }
              mergeSteerWebSearchIntoLastSend(sessionId, callOptions?.webSearchContext)
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
            ...(callOptions?.attachmentManifest?.length
              ? {
                  attachmentManifest: callOptions.attachmentManifest.map(
                    ({ original: _original, ...entry }) => entry
                  ),
                }
              : {}),
            webSearchContext: callOptions?.webSearchContext,
            ...(callOptions?.replyTo ? { replyTo: callOptions.replyTo } : {}),
            // The queue copy rides a replay onto whichever writer persists the
            // row — locally redundant (the optimistic bubble has them) but the
            // only carrier when a remote drain rebuilds the turn.
            ...(steerMentions.length > 0 ? { citations: steerMentions } : {}),
            ...(callOptions?.promptPreamble ? { promptPreamble: callOptions.promptPreamble } : {}),
          })
          return
        }
      }

      let session = await getSession(sessionId)
      assertSessionWritable(session, "send-message")
      // The lane THIS turn runs on, decided once. An addressed turn resolves
      // its route against the stores as they are now — a Codex disabled since
      // the pick refuses here, not mid-dispatch; every other turn runs on the
      // session's own lane. Every "which runtime" question below reads
      // `turnLane`, never the store again.
      const sessionLane = runtimeRefForSession(sessionId)
      let routeSnapshot: RouteContextSnapshot | null = null
      let routeLane: Extract<RouteLane, { ok: true }> | null = null
      if (turnRoute) {
        routeSnapshot = await snapshotRouteContext(sessionId, { session: session ?? null })
        const lane = resolveRouteLane(turnRoute.target, routeSnapshot)
        if (!lane.ok) {
          refuseRoute(turnRoute, lane.reason, lane.detail)
          return
        }
        routeLane = lane
      }
      const turnLane: AgentRuntimeRef = routeLane?.runtimeRef ?? sessionLane
      // The session's model pick belongs to the session's own lane. A turn
      // addressed to a DIFFERENT lane must not carry it there — a builtin
      // conversation's Claude model is not a choice made for Codex.
      const laneOwnsSessionModel = !routeLane || isSameRuntimeRef(turnLane, sessionLane)
      // Claim imported history before summary generation or editor writes, so a
      // concurrent source watcher cannot replace the snapshot being continued.
      if (sessionId.startsWith("import:") && session?.importOwnership !== "native-bound") {
        await freezeImportedSession(sessionId)
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

      let builtinHandoffContext: string | undefined
      if (
        session &&
        turnLane.kind === "builtin" &&
        (session.importOwnership === "native-bound" ||
          (session.branchSeed?.kind === "transcript" &&
            (sessionId.startsWith("import:") ||
              session.handoffSource === "cli" ||
              session.handoffSource === "thread-handoff")))
      ) {
        const { buildHandoffContext, prepareHandoffContext } =
          await import("@/lib/chat/handoff-context")
        const history = await listMessages(sessionId)
        const imported = session.importCanonicalState
        const state = imported
          ? {
              tasks: imported.tasks,
              plans: imported.plans,
              goals: imported.goals,
              checkpoints: imported.checkpoints,
              history: imported.history,
              interAgentMessages: imported.interAgentMessages,
            }
          : undefined
        const projected = buildHandoffContext(history, { state })
        if (projected.losses.some((loss) => loss.kind === "budget")) {
          const { buildAgentBackedLlmClient } =
            await import("@/lib/ai/generation/agent-backed-client")
          builtinHandoffContext = (
            await prepareHandoffContext(history, {
              state,
              client: await buildAgentBackedLlmClient({
                session,
                appSettings: useSettingsStore.getState().settings,
                featureId: "handoff",
                label: "Summarize task handoff",
              }),
            })
          ).text
        } else builtinHandoffContext = projected.text
        const patch = {
          sdkSessionId: undefined,
          sdkSessionStorage: undefined,
          forkedFromSdkSessionId: undefined,
          externalAgentSession: undefined,
          importOwnership: "cognia-owned" as const,
          importFrozen: true,
          branchSeed: builtinHandoffContext
            ? { kind: "transcript" as const, content: builtinHandoffContext }
            : undefined,
        }
        await updateSession(sessionId, patch)
        session = { ...session, ...patch }
        const {
          verifiedNativeResume: _verified,
          verifiedNativeResumeAgentId: _agentId,
          ...composition
        } = compositionForSession(sessionId)
        useAgentRuntimeStore.getState().setSessionComposition(sessionId, composition)
        await releaseExternalToolHost(sessionId)
      }
      const identityMessages = store.getState().sessions[sessionId]?.messages ?? []
      const chatRunId = store.getState().sessions[sessionId]?.runId ?? 0
      const executionRunId = runIdForTurn(sessionId, chatRunId)
      const turnIdentity = resolveChatTurnAttemptIdentity({
        sessionId,
        runId: executionRunId,
        messages: identityMessages,
        reuseLastUserTurn: Boolean(callOptions?.skipUserAppend || callOptions?.steerDrain),
        attempts: skillAttemptByTurnRef.current,
      })
      const frozenTurnId = turnIdentity.turnId
      const frozenAttemptId = turnIdentity.attemptId

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
      // multimodal path (array of blocks) reads the block the user typed, past
      // the attachments: an extracted document or an image's OCR is a text
      // block too, and `buildSendContent` puts them first. A turn with nothing
      // typed leaves userMessage undefined and the runtime falls back to the
      // no-context path.
      // The composer's context envelope is stripped: recall, routing and skill
      // intent must key off what the user ASKED, not off a referenced document
      // or a page of web results the app put in front of it.
      const sentAttachmentCount = callOptions?.attachmentManifest?.length ?? 0
      const rawTypedText =
        typeof content === "string"
          ? content
          : content.some((block, index) => index >= sentAttachmentCount && block.type === "text")
            ? userPromptText(content, sentAttachmentCount)
            : undefined
      const typedText = rawTypedText === undefined ? undefined : stripPromptPreamble(rawTypedText)
      // An addressed turn's `@codex` is an instruction to Cognia, not part of
      // the question the recall and routing legs key off.
      const userMessageText =
        typedText !== undefined && turnRoute
          ? (stripLeadingRouteToken(typedText, turnRoute.handle) as string)
          : typedText
      // Attachment kinds for the routing classifier: an image block implies a
      // vision requirement; a document block discriminates audio/video by its
      // declared media type. Text blocks never contribute a kind.
      const routingAttachmentKinds = Array.isArray(content)
        ? content
            .map((block) => {
              if (block.type === "image") return "image" as const
              if (block.type === "document") {
                const mediaType = block.source?.media_type ?? ""
                if (mediaType.startsWith("audio/")) return "audio" as const
                if (mediaType.startsWith("video/")) return "video" as const
                return "document" as const
              }
              return undefined
            })
            .filter((kind): kind is "image" | "audio" | "video" | "document" => kind !== undefined)
        : undefined
      let sendOptions: SendOptions
      try {
        sendOptions =
          opts ??
          (await buildSendOptions(
            session,
            userMessageText,
            (spec) => {
              const existingHandle = getExecutionHandle(sessionId)
              if (existingHandle) {
                executionHandlesRef.current.set(sessionId, existingHandle)
                return
              }
              const handle = createAgentExecutionHandle(sessionId, spec)
              executionHandlesRef.current.set(sessionId, handle)
              executionHandleDirectory.register(handle)
            },
            {
              runId: executionRunId,
              turnId: frozenTurnId,
              attemptId: frozenAttemptId,
            },
            routingAttachmentKinds?.length
              ? { attachmentKinds: routingAttachmentKinds }
              : undefined,
            // This controller creates the Router + Fusion run before dispatch.
            // An addressed turn runs exactly where it was addressed, so it is
            // never turned into a cascade or panel run.
            turnRoute ? {} : { routerFusionSurface: "chat" },
            routeLane
              ? routeLane.member
                ? (() => {
                    // Answered AS the member: its persona, and its own model
                    // when it has one — for this turn only.
                    const character = routeCharacter(routeLane.member)
                    return {
                      runtimeRef: routeLane.runtimeRef,
                      character,
                      clearSessionModel: Boolean(character.model),
                    }
                  })()
                : { runtimeRef: routeLane.runtimeRef }
              : undefined
          ))
      } catch (err) {
        // RoutingNoCandidatesError (alias matched, every deployment down)
        // and any other resolver failure surface as the chat error instead
        // of an unhandled rejection.
        const error = err instanceof Error ? err : new Error(String(err))
        useChatStore
          .getState()
          .setSessionDiagnostic(
            sessionId,
            (await routerFusionSendDiagnostic(err, sessionId)) ??
              toDiagnostic(error, { source: "chat", meta: { sessionId } })
          )
        throw error
      }
      if (builtinHandoffContext !== undefined) {
        // Explicit send overrides must not smuggle the external runtime handle
        // into the builtin SDK. The resolver may already have injected the seed.
        sendOptions = { ...sendOptions }
        delete sendOptions.resumeSessionId
        delete sendOptions.forkFromSessionId
        if (
          builtinHandoffContext &&
          !sendOptions.appendSystemPrompt?.includes(builtinHandoffContext)
        ) {
          sendOptions.appendSystemPrompt = [sendOptions.appendSystemPrompt, builtinHandoffContext]
            .filter(Boolean)
            .join("\n\n")
        }
      }
      sendOptions = {
        ...sendOptions,
        turnId: frozenTurnId,
        ...(sendOptions.execution
          ? {
              execution: {
                ...sendOptions.execution,
                identity: {
                  ...(sendOptions.execution.identity ?? {}),
                  sessionId,
                  runId: executionRunId,
                  turnId: frozenTurnId,
                  attemptId: frozenAttemptId,
                },
              },
            }
          : {}),
      }

      // A deny-all tool surface keeps every external agent off the turn (the
      // external lane cannot run without its tools, so an unaddressed turn
      // quietly stays builtin). An addressed turn must not: it asked for that
      // runtime, and answering it elsewhere is exactly what routing refuses.
      if (turnRoute && turnLane.kind !== "builtin" && sendOptions.toolSurface === "none") {
        refuseRoute(turnRoute, "no-tool-surface")
        return
      }

      // Second half of the cap backstop above, run here because the provider is
      // only known once the send options resolve. The lane is a separate
      // admission dimension from the shared pool, so a pool with room says
      // nothing about it. Checked BEFORE the optimistic user append: without
      // this the send proceeds, posts the message, and then parks inside
      // `acquireChatLease` with no status flip, no explanation, and no cancel.
      if (
        getExecutionBroker().isAtCapacity("ai-turn", sessionId, sendOptions.provider) &&
        !getExecutionBroker().isAtCapacity("ai-turn", sessionId)
      ) {
        console.warn("send blocked: provider concurrency cap reached", {
          sessionId,
          provider: sendOptions.provider,
        })
        useChatStore
          .getState()
          .setSessionError(sessionId, tInlineErr("providerConcurrencyCapReached"))
        rejectSend(tInlineErr("providerConcurrencyCapReached"))
        return
      }

      if (callOptions?.webSearchContext) {
        sendOptions = { ...sendOptions, webSearchContext: callOptions.webSearchContext }
      }

      // ephemeralSkillIds were consumed by buildSendOptions; clear them so
      // the next turn starts with a fresh attachment set. Keyed by THIS
      // conversation — the bare projection is the focused pane, so a send from
      // a background pane read and cleared the other pane's attachments.
      if (selectComposerEphemeralSkillIds(useChatStore.getState(), sessionId).length > 0) {
        useChatStore.getState().clearEphemeralSkillIds?.(sessionId)
      }

      // Apply per-command frontmatter overrides set by the composer when the
      // user picked a custom slash command. Cleared after merge so the next
      // turn doesn't inherit them. Same per-conversation keying as above.
      const pending = selectComposerPendingCommandOverrides(useChatStore.getState(), sessionId)
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
        useChatStore.getState().setPendingCommandOverrides(null, sessionId)
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
      // Native video, decided for real. The composer chose native from its
      // guess at the route; `sendOptions` is the route that will run. A native
      // payload that route cannot take is swapped for the sampled payload its
      // manifest carries before anything reads the content.
      const videoGuard = enforceVideoDeliveryForRoute(
        content,
        callOptions?.attachmentManifest,
        videoRouteFacts({
          providerId: sendOptions.provider,
          modelId: sendOptions.model,
          runtimeAdapter: sendOptions.execution?.runtimeAdapter,
          providerSettings: useSettingsStore.getState().settings?.providerSettings,
          customProviders: useSettingsStore.getState().settings?.customProviders,
          teamRoom: session?.kind === "team",
          sharedCollaboration: Boolean(session?.collaboration),
          standalone: isStandaloneChatMode(),
        })
      )
      const turnContent = videoGuard.content
      const turnManifest = videoGuard.manifest
      for (const downgrade of videoGuard.downgraded) {
        toast.info(
          tVideo("nativeDowngraded", {
            filename: downgrade.filename,
            reason: tVideo(`nativeReason.${downgrade.reason}` as never),
          })
        )
      }
      if (videoGuard.dropped > 0) {
        toast.warning(tVideo("nativeDropped", { count: videoGuard.dropped }))
      }

      let effectiveContent: SendContent = turnContent
      const promptText = userPromptText(turnContent, turnManifest?.length ?? 0)
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
        rejectSend(promptDecision.reason || "prompt_blocked_by_plugin")
        return
      }
      if (promptDecision.action === "modify") {
        if (typeof promptDecision.modifiedPrompt === "string") {
          effectiveContent = rewriteUserPromptText(
            turnContent,
            promptDecision.modifiedPrompt,
            turnManifest?.length ?? 0
          )
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
        const outboundText = userPromptText(effectiveContent, turnManifest?.length ?? 0)
        const piped = await dispatchPluginMessageSend({
          id: `${sessionId}:outbound`,
          role: "user",
          content: outboundText,
        })
        if (typeof piped?.content === "string" && piped.content !== outboundText) {
          effectiveContent = rewriteUserPromptText(
            effectiveContent,
            piped.content,
            turnManifest?.length ?? 0
          )
        }
      }

      // New turn: drop any coalesced/debounced streaming work and the mirror
      // from a prior turn (this session only) so its events read the fresh
      // optimistic base. Other sessions' coalescing is untouched.
      registry.release(sessionId)
      messagesMirrorRef.current.delete(sessionId)

      // Regenerate re-parents the replies it replaces here, past every gate
      // above that can refuse the turn (the concurrency caps, an unroutable
      // lane, the plugin prompt guard), so a refused regenerate leaves the
      // thread exactly as it was. Every sibling after the anchor joins one
      // group (direct chat is one reply per turn) and stays reachable through
      // the BranchNavigator; the reply this turn produces takes the next slot.
      if (callOptions?.regenerateBranch) {
        const current = store.getState().sessions[sessionId]?.messages ?? []
        let anchorIdx = -1
        for (let i = current.length - 1; i >= 0; i--) {
          if (current[i].role === "user") {
            anchorIdx = i
            break
          }
        }
        // The thread moved on while the gates ran (another surface added a
        // turn, or the anchor was deleted). Tagging now would drop whatever
        // follows the anchor, and the re-issued content answers a question
        // that is no longer the last one.
        if (current[anchorIdx]?.id !== callOptions.regenerateBranch.anchorId) {
          rejectSend("regenerate_anchor_moved")
          return
        }
        const groupId = current[anchorIdx].id
        const { merged: tagged, nextIndexByGroup } = tagBranchSiblings(
          current,
          anchorIdx,
          () => groupId
        )
        // Re-running the turn is the retry of whatever the row recorded — a
        // failure, or a wait the app was closed during — so the mark goes. A
        // new failure writes its own.
        const merged = markTurnAdmission(tagged, groupId, null)
        store.getState().replaceSessionMessages(sessionId, merged)
        await persistMessages(sessionId, merged)
        // `handleEvent` stamps the first assistant message that arrives with
        // this tag, and selects it.
        armedTag = { groupId, index: nextIndexByGroup.get(groupId) ?? 0 }
        pendingBranchTagRef.current.set(sessionId, armedTag)
      } else {
        // Any other turn never answers into a regenerate's group, whatever
        // path left a tag behind.
        pendingBranchTagRef.current.delete(sessionId)
      }

      // Optimistic user-message append. Skipped during regenerate so the
      // existing user anchor stays the single source of truth for that turn.
      // Base off this session's own slice — never the focused projection.
      const previousMessages = store.getState().sessions[sessionId]?.messages ?? []
      let userMsg = makeUserMessage(effectiveContent, frozenTurnId, turnManifest)
      // Structured mention capture: persist the message's inline `@…` tokens
      // as `metadata.mentions: ContextRef[]` so mentions are queryable without
      // regex re-parsing. Known subagent handles resolve to their kind; other
      // tokens fall back to `file` (the CLI's native reading of `@path`).
      // Markdown-agent handles need async discovery and resolve as `file`
      // here — a documented v1 narrowing, not a routing change (routing still
      // uses the full union in resolveTargetAgentId below).
      // Parsed from the TYPED text only. An `@path` inside a referenced message
      // or a fetched page is quoted material, not a mention this turn made —
      // `resolveTurnContextRefs` strips the envelope before scanning.
      // Chip-style picks (a staged remote document, a staged memory / issue /
      // plan / conversation / artifact) leave NO token behind, so re-parsing the
      // text can never recover them — `callOptions.citations` is their only
      // route in. Read before the composer clears it, which it does after
      // `onSend` resolves.
      const citedRefs =
        callOptions?.citations ?? selectComposerCitedRefs(store.getState(), sessionId)
      const mentionRefs = resolveTurnContextRefs(
        effectiveContent,
        chatMentionResolvers(routeSnapshot?.targets ?? routeMentionTargets),
        citedRefs
      )
      if (mentionRefs.length > 0) {
        ;(userMsg as { metadata?: Record<string, unknown> }).metadata = {
          ...((userMsg as { metadata?: Record<string, unknown> }).metadata ?? {}),
          mentions: mentionRefs,
        }
      }
      if (callOptions?.promptPreamble) {
        ;(userMsg as { metadata?: Record<string, unknown> }).metadata = {
          ...((userMsg as { metadata?: Record<string, unknown> }).metadata ?? {}),
          promptPreamble: callOptions.promptPreamble,
        }
      }
      if (callOptions?.templateRun) {
        ;(userMsg as { metadata?: Record<string, unknown> }).metadata = {
          ...((userMsg as { metadata?: Record<string, unknown> }).metadata ?? {}),
          templateRun: callOptions.templateRun,
        }
      }
      if (turnRoute) {
        ;(userMsg as { metadata?: Record<string, unknown> }).metadata = {
          ...((userMsg as { metadata?: Record<string, unknown> }).metadata ?? {}),
          turnRoute,
        }
      }
      if (callOptions?.replyTo) {
        ;(userMsg as { metadata?: Record<string, unknown> }).metadata = {
          ...((userMsg as { metadata?: Record<string, unknown> }).metadata ?? {}),
          replyTo: callOptions.replyTo,
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
        armedPick = {
          groupId: callOptions.branchTag.groupId,
          messageId: userMsg.id,
          previous:
            store.getState().sessions[sessionId]?.activeBranchByGroup[
              callOptions.branchTag.groupId
            ],
        }
        store
          .getState()
          .setSessionActiveBranch(sessionId, callOptions.branchTag.groupId, userMsg.id)
        // Everything this turn appends belongs to the replacement variant —
        // stamp it as the owner so the other sibling keeps its own tail.
        armedOwner = userMsg.id
        pendingBranchOwnerRef.current.set(sessionId, userMsg.id)
      } else if (callOptions?.branchOwnerId) {
        // A re-issued edit: the replacement row, its stamp and its pick are
        // already in place; only its replies still need the owner.
        armedOwner = callOptions.branchOwnerId
        pendingBranchOwnerRef.current.set(sessionId, callOptions.branchOwnerId)
      } else {
        // A normal send must never inherit the previous turn's owner.
        pendingBranchOwnerRef.current.delete(sessionId)
      }
      // Both flags mean "the user turn is already in the transcript": a
      // regenerate re-issues an existing one, a steer drain replays entries that
      // were appended optimistically when typed. Appending again would double
      // them. They diverge only on the *other* effects of a user turn — see
      // `steerDrain`'s doc on the option type.
      const skipAppend = callOptions?.skipUserAppend === true || callOptions?.steerDrain === true
      const persistedUserMessage = await persistAttachments(userMsg)
      if (!persistedUserMessage) return
      userMsg = persistedUserMessage
      const next = skipAppend ? previousMessages : [...previousMessages, userMsg]
      const displayContent = effectiveContent
      // The addressed runtime reads the question without the `@handle` that
      // addressed it; the transcript row above keeps what the user typed.
      // Past the attachments: an extracted document is a text block too, and
      // the handle is only ever in what the user typed.
      const routedContent = turnRoute
        ? stripLeadingRouteToken(displayContent, turnRoute.handle, turnManifest?.length ?? 0)
        : displayContent
      // Mixed-runtime history (`lib/chat/turn-route/history.ts`): the builtin
      // lane resumes its own SDK session, which never saw what another runtime
      // answered since its last reply. That part of the thread rides this turn,
      // in its content, so the SDK session keeps it on every later resume.
      // Not for a re-issued turn (its history is the one it already had), and
      // not for the standalone engine, which reads the whole transcript anyway.
      let foreignTurnsContext = ""
      if (
        turnLane.kind === "builtin" &&
        builtinHandoffContext === undefined &&
        !callOptions?.skipUserAppend &&
        !callOptions?.sharedRequest &&
        !isStandaloneChatMode()
      ) {
        const unseen = unseenForeignTurns(
          selectVisibleMessages(
            previousMessages,
            store.getState().sessions[sessionId]?.activeBranchByGroup ?? {}
          ),
          "builtin"
        )
        if (unseen.length > 0) {
          try {
            foreignTurnsContext = await foreignTurnsHandoffText(unseen, {
              client: async () => {
                const { buildAgentBackedLlmClient } =
                  await import("@/lib/ai/generation/agent-backed-client")
                return buildAgentBackedLlmClient({
                  session,
                  appSettings: useSettingsStore.getState().settings,
                  featureId: "handoff",
                  label: "Summarize task handoff",
                })
              },
            })
          } catch (error) {
            // The handoff could not be made — a PII refusal above all — and the
            // turn fails with the reason, as a lane switch's handoff fails it.
            // The user row has not been added to the transcript yet.
            store
              .getState()
              .setSessionDiagnostic(
                sessionId,
                toDiagnostic(error, { source: "chat", meta: { sessionId } })
              )
            rejectSend(error)
            return
          }
        }
      }
      // The reply line goes to the provider only. The transcript row above
      // keeps the typed text and carries the reference in its metadata.
      const providerContent = prefixForeignTurnsContext(
        callOptions?.replyTo
          ? prefixReplyContext(routedContent, callOptions.replyTo)
          : routedContent,
        foreignTurnsContext,
        // A reply line leads the turn ahead of any files; the handoff joins it.
        callOptions?.replyTo ? 0 : (turnManifest?.length ?? 0)
      )
      const shouldGateWorkbenchPayload =
        callOptions?.resourceContext !== undefined || isEmbeddedSession(session ?? {})
      // The transcript a provider reads whole (the standalone engine) gets every
      // reply line rebuilt from `metadata.replyTo`; `providerContent` above only
      // reaches a provider that reads the content of the turn being sent.
      const providerMessages = withReplyContextLines(next)
      const providerPayload = shouldGateWorkbenchPayload
        ? gateWorkbenchProviderPayload(
            { content: providerContent, sendOptions, messages: providerMessages },
            callOptions?.resourceContext
          )
        : { content: providerContent, sendOptions, messages: providerMessages }
      if (callOptions?.sharedRequest) {
        providerPayload.messages = [makeUserMessage(turnContent)]
        providerPayload.content = turnContent
        providerPayload.sendOptions = {
          ...providerPayload.sendOptions,
          resumeSessionId: undefined,
          forkFromSessionId: undefined,
          initialConversation: undefined,
        }
      }
      effectiveContent = providerPayload.content
      sendOptions = providerPayload.sendOptions
      // The turn as one string, read past the attachments rather than off the
      // first text block (see `externalTurnPrompt`), which is the extracted
      // document or OCR text whenever a file is attached. Every reader below
      // that takes a string picks one of the two: `request` where it wants
      // what the user asked (a label, a preview, the verifier's brief),
      // `prompt` where it is the only way the turn reaches whoever works on it
      // (the external lane, a Squad). A plain-string turn is both, whole.
      // Every provider step above only PREPENDS blocks to the turn's own (the
      // reply line, the resource context) or folds text into one, so the
      // difference in length is what sits in front of the attachments.
      const providerSourceContent = callOptions?.sharedRequest ? turnContent : routedContent
      const externalTurn = externalTurnPrompt(
        effectiveContent,
        turnManifest?.length ?? 0,
        Array.isArray(effectiveContent) && Array.isArray(providerSourceContent)
          ? effectiveContent.length - providerSourceContent.length
          : 0
      )
      const hostStateEligible =
        !sendOptions.routerFusionRun &&
        !skipAppend &&
        typeof effectiveContent === "string" &&
        callOptions?.resourceContext === undefined &&
        (turnManifest?.length ?? 0) === 0 &&
        turnLane.kind === "builtin" &&
        // The host runs a queued intent on the SESSION's lane with the
        // session's own character, and writes the intent's `text` as the user
        // row. An addressed turn would lose its `@handle` and its
        // `metadata.turnRoute` there (so a later regenerate would no longer
        // know where it was addressed), and a handed-over stretch of another
        // runtime's replies would be recorded as if the user had typed it.
        // Both take the direct path, which keeps the typed row.
        !turnRoute &&
        !foreignTurnsContext &&
        !session?.collaboration &&
        !isStandaloneChatMode()
      if (hostStateEligible) {
        try {
          const queued = await enqueueHostStateIntentIfAvailable({
            sessionId,
            action: {
              kind: "message.enqueue",
              messageId: userMsg.id,
              // Only a plain-string turn is eligible: this is the whole of it.
              text: externalTurn.request,
              attachments: [],
              ...(mentionRefs.length > 0 ? { mentions: mentionRefs } : {}),
              ...(callOptions?.promptPreamble
                ? { promptPreamble: callOptions.promptPreamble }
                : {}),
            },
          })
          if (queued) {
            // The outbox transaction completed before this optimistic write.
            // Runtime dispatch, transcript persistence and authoritative title
            // updates now belong to HostStateService on every attached surface.
            store.getState().replaceSessionMessages(sessionId, next)
            store.getState().setSessionError(sessionId, null)
            store.getState().setSessionStatus(sessionId, "streaming")
            lastUserContentRef.current.set(sessionId, {
              messageId: userMsg.id,
              content: displayContent,
              manifest: turnManifest,
            })
            emitSystemBusEvent(SystemEvents.MESSAGE_SENT, { sessionId })
            emitSystemBusEvent(SystemEvents.AGENT_STARTED, { sessionId })
            behaviorTurnStartedAt.set(sessionId, Date.now())
            void trackEvent("chat.message.sent", {
              sessionId,
              provider: sendOptions.provider ?? "host-state",
              surface: "chat",
            })
            return
          }
        } catch (error) {
          store
            .getState()
            .setSessionDiagnostic(
              sessionId,
              toDiagnostic(error, { source: "chat", meta: { sessionId } })
            )
          rejectSend(error)
          return
        }
      }
      if (!skipAppend) {
        store.getState().replaceSessionMessages(sessionId, next)
      }
      // Register this chat turn with the global execution broker so it counts
      // toward — and is observable / cancellable via — the same governor as
      // every headless leg. Acquired before the `streaming` flip so the broker
      // watcher releases it on settle. Gated by BOTH `isAtCapacity` checks above
      // (shared pool, then the provider lane once the provider resolved), so it
      // admits immediately. Best-effort: a broker hiccup never blocks the turn
      // the user already committed to.
      // Resolved before the lease so the slot names the directory this turn
      // actually writes into. Best-effort: an unresolvable cwd means no slot,
      // which is what it was before any of this existed.
      const turnCwd = await resolveEffectiveCwdForSession(session).catch(() => null)
      // The user message this turn belongs to — appended above, or already in
      // the transcript for a re-issued turn.
      const turnMessage = skipAppend ? turnMessageId(previousMessages) : userMsg.id
      let queuedTurnWrite: Promise<void> | null = null
      try {
        await acquireChatLease({
          sessionId,
          projectId: session?.projectId,
          label: session?.title || `#${sessionId.slice(0, 8)}`,
          // The working tree this turn will mutate. Two turns naming the same
          // tree are serialized; turns in different worktrees stay parallel.
          // The cap alone let two conversations bound to one checkout
          // interleave edits, builds and git operations in it.
          //
          // Keyed off the EFFECTIVE cwd — the same chain the send resolves —
          // not the execution binding alone. The binding is only the middle
          // link: two plain conversations in one workspace have no binding and
          // would have been left unserialized in the very directory they share.
          slotKey: slotKeyForTurn({
            executionContext: session?.executionContext,
            effectiveCwd: turnCwd,
          }),
          providerId: sendOptions.provider,
          providerLimit: sendOptions.providerConcurrencyLimit,
          // The broker is about to park this turn behind whatever holds its
          // working tree. Say so on the message itself, and write it through
          // now: a session switch or reload rehydrates from Dexie, and a
          // store-only message is exactly what vanished for minutes before.
          onQueued: (blocker) => {
            const queuedMeta: TurnAdmissionMeta = {
              state: "queued",
              waitingFor: waitFromBlocker(blocker),
              since: Date.now(),
            }
            const current = store.getState().sessions[sessionId]?.messages ?? next
            const marked = markTurnAdmission(current, turnMessage, queuedMeta)
            store.getState().replaceSessionMessages(sessionId, marked)
            queuedTurnWrite = persistMessages(sessionId, marked).catch((error: unknown) =>
              console.warn("queued turn persist failed", error)
            )
          },
        })
      } catch (leaseErr) {
        if (isQueuedChatTurnCancellation(leaseErr)) {
          // The user withdrew the message while it waited: the turn never ran,
          // so the message leaves the transcript (a re-issued turn keeps its
          // message and loses only the queued mark).
          await queuedTurnWrite
          const current = store.getState().sessions[sessionId]?.messages ?? next
          const withdrawn = skipAppend
            ? markTurnAdmission(current, turnMessage, null)
            : current.filter((message) => message.id !== userMsg.id)
          store.getState().replaceSessionMessages(sessionId, withdrawn)
          await persistMessages(sessionId, withdrawn).catch((error: unknown) =>
            console.warn("withdrawn turn persist failed", error)
          )
          // Follow-ups typed while it waited were queued behind it; with it
          // gone they are the next turn.
          drainSteerVia(sessionId, sendRef)
          rejectSend("chat_turn_withdrawn")
          return
        }
        console.warn("chat lease acquire failed; sending without admission", leaseErr)
      }
      if (queuedTurnWrite) {
        // Admitted. Settle the queued write first so it cannot land after the
        // turn's own transcript writes, then drop the mark from the row.
        await queuedTurnWrite
        const current = store.getState().sessions[sessionId]?.messages ?? next
        store
          .getState()
          .replaceSessionMessages(sessionId, markTurnAdmission(current, turnMessage, null))
      }
      // Clearing an error also sets idle. Do it before entering the active
      // state so workspace/broker settle subscribers see the actual turn end.
      store.getState().setSessionError(sessionId, null)
      store.getState().setSessionStatus(sessionId, "streaming")
      if (session?.attachedChild) {
        void markAttachedSessionRunning(sessionId).catch((error) =>
          console.warn("attached session start state failed", error)
        )
      }
      chatTurnPerformance.begin(sessionId)
      lastUserContentRef.current.set(sessionId, {
        messageId: userMsg.id,
        content: displayContent,
        manifest: turnManifest,
      })
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
          provider: sendOptions.provider ?? (turnLane.kind === "builtin" ? "unknown" : "external"),
          surface: "chat",
        })
      }

      // ── Squad dispatch (ADR-0117 orchestration axis) ──
      // A conversation bound to a Squad hands the whole turn to the team
      // runtime instead of running one model turn here. Deliberately the same
      // primitive `action.team.run` and the IM lane use, so a Squad turn gets
      // the entire pipeline — skills, memory, twin, MCP, hooks, permission
      // ceiling, tool approval — rather than a second, thinner executor.
      //
      // It branches HERE, above the direct-chat bookkeeping, because that
      // bookkeeping (`startDirectChatExecutionRun`, the work-submission lease,
      // the assembly heartbeat) describes a single model turn. A Squad run has
      // its own execution run and would otherwise have to unwind machinery it
      // never wanted.
      //
      // The session stays `streaming` until the run settles — the same posture
      // `use-team-chat` takes for a multi-member turn. That is what makes a
      // follow-up typed mid-run queue as steering instead of starting a second
      // Squad over the top of the first.
      //
      // An addressed turn is one direct turn by definition, so it opts out of
      // the Squad binding (`resolveTurnSquad`: any non-team orchestration on
      // the turn override beats the session's Squad).
      const turnComposition = turnRoute
        ? {
            ...(callOptions?.compositionOverride ?? compositionForSession(sessionId)),
            orchestration: "direct" as const,
          }
        : (callOptions?.compositionOverride ?? null)
      const squadDecision = resolveTurnSquad({
        turnOverride: turnComposition,
        session,
      })
      if (squadDecision.squadId) {
        const squadId = squadDecision.squadId
        try {
          const [{ startSquadRun }, { agentTeamExecutionRunId }] = await Promise.all([
            import("@/lib/ai/agent/team/squad/start-squad-run"),
            import("@/lib/execution/agent-team-bridge"),
          ])
          const result = await startSquadRun({
            squadId,
            // The goal is all the Squad is handed, so the whole turn: the
            // attached files' text, then the question.
            goal: externalTurn.prompt,
            origin: "chat",
            triggeredFrom: { source: "chat", sessionId },
            ...(session ? { session } : {}),
            ...(session?.characterId ? { characterId: session.characterId } : {}),
          })
          if (!result.started || !result.runId) {
            store.getState().setSessionStatus(sessionId, "idle")
            store.getState().setSessionDiagnostic(
              sessionId,
              createDiagnostic(
                result.reason === "squad_not_found"
                  ? "squadNotFound"
                  : result.reason === "not_ready"
                    ? "squadNotReady"
                    : result.reason === "already_running"
                      ? "squadAlreadyRunning"
                      : "squadDispatchFailed",
                {
                  source: "chat",
                  meta: {
                    sessionId,
                    extra: {
                      squadId,
                      ...(result.blockers
                        ? { blockers: result.blockers.map((blocker) => blocker.code).join(",") }
                        : {}),
                      ...(result.reason === "already_running" && result.runId
                        ? { runId: result.runId }
                        : {}),
                    },
                  },
                }
              )
            )
            chatTurnPerformance.finish(sessionId, "failed")
            rejectSend(result.reason || "squad_dispatch_failed")
            return
          }
          // The goal is one string: images, a native video and fetched pages
          // did not reach the Squad. Said once the run takes it, and not for a
          // run that already existed, whose goal this turn did not set.
          if (!result.duplicate) {
            warnTextOnlyOmissions("squad", externalTurn.omitted, turnManifest)
          }
          // Leave the conversation's own record of the handoff, now rather
          // than when the run finishes. A Squad run takes minutes, and a
          // conversation that shows nothing for that long reads as broken.
          // The part carries identity only; everything else is live-queried
          // from the run, so this stays true after a reload instead of
          // freezing at whatever was known at dispatch.
          const squadMessageId = crypto.randomUUID()
          // The card is this turn's reply: a regenerate files it as the next
          // sibling, an edit as its variant's (`claimReplyBranch`).
          const squadBranch = claimReplyBranch(squadMessageId)
          const squadMessage: UIMessage = {
            id: squadMessageId,
            role: "assistant",
            parts: [
              {
                type: "squad-run",
                runId: agentTeamExecutionRunId(result.runId),
                squadId,
                squadName: result.squadName ?? squadId,
                // What the card names is what the user asked, not a file.
                objective: externalTurn.request,
              },
            ] as unknown as UIMessage["parts"],
            ...(Object.keys(squadBranch).length > 0 ? { metadata: squadBranch } : {}),
          }
          // Committed directly rather than through the per-session coalescer:
          // that exists to batch streaming deltas, and there is exactly one
          // message here. Routing it through the rAF debounce would only
          // delay the one thing the user is waiting to see.
          const withSquadMessage = [...next, squadMessage]
          store.getState().replaceSessionMessages(sessionId, withSquadMessage)
          await persistMessages(sessionId, withSquadMessage).catch(() => undefined)

          // Release the hold when the run ends, however it ends. Without this
          // the conversation would queue follow-ups forever.
          const { watchSquadRunSettlement } =
            await import("@/lib/ai/agent/team/squad/watch-squad-run")
          const stopWatching = watchSquadRunSettlement({
            executionRunId: agentTeamExecutionRunId(result.runId),
            onSettled: (status) => {
              squadWatchersRef.current.delete(sessionId)
              store.getState().setSessionStatus(sessionId, "idle")
              chatTurnPerformance.finish(sessionId, status === "completed" ? "completed" : "failed")
            },
          })
          // One watcher per session: a previous Squad turn's watcher would
          // otherwise settle this one's hold when the old run finally lands.
          squadWatchersRef.current.get(sessionId)?.()
          squadWatchersRef.current.set(sessionId, stopWatching)
        } catch (error) {
          store.getState().setSessionStatus(sessionId, "idle")
          store.getState().setSessionDiagnostic(
            sessionId,
            toDiagnostic(error, {
              source: "chat",
              meta: { sessionId, extra: { squadId } },
            })
          )
          chatTurnPerformance.finish(sessionId, "failed")
          rejectSend(error)
        }
        return
      }

      // ── Router + Fusion cascade / panel (ADR-0188 B3) ──
      // The send pipeline stamped this turn as a verified run: the run, not a
      // sidecar stream, answers it. Like a Squad turn it branches above the
      // direct-chat bookkeeping, which describes a single model turn; the run
      // has its own ledger, budget and projection. Only a stamped send gets
      // here, and only while Router + Fusion chat is on.
      const fusionRun = sendOptions.routerFusionRun
      if (fusionRun) {
        void runFusionChatTurn({
          sessionId,
          stamp: fusionRun,
          messages: providerPayload.messages,
          userMessage: skipAppend ? null : userMsg,
          workspaceRoot: turnCwd,
          settings: useSettingsStore.getState().settings,
          // The answer is this turn's reply, written by the run rather than
          // streamed through `handleEvent`: it takes the armed slot here.
          claimReplyBranch,
          onSettled: (result) => {
            // A run that ended without an answer (refused, failed, stopped
            // before its seal) never claimed its regenerate slot or edit
            // owner, and no `session_ended` drops them on this lane.
            disarmBranch()
            const durationMs = finishBehaviorTurn(sessionId)
            if (durationMs !== undefined && result !== "cancelled") {
              void trackEvent(result === "completed" ? "chat.turn.completed" : "chat.turn.failed", {
                sessionId,
                provider: sendOptions.provider ?? "router-fusion",
                surface: "chat",
                durationMs,
                ...(result === "failed" ? { errorType: "router_fusion_run_failed" } : {}),
              })
            }
            // The same rule as a streamed turn's settle: a clean end drains the
            // queue, an armed interrupt drains it, a failure keeps it.
            if (result === "completed" || steerArmed.has(sessionId)) {
              drainSteerVia(sessionId, sendRef)
            } else if (result === "failed") {
              markPendingSteersFailed(sessionId)
            }
          },
        })
        return
      }

      // ── Independent reviewer (ADR-0117 `verified-fresh-agent`) ──
      // Armed here, after the Squad branch and before any direct-path await,
      // so the watcher sees this turn's `streaming` state and settles on its
      // end whichever executor runs it (SDK, standalone engine or an external
      // agent). The verifier itself is a brand-new session with none of this
      // turn's context. A companion shell is refused with a reason rather
      // than left to hang, and the picker shows the same reason.
      const turnOrchestration =
        turnComposition?.orchestration ?? compositionForSession(sessionId).orchestration
      if (turnOrchestration === "verified-fresh-agent") {
        void import("@/lib/agent/composition/verified-fresh-agent")
          .then(({ armVerifiedFreshAgentFollowup }) =>
            armVerifiedFreshAgentFollowup({
              sessionId,
              // Its contract: the user's request, without attachments.
              request: externalTurn.request,
              cwd: turnCwd,
              ...(session?.projectId ? { projectId: session.projectId } : {}),
              ...(session?.title ? { mainSessionTitle: session.title } : {}),
            })
          )
          .then((armed) => {
            if (!armed.armed) {
              console.warn("verified-fresh-agent follow-up not armed", armed.reason)
            }
          })
          .catch((error) => console.warn("verified-fresh-agent arm failed", error))
      }

      // A persisted execution context owns the chat's Task Workspace identity.
      // Repeated turns create versioned TaskRuns inside that same managed
      // worktree. The developer flag remains a compatibility path for sessions
      // created before execution contexts existed.
      // Repair a pre-existing managed context that was persisted with an empty
      // projectId before the creation path started stamping the real one. Doing
      // it here rather than in a Dexie upgrade covers the connector and
      // scheduler legs too, which never touch the UI.
      let executionContext = repairManagedContextProjectId(
        session?.executionContext,
        session?.projectId
      )
      const hasNoToolSurface = sendOptions.toolSurface === "none"
      // Read ONCE for the whole send. The store used to be consulted at three
      // separate points below, so a runtime switch part-way through a send
      // could be observed differently by each of them.
      const composerRuntimeRef = turnLane
      const manualExternal = !hasNoToolSurface && composerRuntimeRef.kind !== "builtin"
      // Who answers an addressed turn, stamped on the reply at seal (the
      // external seal below, and the builtin one through `setLastSend`).
      const routeStamp: MessageRunRouteStamp | undefined =
        turnRoute && routeLane
          ? buildRouteStamp(turnRoute, routeLane, {
              runtimes: routeSnapshot?.runtimes ?? [],
              ...(sendOptions.provider ? { providerId: sendOptions.provider } : {}),
            })
          : undefined

      // Resolve rule-based delegation before opening the Task Workspace and
      // adoption windows so their durable agent identity reflects the runtime
      // that will actually write the files.
      let delegation: import("@/lib/ai/agent/external/delegation-router").RoutingDecision | null =
        null
      if (
        !hasNoToolSurface &&
        !manualExternal &&
        !callOptions?.skipUserAppend &&
        !callOptions?.bypassDelegation &&
        // An addressed turn already names who answers; a delegation rule
        // re-routing it would override the user's own choice.
        !turnRoute
      ) {
        try {
          const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
          const mgr = getExternalAgentManager()
          if (mgr.getConnectedAgents().length > 0) {
            mgr.setDelegationRules(useExternalAgentStore.getState().delegationRules)
            const [{ routeDelegation }, { redactText }] = await Promise.all([
              import("@/lib/ai/agent/external/delegation-router"),
              import("@cognia/redact"),
            ])
            // Rules route on the question; the agent is handed the whole turn.
            const decision = routeDelegation(
              {
                prompt: externalTurn.request,
                payload: externalTurn.prompt,
                context: { sessionId },
              },
              {
                checkDelegation: (t, c) => mgr.checkDelegation(t, c),
                redact: (text) => redactText(text),
              }
            )
            if (decision.shouldDelegate) delegation = decision
          }
        } catch (err) {
          console.error("delegation routing failed", err)
        }
      }
      // One ref for the turn: the lane the composer picked, or the local agent a
      // delegation rule chose. The router names an agent rather than a lane, so
      // the ref is built here rather than pushed into its contract.
      const turnRuntimeRef: AgentRuntimeRef | null = manualExternal
        ? composerRuntimeRef
        : delegation?.targetAgentId
          ? { kind: "external", agentId: delegation.targetAgentId }
          : null
      // The lane id. For a host run this is the configuration id, which is also
      // the agent id the host mounts it under, so everything keyed by "which
      // agent is this turn on" keeps working without a second field.
      //
      // A host selection used to answer `null` here, because this read the
      // local-agent field and a host lane leaves that empty. The turn was
      // therefore recorded as `agentKind: "in-app"` under the agent id
      // "built-in", and it registered a durable chat receipt that the comment
      // below explicitly says an external turn must not have.
      const routedExternalAgentId =
        turnRuntimeRef?.kind === "host"
          ? turnRuntimeRef.configId
          : turnRuntimeRef?.kind === "external"
            ? turnRuntimeRef.agentId
            : undefined
      const adoptionAgentKind = routedExternalAgentId ? "external" : "in-app"
      // Whether this turn runs in THIS webview's standalone (BYOK) engine: no
      // sidecar, no host, and a tool catalog in which nothing opens a file
      // (`lib/ai/chat/standalone-tools.ts`). Read once, and the built-in
      // dispatch below branches on this same value, so the working-copy gate
      // and the executor it guards cannot disagree.
      //
      // `isStandaloneChatMode()` and not `hasHostRuntime()`: the question is
      // where the turn executes, and the host profile answers
      // "mobile-companion" for a phone in standalone mode, paired or not.
      const standaloneEngineTurn = !manualExternal && !delegation && isStandaloneChatMode()
      // A working copy exists for an executor that opens files in it. A
      // zero-tool turn has none, and neither has a standalone engine turn, so
      // for both the managed bundle, the turn lease and the project environment
      // below have no consumer. Demanding them anyway refused every rootless
      // chat in a plain browser or a standalone phone before its first token:
      // the managed workspace cannot be materialized there, and nothing would
      // have opened it. The durable `managed` identity is left untouched, so a
      // desktop that later receives the conversation materializes it as usual.
      const turnUsesWorkingCopy = !hasNoToolSurface && !standaloneEngineTurn
      if (!hasNoToolSurface && executionContext?.location === "local") {
        sendOptions = { ...sendOptions, cwd: executionContext.projectRoot }
      }
      // ADR-0130 hard cost ceiling. Evaluated BEFORE any durable acceptance so
      // a refused overrun leaves no half-open run behind. Fails open on any
      // infrastructure error — the user asked for a spending limit, not for
      // their app to stop when Dexie hiccups.
      //
      // The synchronous pre-check keeps the default install (no ceiling
      // configured) on exactly the code path it had before: no extra await, no
      // Dexie read, nothing to pay for a feature that is switched off.
      //
      // A Router + Fusion turn skips it here (ADR-0188 D35): its run holds the
      // same budget remainder, and going over asks for a one-run grant instead.
      // Should the run then fault and the turn fall back to the original path,
      // the ceiling is checked just before dispatch.
      const budgetDecision =
        isCostBudgetConfigured() && !sendOptions.routerFusion
          ? await enforceCostBudget({
              ...(sendOptions.provider ? { providerId: sendOptions.provider } : {}),
              runId: executionRunId,
            })
          : null
      if (budgetDecision && !budgetDecision.allowed) {
        store.getState().setSessionStatus(sessionId, "idle")
        store.getState().setSessionDiagnostic(
          sessionId,
          toDiagnostic(new Error("cost_budget_exceeded"), {
            source: "chat",
            // `extra` is `DiagnosticMeta`'s documented escape hatch for
            // subsystem-specific ids, and it takes scalars — hence the join
            // rather than the raw array.
            meta: {
              sessionId,
              extra: { blockedBy: budgetDecision.blockedBy.map((v) => v.scopeKey).join(",") },
            },
          })
        )
        chatTurnPerformance.finish(sessionId, "failed")
        await settleChatTurnForSession(sessionId, {
          outcome: "failed",
          errorCode: "cost_budget_exceeded",
        })
        rejectSend("cost_budget_exceeded")
        return
      }
      // Durable acceptance (ADR-0123), phase A. `effectiveContent` has been
      // final since the Workbench payload gate — plugin hooks, pipes and
      // redaction all ran before it, and nothing below reassigns it — so
      // freezing it here captures exactly what the model will be sent.
      // `sendOptions` is NOT final yet (cwd, task workspace and routing are
      // still to come), which is why the context is frozen separately, just
      // before dispatch. Returns null when the feature is off or no runtime
      // target is active, in which case the turn proceeds exactly as before.
      // External-agent turns use their own durable runtime. Register only the
      // built-in path here; otherwise a long external turn would leave a chat
      // submission with no replayable SendOptions and the outbox could race it.
      const durableReceipt = routedExternalAgentId
        ? null
        : await acceptChatTurn({
            sessionId,
            runId: executionRunId,
            messageId: userMsg.id,
            content: effectiveContent,
            visibleMessageIds: next.map((message) => message.id),
            ...(session?.projectId ? { projectId: session.projectId } : {}),
            ...(session?.issueId
              ? { workItemRef: { kind: "issue" as const, id: session.issueId } }
              : {}),
            // The user message lands in the SAME transaction as the submission.
            // Without this the row would still reach Dexie eventually, via the
            // debounced transcript writer — but a crash in between would leave a
            // submission whose message is not in the transcript, which is the
            // mirror image of the bug this feature exists to remove. A delta
            // upsert, not `persistMessages`: the latter treats omissions as
            // deletions and would wipe history we are not holding here.
            ...(skipAppend
              ? {}
              : { writeTranscript: () => commitMessageDelta(sessionId, { upserts: [userMsg] }) }),
          }).catch((error) => {
            // Never block a send on the ledger: the legacy path still runs.
            console.error("acceptChatTurn failed", error)
            return null
          })
      let dispatchClaim: Awaited<ReturnType<typeof claimChatTurnForDispatch>> = "legacy"
      let stopAssemblyHeartbeat = () => {}
      let durableLeaseLost = false

      /**
       * Refuse a turn that has already flipped the session to `streaming`.
       *
       * Eight call sites repeated this by hand, and each had to remember five
       * separate steps: terminal status, performance finish, work-submission
       * settle, assembly heartbeat, and — once the execution run has started —
       * finishing that run. A path that forgot one left the composer spinning
       * with nothing to press. One place means a refusal added tomorrow cannot
       * forget, and it is where the metric goes: these refusals emitted nothing
       * at all, so a workspace that refuses every send looked exactly like an
       * install nobody used.
       *
       * The execution lease is deliberately absent. It is released by the store
       * subscription in `lib/execution/chat-lease.ts` on any transition out of
       * an active status, which the `idle` flip below is; releasing here too
       * would give one lease two owners.
       *
       * `chat.turn.failed` rather than a new event name: the turn was accepted
       * and then failed, which is exactly what that event already means.
       */
      const markTurnFailed = async (diagnostic: CogniaDiagnostic): Promise<void> => {
        const current = store.getState().sessions[sessionId]?.messages ?? []
        const target = skipAppend
          ? turnMessageId(current)
          : current.some((message) => message.id === userMsg.id)
            ? userMsg.id
            : null
        if (!target) return
        const marked = markTurnAdmission(current, target, {
          state: "failed",
          code: diagnostic.code,
          ...(diagnostic.detail || diagnostic.message
            ? { detail: diagnostic.detail || diagnostic.message }
            : {}),
          at: Date.now(),
        })
        if (marked === current) return
        store.getState().replaceSessionMessages(sessionId, marked)
        await persistMessages(sessionId, marked).catch((error: unknown) =>
          console.warn("failed turn persist failed", error)
        )
      }
      const refuseTurn = async (input: {
        diagnostic: CogniaDiagnostic
        /** Stable, low-cardinality reason. Doubles as the telemetry `errorType`. */
        errorCode: string
        /** True once `startDirectChatExecutionRun` has run for this turn. */
        finishRun?: boolean
      }): Promise<void> => {
        if (input.finishRun) await finishDirectChatExecutionRun(sessionId, "failed")
        store.getState().setSessionStatus(sessionId, "idle")
        store.getState().setSessionDiagnostic(sessionId, input.diagnostic)
        chatTurnPerformance.finish(sessionId, "failed")
        await settleChatTurnForSession(sessionId, {
          outcome: "failed",
          errorCode: input.errorCode,
        })
        releaseSkillLoadContext(sessionId)
        stopAssemblyHeartbeat()
        const durationMs = finishBehaviorTurn(sessionId)
        if (durationMs !== undefined) {
          void trackEvent("chat.turn.failed", {
            sessionId,
            surface: "chat",
            errorType: input.errorCode,
            durationMs,
            ...(sendOptions.provider ? { provider: sendOptions.provider } : {}),
          })
        }
        // The turn never ran. When its message is still in the transcript (a
        // refusal that rolled it back has nothing to mark), the row itself says
        // so — and keeps saying so after the banner is dismissed or the app is
        // reloaded — with its own retry.
        await markTurnFailed(input.diagnostic)
        // A plan step's turn is always dispatched with `skipUserAppend` (the
        // plan runtime wrote its message). A refused one halts the plan on the
        // step now, instead of leaving it `in_progress` for the watchdog; a
        // manual message's refusal never touches the plan.
        if (callOptions?.skipUserAppend) {
          await haltInSessionPlanOnTurnFailure({
            sessionId,
            cause: planHaltCauseForCode(input.diagnostic.code),
            detail: `${input.diagnostic.code}: ${input.diagnostic.detail || input.diagnostic.message || input.errorCode}`,
          })
        }
        rejectSend(input.diagnostic.message || input.errorCode)
      }
      let abortStaleLocalRuntime = () => {}
      if (durableReceipt) {
        dispatchClaim = await claimChatTurnForDispatch(executionRunId)
        if (dispatchClaim === "owned_elsewhere") return
        if (dispatchClaim === "claimed") {
          stopAssemblyHeartbeat = startWorkSubmissionLeaseHeartbeat(
            chatSubmissionId(executionRunId),
            "live-chat",
            {
              onError: (error) => console.error("work submission lease renewal failed", error),
              onLeaseLost: () => {
                durableLeaseLost = true
                abortStaleLocalRuntime()
              },
            }
          )
        }
      }
      let bundlePrimaryRootId: string | undefined
      let managedBundle: SessionBundleBinding["bundle"] | undefined
      if (turnUsesWorkingCopy && executionContext?.location === "managedWorktree") {
        const project = useProjectStore
          .getState()
          .projects.find((candidate) => candidate.id === executionContext?.projectId)
        if (!project) {
          await refuseTurn({
            errorCode: "managed_project_unavailable",
            diagnostic: createDiagnostic("workspaceUnavailable", {
              source: "chat",
              message: tInlineErr("managedWorktreeUnavailable"),
              meta: { sessionId },
            }),
          })
          return
        }
        try {
          const binding = await ensureSessionExecutionBundle({
            sessionId,
            context: executionContext,
            project,
          })
          executionContext = binding.context
          bundlePrimaryRootId = binding.primaryLogicalRootId
          managedBundle = binding.bundle
          sendOptions = {
            ...sendOptions,
            cwd: binding.primaryAlias,
            additionalDirectories: binding.additionalAliases,
          }
          await updateSession(sessionId, { executionContext })
        } catch (error) {
          console.error("managed workspace bundle acquisition failed", error)
          await refuseTurn({
            errorCode: "workspace_bundle_unavailable",
            diagnostic: createDiagnostic("workspaceBundleFailed", {
              source: "chat",
              message: error instanceof Error ? error.message : String(error),
              meta: { sessionId },
            }),
          })
          return
        }
      }
      const boundWorkspaceRoot = executionContext
        ? resolveSessionWorkspaceRoot(executionContext)
        : undefined
      try {
        const sharedRun = await beginSharedSessionRun(session, executionRunId, {
          messageId: callOptions?.sharedRequest?.messageId ?? userMsg.id,
          parts: userMsg.parts,
          ...callOptions?.sharedRequest,
        })
        if (sharedRun.kind === "queued") {
          store.getState().setSessionStatus(sessionId, "idle")
          await settleChatTurnForSession(sessionId, { outcome: "cancelled" })
          stopAssemblyHeartbeat()
          return
        }
        if (sharedRun.kind === "acquired") {
          sharedRun.setApprovalDecisionHandler(async (approval, decision) => {
            if (!sharedApprovalResponseRef.current)
              throw new Error("Shared approval response handler is unavailable")
            await sharedApprovalResponseRef.current(approval, decision)
          })
          sharedRun.setLeaseLostHandler(() => {
            durableLeaseLost = true
            abortStaleLocalRuntime()
            void (async () => {
              const handle = getExecutionHandle(sessionId)
              if (handle) await handle.interrupt()
              else await interruptSession(sessionId)
              await cancelRouterFusionTurn(sessionId)
            })().catch(() => undefined)
          })
        }
      } catch (error) {
        await refuseTurn({
          errorCode: "shared_run_coordination_failed",
          diagnostic: toDiagnostic(error, { source: "chat", meta: { sessionId } }),
        })
        return
      }
      try {
        await startDirectChatExecutionRun({
          sessionId,
          runId: executionRunId,
          // The canonical log's `user-input` event, clipped from the front: the
          // question, which the files ahead of it would push out. The files
          // are on the user row in `messages`.
          ...(externalTurn.request ? { prompt: externalTurn.request } : {}),
          ...(session?.projectId ? { projectId: session.projectId } : {}),
          ...((boundWorkspaceRoot ?? sendOptions.cwd)
            ? { workspaceRoot: boundWorkspaceRoot ?? sendOptions.cwd }
            : {}),
        })
      } catch (error) {
        await refuseTurn({
          errorCode: "execution_run_start_failed",
          finishRun: true,
          diagnostic: toDiagnostic(error, { source: "chat", meta: { sessionId } }),
        })
        return
      }
      const legacyWorkspaceEnabled = !executionContext && Boolean(sendOptions.cwd)
      if (
        turnUsesWorkingCopy &&
        (executionContext?.location === "managedWorktree" || legacyWorkspaceEnabled)
      ) {
        if (executionContext?.location === "managedWorktree" && !boundWorkspaceRoot) {
          await refuseTurn({
            errorCode: "managed_worktree_unavailable",
            finishRun: true,
            diagnostic: createDiagnostic("workspaceUnavailable", {
              source: "chat",
              message: tInlineErr("managedWorktreeUnavailable"),
              meta: { sessionId },
            }),
          })
          return
        }
        const anchorMessage = skipAppend
          ? [...previousMessages].reverse().find((message) => message.role === "user")
          : userMsg
        const workspaceRoot = boundWorkspaceRoot ?? sendOptions.cwd!
        const taskEnvelope = {
          taskId:
            executionContext?.taskWorkspace.taskId ??
            taskIdForMessage(anchorMessage?.id ?? userMsg.id),
          sessionId,
          runId: executionRunId,
          executionRunId,
          turnId: anchorMessage?.id ?? userMsg.id,
          attemptId: frozenAttemptId,
          surface: "chat",
          agentId: routedExternalAgentId ?? "built-in",
          agentKind: adoptionAgentKind,
          workspaceRoot,
          ...(executionContext?.taskWorkspace.workspaceKey
            ? { workspaceKey: executionContext.taskWorkspace.workspaceKey }
            : {}),
        }
        const legacyBundle = legacyWorkspaceEnabled
          ? await (async () => {
              const { provisioningForWorkspaceRoot } =
                await import("@/lib/task-workspace/workspace-provisioning")
              const provisioning = await provisioningForWorkspaceRoot(workspaceRoot).catch(
                () => undefined
              )
              return acquireWorkspaceBundle({
                ownerType: "session",
                ownerRef: sessionId,
                environmentKind: "managed",
                base: { kind: "workingState" },
                roots: [
                  {
                    logicalRootId: "primary",
                    role: "primary",
                    sourceRoot: workspaceRoot,
                  },
                ],
                ...(provisioning ? { provisioning } : {}),
              })
            })().catch(() => null)
          : null
        // Caught, unlike every other await in this block, because a throw here
        // escaped the send entirely: the composer's own catch logged it, the
        // session stayed `streaming` forever, and the status edge that settles
        // the turn's workspace run therefore never fired. The run stayed
        // `running` on the Host and the session's NEXT turn was refused for
        // good with "pipeline workspace is already active". A refusal both
        // settles the turn and puts the reason on screen.
        // The ending turn's id, read at the refusal rather than captured
        // earlier: the store's counter is the only thing that knows which turn
        // the settle edge is about to fire for.
        const markTurnUnowned = () => {
          const endingRunId = store.getState().sessions[sessionId]?.runId
          if (typeof endingRunId === "number") markTaskWorkspaceTurnUnowned(sessionId, endingRunId)
        }
        let bundleTurnLease: Awaited<ReturnType<typeof openWorkspaceBundleTurnLease>> = null
        try {
          bundleTurnLease =
            executionContext?.location === "managedWorktree" && managedBundle && bundlePrimaryRootId
              ? await openWorkspaceBundleTurnLease(managedBundle, bundlePrimaryRootId, taskEnvelope)
              : legacyBundle
                ? await openWorkspaceBundleTurnLease(legacyBundle, "primary", {
                    ...taskEnvelope,
                    base: { kind: "workingState" },
                  })
                : null
        } catch (error) {
          console.error("workspace turn lease failed", error)
          // This turn never got a working copy, so its refusal must not settle
          // the one the session already holds — which, when the refusal is
          // `isWorkspaceBusyRefusal`, is precisely the live turn that caused it.
          markTurnUnowned()
          const leaseFailure = error instanceof Error ? error.message : String(error)
          // Typed once, where the host's sentence enters: from here on the
          // refusal is a lease conflict on the working copy, with its holder.
          const conflict = isWorkspaceBusyRefusal(error) ? workingCopyConflict(error) : null
          await refuseTurn({
            errorCode: "task_workspace_unavailable",
            finishRun: true,
            // Two codes, because the two refusals want opposite advice:
            // `workspaceUnavailable` tells the reader to bind a folder, which
            // is exactly wrong for a binding that is already correct and merely
            // held by a turn that has not finished.
            diagnostic: conflict
              ? createDiagnostic("workspaceBusy", {
                  source: "chat",
                  // The host's own sentence names an internal workspace key and
                  // says nothing to a reader, so the translated one is what
                  // `message` carries — it is mirrored onto the legacy
                  // `errorMessage` that the mobile toast and the OS session
                  // notification still render as prose. The host's words go to
                  // `detail`, under the card's raw disclosure.
                  message: tInlineErr("workspaceBusy"),
                  detail: leaseFailure,
                  meta: {
                    sessionId,
                    extra: {
                      leaseResource: conflict.resource,
                      ...(conflict.holder ? { leaseHolder: conflict.holder } : {}),
                    },
                  },
                })
              : createDiagnostic("workspaceUnavailable", {
                  source: "chat",
                  // For every other failure the host's sentence is the ONLY
                  // account of what went wrong, so it stays the message rather
                  // than being demoted into a disclosure.
                  message: leaseFailure,
                  meta: { sessionId },
                }),
          })
          return
        }
        const taskLease = bundleTurnLease
        if (
          !taskLease &&
          (executionContext?.location === "managedWorktree" || legacyWorkspaceEnabled)
        ) {
          markTurnUnowned()
          await refuseTurn({
            errorCode: "task_workspace_unavailable",
            finishRun: true,
            diagnostic: createDiagnostic("workspaceUnavailable", {
              source: "chat",
              message: tInlineErr("managedWorktreeUnavailable"),
              meta: { sessionId },
            }),
          })
          return
        }
        sendOptions = { ...sendOptions, taskWorkspace: taskEnvelope }
        if (taskLease) {
          sendOptions = bundleTurnLease
            ? {
                ...sendOptions,
                cwd: bundleTurnLease.primaryAlias,
                additionalDirectories: bundleTurnLease.additionalAliases,
              }
            : { ...sendOptions, cwd: taskLease.run.executionRoot }
          if (executionContext?.location === "managedWorktree") {
            const bound = bundleTurnLease
              ? bindExecutionBundleTurn(
                  executionContext,
                  bundleTurnLease.bundleTurnId,
                  taskLease.run.runId
                )
              : bindExecutionRun(executionContext, taskLease.run.runId)
            const active = transitionManagedWorktree(bound, "active", Date.now())
            void updateSession(sessionId, { executionContext: active }).catch((error) =>
              console.error("persist execution context failed", error)
            )
          }
        }
      }

      // The sandbox placement was bound while `resolveSendOptions` assembled
      // the envelope — before this turn knew where it would actually run. A
      // managed worktree only leases its bundle alias above, so re-bind against
      // the final cwd: the microVM preflight claims against `workspaceRoot`,
      // and the confine roots are measured from it. A no-op when the root did
      // not move, and it never throws.
      if (sendOptions.sandboxRuntimeRef) {
        const reboundRef = await sandboxSessionRuntime.rebindWorkspaceRoot(
          sendOptions.sandboxRuntimeRef,
          sendOptions.cwd
        )
        if (reboundRef !== sendOptions.sandboxRuntimeRef) {
          sendOptions = { ...sendOptions, sandboxRuntimeRef: reboundRef }
        }
      }

      if (turnUsesWorkingCopy && executionContext?.environmentId) {
        const environment = await getProjectEnvironment(executionContext.environmentId)
        if (!environment || environment.projectId !== executionContext.projectId) {
          await refuseTurn({
            errorCode: "environment_unavailable",
            finishRun: true,
            diagnostic: createDiagnostic("environmentUnavailable", {
              source: "chat",
              message: tInlineErr("environmentUnavailable"),
              meta: { sessionId, extra: { environmentId: executionContext.environmentId } },
            }),
          })
          return
        }
        // The repository's own `.cognia/workspace.json`, merged in when the
        // user has approved it. Resolved through the shared seam rather than
        // inline, so the trust gate cannot end up applied on only one of the
        // two run paths (the other is the scheduler executor).
        const environmentRoot = sendOptions.cwd ?? executionContext.projectRoot
        const resolvedEnvironment = await resolveEnvironmentForRun({
          environment,
          executionRoot: environmentRoot,
          surface: "interactive",
          ...(executionContext.projectId ? { projectId: executionContext.projectId } : {}),
        })
        const setup = await executeProjectEnvironment({
          environment: resolvedEnvironment.environment,
          executionRoot: environmentRoot,
          scope: executionContext.location,
          surface: "interactive",
          bypassOnFailure: callOptions?.bypassEnvironmentSetup,
        })
        if (!setup.success) {
          await refuseTurn({
            errorCode: "environment_setup_failed",
            finishRun: true,
            diagnostic: createDiagnostic("environmentSetupFailed", {
              // The setup step's own words when it has them: it names the
              // failing command, which no generic label can.
              source: "chat",
              message: setup.error || tInlineErr("environmentSetupFailed"),
              meta: { sessionId, extra: { environmentId: executionContext.environmentId } },
            }),
          })
          return
        }
      }

      // Code-adoption tracking (Phase 1): open a per-turn attribution window.
      // Fire-and-forget — must never block or disrupt the turn. `runId` is read
      // back from the store, whose streaming flip above bumped it for this turn.
      if (!hasNoToolSurface) {
        void beginCodeAdoptionTurn(sendOptions.cwd, {
          sessionId,
          runId: chatRunId,
          model: sendOptions.model ?? null,
          agentKind: adoptionAgentKind,
        })
      }

      // ── External agent branch ──────────────────────────────────────────
      // When the user selected "external" runtime in the composer toolbar,
      // dispatch to the external agent manager instead of the Claude SDK
      // sidecar. The optimistic user-message stays in the store so the
      // composer reflects the send immediately; the assistant reply is
      // appended from the manager result when it lands.
      if (manualExternal || delegation) {
        // A configuration the paired HOST owns, when the composer points at one
        // instead of at a locally configured agent. Only the manual lane can
        // select one — a delegation rule names a local agent by id, and there
        // is no rule syntax for "whatever the host is called this week".
        const hostSelection =
          turnRuntimeRef?.kind === "host"
            ? {
                configId: turnRuntimeRef.configId,
                revision: turnRuntimeRef.revision,
                lifecycleGeneration: turnRuntimeRef.lifecycleGeneration,
              }
            : null
        const extAgentId = routedExternalAgentId
        // Fail-closed backstop, not a reachable path. `turnRuntimeRef` is built
        // from the composer's ref (which names its target) or from a delegation
        // decision (`routeDelegation` refuses one with no `targetAgentId`), so
        // reaching here means the two disagreed. Refusing beats dispatching a
        // turn to nothing.
        if (!extAgentId) {
          // The optimistic user message is rolled back before the refusal:
          // nothing was sent, so it must not stay in the transcript.
          store.getState().replaceSessionMessages(sessionId, previousMessages)
          await refuseTurn({
            errorCode: "external_agent_not_selected",
            finishRun: true,
            diagnostic: createDiagnostic("externalAgentNotSelected", {
              source: "external-agent",
              meta: { sessionId },
            }),
          })
          return
        }
        // Record the lane this session's turn is actually on, so a follow-up
        // typed while it runs steers this agent rather than whatever the
        // composer's global runtime selector happens to say (see
        // `sessionExternalLane`). Cleared when the turn settles, in
        // `maybeDrainSteer`.
        setSessionExternalLane(sessionId, extAgentId)
        // A session remembers its lane across reloads; the manager does not.
        // Registering the config with the manager happens when the user picks
        // the agent, so a restored session sent without touching the picker
        // reached `ExternalAgentManager.execute` with an id it had never been
        // given and died on the manager-internal "Agent not found: <id>".
        //
        // Local lanes only. A host lane names a configuration the Host owns and
        // runs; there is no local adapter to register, and asking the local
        // store for it would answer `unknown-agent` for a perfectly good agent.
        const cogniaModel = resolveExternalAgentCogniaModelAxis({
          agentId: extAgentId,
          sessionModel: laneOwnsSessionModel ? session?.model : undefined,
          sessionProviderOverride: laneOwnsSessionModel ? session?.providerOverride : undefined,
          accountId: session?.accountId ?? undefined,
        })
        const managedGatewayTask =
          !!(cogniaModel === undefined
            ? useExternalAgentStore.getState().agents[extAgentId]?.cogniaModel
            : cogniaModel) ||
          (session?.externalAgentSession?.agentId === extAgentId &&
            session.externalAgentSession.sessionId.startsWith("cognia-gateway:"))
        if (turnRuntimeRef?.kind === "external") {
          const { ensureExternalAgentReady } =
            await import("@/lib/agent/ensure-external-agent-ready")
          // ADR-0182: a project run is readied WHERE its runtime environment
          // puts it — resolved first, refused before any process starts, and
          // restarted if the agent is running somewhere else. A session with
          // no project has nothing to resolve and connects as before (Q39).
          const runProjectId = session?.projectId ?? executionContext?.projectId
          const readiness = await ensureExternalAgentReady(extAgentId, {
            deferConnect: managedGatewayTask,
            ...(runProjectId
              ? {
                  environment: {
                    projectId: runProjectId,
                    ...(executionContext?.environmentId
                      ? { environmentId: executionContext.environmentId }
                      : {}),
                    project: useProjectStore
                      .getState()
                      .projects.find((candidate) => candidate.id === runProjectId),
                    executionRoot: boundWorkspaceRoot ?? executionContext?.projectRoot,
                    surface: "interactive" as const,
                  },
                }
              : {}),
          })
          if (!readiness.ok) {
            store.getState().replaceSessionMessages(sessionId, previousMessages)
            await refuseTurn({
              errorCode: "external_agent_unavailable",
              finishRun: true,
              diagnostic: createDiagnostic("externalAgentNotReady", {
                source: "external-agent",
                message:
                  readiness.reason === "unknown-agent"
                    ? undefined
                    : (readiness as { detail: string }).detail,
                meta: { sessionId, agentId: extAgentId },
              }),
            })
            return
          }
        }
        // The text sent to the external agent: the PII-filtered prompt when
        // delegated by rule, else the turn as `externalTurnPrompt` reads it —
        // the typed question, behind any attachment text, never the file alone.
        const externalSendText = delegation ? delegation.filteredPrompt : externalTurn.prompt
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
        /**
         * Take down every decision surface this session's external agent owns.
         *
         * One helper for two call sites that must NOT be collapsed into one:
         * the `finally` below runs after the whole turn, but the failure path
         * has to clear the surface BEFORE the sidecar fallback re-issues the
         * turn — `PaneApprovalGate` renders the first pending entry, so a dead
         * external card left in the queue would hide the fallback turn's own
         * approval behind a dialog nothing can answer, hanging that turn too.
         * Idempotent, so running it twice costs nothing.
         */
        const releaseExternalDecisionSurfaces = async (): Promise<void> => {
          const { releaseExternalApprovals, elicitationCancelResponse } =
            await import("@/lib/ai/agent/external/session/chat-decision-bridge")
          for (const requestId of releaseExternalApprovals(sessionId)) {
            store.getState().clearApproval(requestId, sessionId)
          }
          const { useExternalElicitationStore: elicitations } =
            await import("@/stores/agent/external-elicitation-store")
          const stranded = elicitations.getState().clearSession(sessionId)
          if (stranded.length === 0) return
          const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
          const manager = getExternalAgentManager()
          // Best effort: the adapter is usually already gone, which is why the
          // question was stranded in the first place. Telling it the user
          // walked away costs nothing and lets an agent that IS still
          // listening stop waiting.
          for (const entry of stranded) {
            void manager
              .respondToElicitation(entry.agentId, elicitationCancelResponse(entry))
              .catch(() => undefined)
          }
        }
        const handleExternalFailure = async (message: string, error?: Error): Promise<void> => {
          // Before the fallback re-issues this turn on the sidecar: the
          // external agent is gone, so its card is dead and would sit in front
          // of the fallback turn's own approval.
          await releaseExternalDecisionSurfaces()
          // ADR-0127: the external rail streams through the per-session
          // coalescer, so a failure must drop any pending frame / debounced
          // write (a late rAF commit would resurrect the partial over the
          // failure state) and re-pin Dexie to the user turn alone — the
          // debounced writer may already have stored a partial assistant.
          const pending = registry.get(sessionId)
          pending.commit.cancel()
          pending.persist.cancel()
          registry.release(sessionId)
          await persistMessages(sessionId, next).catch(() => undefined)
          if (delegation && chatFailurePolicy === "fallback" && !managedGatewayTask) {
            await finishDirectChatExecutionRun(
              sessionId,
              "failed",
              Date.now(),
              "Fallback requested"
            )
            // Keep the user turn, drop any partial external assistant, then
            // re-issue THIS turn through the SDK path (skipUserAppend so the
            // user message isn't duplicated; bypassDelegation so we don't
            // re-match the same rule and loop).
            store.getState().replaceSessionMessages(sessionId, next)
            store.getState().setSessionError(sessionId, null)
            // An edit's bookkeeping already ran on THIS send, for the row it
            // appended: carrying `branchTag` into the re-issue would stamp and
            // select the user message the fallback builds but never appends,
            // and own its reply by that phantom id. The fallback takes only
            // the owner, and this send lets go of its entry first — the
            // `finally` below disarms what this send still holds, and the
            // fallback's entry names the same row.
            const { branchTag: _editTag, ...fallbackCallOptions } = callOptions ?? {}
            const editOwner = callOptions?.branchTag ? armedOwner : null
            if (editOwner) armedOwner = null
            await sendRef.current?.(displayContent, opts, {
              ...fallbackCallOptions,
              skipUserAppend: true,
              bypassDelegation: true,
              ...(editOwner ? { branchOwnerId: editOwner } : {}),
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
          await finishDirectChatExecutionRun(sessionId, "failed")
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
          // Classified from the error's TYPE first: a Pi process that exited
          // during startup, a handshake that never arrived, an agent process id
          // still held by another process. Each has a code whose localized hint
          // says what happened and what to do; the runtime's English sentence
          // moves to `detail`. Anything untyped keeps the text classifier.
          const typedCode = error ? classifyExternalTurnFailure(error) : null
          const diagnostic = typedCode
            ? createDiagnostic(typedCode, {
                source: "external-agent",
                message: tDiagnostics(`code.${typedCode}.hint`),
                detail: message,
                meta: { sessionId, agentId: extAgentId },
              })
            : toDiagnostic(error ?? message, {
                source: "external-agent",
                meta: { sessionId, agentId: extAgentId },
              })
          // The user's message STAYS, marked as a turn that did not run. It
          // used to be pulled out of the store while the copy persisted above
          // stayed in Dexie, so the row showed no failure now and reappeared
          // unmarked after a reload — and Retry regenerated the PREVIOUS turn,
          // because the failed one was no longer the last user message.
          const failedTurn = turnMessageId(next, skipAppend ? null : userMsg.id)
          const failedList = markTurnAdmission(
            store.getState().sessions[sessionId]?.messages ?? next,
            failedTurn,
            {
              state: "failed",
              code: diagnostic.code,
              detail: message,
              at: Date.now(),
            }
          )
          store.getState().replaceSessionMessages(sessionId, failedList)
          await persistMessages(sessionId, failedList).catch((persistError: unknown) =>
            console.warn("failed external turn persist failed", persistError)
          )
          store.getState().setSessionDiagnostic(sessionId, diagnostic)
          store.getState().setSessionStatus(sessionId, "idle")
          // Follow-ups queued behind this turn cannot ride a turn that never
          // ran; the same rule the sidecar applies to an errored settle.
          markPendingSteersFailed(sessionId, diagnostic.message)
          // The same in-session plan contract the sidecar lane has: a step whose
          // turn failed halts the plan on it with the classified cause — a lease
          // conflict or a start-up death is `not_started`, anything later
          // `turn_failed` — rather than waiting for the step watchdog.
          if (callOptions?.skipUserAppend) {
            await haltInSessionPlanOnTurnFailure({
              sessionId,
              cause: planHaltCauseForCode(diagnostic.code),
              detail: `${diagnostic.code}: ${message}`,
            })
          }
          if (error) dispatchPluginChatError(sessionId, error)
        }

        const gatewayController = !hostSelection ? new AbortController() : undefined
        if (gatewayController) externalGatewayAbortRef.current.set(sessionId, gatewayController)
        let externalTurnCompleted = false
        try {
          await persistMessages(sessionId, next)
          await touchSession(sessionId)
          await applyInstantTitle(sessionId, displayContent)

          const { executeOnExternalAgent } = await import("@/lib/ai/agent/external/manager")
          const { executeOnRemoteHostAgent, remoteApprovalDecisionId } = hostSelection
            ? await import("@/lib/ai/agent/external/runtimes/remote/remote-execute")
            : { executeOnRemoteHostAgent: null, remoteApprovalDecisionId: null }
          // The run id a host turn is addressed by. Captured here so the
          // decision ids the event handler mints below refer to the same run
          // the executor is about to start.
          const remoteRunId = hostSelection
            ? `rer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
            : null
          const { applyExternalAgentEventToParts } =
            await import("@/lib/ai/agent/external/session/event-to-parts")
          const {
            registerExternalApproval,
            registerExternalElicitation,
            registerExternalQuestionTarget,
            toPermissionResponse,
          } = await import("@/lib/ai/agent/external/session/chat-decision-bridge")
          const { useExternalElicitationStore } =
            await import("@/stores/agent/external-elicitation-store")

          // Pre-allocate the assistant message so partial deltas land in it
          // without flickering the chat list. Parts start empty and grow as
          // ExternalAgentEvents arrive via the onEvent callback below.
          const assistantId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          const externalStartedAt = behaviorTurnStartedAt.get(sessionId)
          let assistantParts: UIMessage["parts"] = [] as unknown as UIMessage["parts"]
          const baseList = store.getState().sessions[sessionId]?.messages ?? []

          // ADR-0127 §1: the external rail rides the same per-session
          // coalescer as the sidecar rail — ≤1 React commit per frame and a
          // debounced mid-stream Dexie write — instead of a synchronous full
          // `replaceSessionMessages` per delta and a Dexie write only at the
          // end (which lost the partial on a mid-turn crash).
          const coalesce = registry.get(sessionId)
          // The branch stamp is claimed by the first write of the reply (the
          // point `handleEvent` claims it for a sidecar reply) and carried by
          // every rewrite of the same message after it.
          let replyBranch: Record<string, unknown> | null = null
          const writeAssistant = () => {
            replyBranch ??= claimReplyBranch(assistantId)
            // Write into this session's *own* slice — a mid-run focus switch is
            // safe because the slice is keyed by session, so the in-flight
            // external turn lands in its pane (live in background or focused),
            // never clobbering whatever session is now focused.
            const assistantMsg: UIMessage = {
              id: assistantId,
              role: "assistant",
              parts: assistantParts,
              metadata: {
                ...(delegatedMeta ?? {}),
                ...replyBranch,
                run: {
                  providerId: "external",
                  startedAt: externalStartedAt,
                },
              },
            }
            const nextMessages = [...baseList, assistantMsg]
            coalesce.commit.call(nextMessages)
            coalesce.persist.call(nextMessages)
          }
          /**
           * What the agent said when it refused this turn.
           *
           * Pi reports a failed turn on the assistant message it could not
           * produce (`stopReason: "error"` carrying the provider's own words),
           * and the adapter maps that to an `error` event. Nothing downstream
           * read it: `applyExternalAgentEventToParts` has no `error` case, so
           * "402 Insufficient Balance" was dropped and the turn settled as a
           * perfectly ordinary completion with an empty assistant bubble. The
           * user was told nothing at all.
           */
          let externalErrorDetail: string | null = null
          /** Seal the coalescer: apply the last frame now, drop the debounced write. */
          const sealCoalescer = () => {
            coalesce.commit.flush()
            coalesce.persist.cancel()
          }

          chatTurnPerformance.markDispatched(sessionId)
          /**
           * One event handler for both lanes.
           *
           * `applyExternalAgentEventToParts` deliberately does not render a
           * permission request — its contract is that the caller routes it
           * "through dedicated UI channels (e.g. the existing pendingApprovals
           * store)". Nothing here did, so an external agent that asked for
           * permission on the chat surface got no dialog and no answer, and the
           * turn stalled until the adapter timed out. Pi hits this on its
           * ordinary path: its native edit/write/bash calls are intercepted
           * precisely so they can be asked about (ADR-0119).
           *
           * A host run mints a `remoteDecisionId` alongside, which is the only
           * thing that differs: the card, the store and the dialog are the same
           * ones the local lane uses.
           */
          let persistedExternalSessionId = session?.externalAgentSession?.sessionId
          let externalSessionWrite = Promise.resolve()
          let externalSessionWriteError: unknown
          const persistExternalSession = (nativeId?: string) => {
            const hosted = externalToolHostsRef.current.get(sessionId)
            if (hosted?.agentId === extAgentId && nativeId) hosted.nativeSessionId = nativeId
            if (!nativeId?.startsWith("cognia-gateway:") || nativeId === persistedExternalSessionId)
              return
            persistedExternalSessionId = nativeId
            externalSessionWrite = externalSessionWrite
              .then(async () => {
                await updateSession(sessionId, {
                  externalAgentSession: { agentId: extAgentId, sessionId: nativeId },
                })
              })
              .catch((error: unknown) => {
                externalSessionWriteError = error
              })
          }
          let hostedServerNames: string[] = []
          const handleExternalEvent = (
            event: import("@/types/agent/external-agent").ExternalAgentEvent
          ) => {
            if (event.type === "session_start") persistExternalSession(event.sessionId)
            if (gatewayController?.signal.aborted) return
            // First, before anything else in this handler can throw or return:
            // an agent that refused the turn has exactly one useful thing to
            // say, and remembering it must not depend on the projection or the
            // routing below succeeding. Remembered rather than rendered,
            // because an `error` can also arrive mid-turn on an agent that
            // recovers and answers anyway; it is promoted to a failure only
            // when the turn ends with nothing to show.
            if (event.type === "error") {
              externalErrorDetail = event.error ?? externalErrorDetail
            }
            const capture = captureEventFromCanonical(canonicalEventFromExternalEvent(event))
            if (capture) void projectDirectChatCaptureEvent(sessionId, capture)
            if (event.type === "permission_request") {
              const responseRequestId = event.request?.requestId || event.request?.id
              const nativePermissionSessionId = event.sessionId ?? event.request.sessionId
              if (
                !hostSelection &&
                nativePermissionSessionId &&
                isCogniaProjectedTool(event.request.toolInfo?.name, hostedServerNames)
              ) {
                void import("@/lib/ai/agent/external/manager")
                  .then(({ getExternalAgentManager }) =>
                    getExternalAgentManager().respondToPermission(
                      extAgentId,
                      nativePermissionSessionId,
                      toPermissionResponse("allow", {
                        agentId: extAgentId,
                        chatSessionId: sessionId,
                        externalSessionId: nativePermissionSessionId,
                        responseRequestId: responseRequestId ?? event.request.id,
                        options: event.request.options,
                      })
                    )
                  )
                  .catch((error) => {
                    void handleExternalFailure(
                      error instanceof Error ? error.message : String(error)
                    )
                  })
                return
              }
              const approval = registerExternalApproval({
                agentId: extAgentId,
                chatSessionId: sessionId,
                event,
                ...(remoteRunId && remoteApprovalDecisionId && responseRequestId
                  ? { remoteDecisionId: remoteApprovalDecisionId(remoteRunId, responseRequestId) }
                  : {}),
              })
              if (approval) store.getState().pushApproval(approval)
              return
            }
            // The other half of the same gap: a Pi `confirm` / `select` /
            // `input` / `editor` arrives as an elicitation, and it blocks the
            // agent exactly like a permission request does. It rides its own
            // store rather than `pendingApprovals` because it carries a
            // schema, not a tool call.
            if (event.type === "elicitation_request") {
              const pending = registerExternalElicitation({
                agentId: extAgentId,
                chatSessionId: sessionId,
                event,
                ...(remoteRunId && remoteApprovalDecisionId && event.request?.id
                  ? { remoteDecisionId: remoteApprovalDecisionId(remoteRunId, event.request.id) }
                  : {}),
              })
              if (pending) useExternalElicitationStore.getState().push(pending)
              return
            }
            // The agent withdrew or already resolved the question — take the
            // dialog down rather than leaving one nothing is waiting on.
            if (event.type === "elicitation_complete") {
              useExternalElicitationStore.getState().remove(sessionId, event.elicitationId)
              return
            }
            // `async_questions` is opt-in UI: off, the same event degrades
            // to a plain text part rather than rendering an answer card.
            // Read per event so a mid-turn settings flip takes effect.
            const inlineQuestions =
              useSettingsStore.getState().settings?.inlineQuestions?.enabled === true
            // An `async_questions` event with a `requestId` backs a pending
            // server request (Codex `requestUserInput` + `isBlocking:false`):
            // the card's answer must resolve that RPC, not arrive as a chat
            // message. Register the delivery target so the card can call
            // `resolveExternalQuestion` with the chat-side key stamped into
            // the part's data. Skipped when the feature is off — a degraded
            // text part has no way to resolve, so the entry would only leak —
            // and on host-lane runs, whose remote decision channel cannot
            // carry an answers map.
            const questionRequestId =
              event.type === "async_questions" && event.requestId && inlineQuestions && !remoteRunId
                ? registerExternalQuestionTarget({
                    agentId: extAgentId,
                    chatSessionId: sessionId,
                    event,
                  })
                : null
            const nextParts = applyExternalAgentEventToParts(assistantParts, event, {
              inlineQuestions,
              sessionId,
              ...(questionRequestId ? { questionRequestId } : {}),
            })
            if (nextParts !== assistantParts) {
              assistantParts = nextParts as UIMessage["parts"]
              chatTurnPerformance.markFirstResponse(sessionId)
              writeAssistant()
            }
          }

          // The model and the thinking level this turn runs on, resolved once
          // for BOTH executors.
          //
          // The model is the one the picker persisted, replayed onto whatever
          // session the agent opens next. `select()` writes it through to a
          // session that already exists, but a catalog pick made before the
          // first turn has no session to write to, and every later turn opens
          // against an agent that was never told. The row was being written
          // and never read back, so the chip showed a model the turn did not
          // run on. `resolveExternalAgentModelAxis` owns both places the choice
          // can live and the marker guard that keeps a built-in lane's model
          // out of an agent's mouth. `extAgentId` is the configuration id on
          // the host lane, which is also the id the picker stamps, so one call
          // covers both lanes.
          //
          // The thinking level reached only the built-in runtime before this.
          // On an external agent the control was silently inert. Both fields
          // carry the same resolved precedence chain (IM override, then
          // session, then bot, then app default), and the adapter folds the
          // value onto whatever ladder its model publishes.
          //
          // `requestedEffort` rather than `effort`: the latter has already been
          // through the `modelSupportsEffort` gate against the SESSION's model,
          // which this rail does not run, because the external agent brings its
          // own. Reading the gated field made the control inert again whenever
          // the session happened to sit on a model that rejects the Anthropic
          // `effort` parameter (Haiku, Sonnet 4.5), even though the agent about
          // to run it honours the level fine.
          //
          // Shared rather than written out per branch: the host-owned lane had
          // no model axis at all, so a conversation bound to a host
          // configuration ran on the agent's own default however loudly the
          // chip promised otherwise.
          //
          // `createSession` inherits the marked app default onto new rows, so
          // the app-wide half read here is the backstop for rows created
          // before that and for a default changed mid-conversation.
          const appSettings = useSettingsStore.getState().settings
          const externalModel = resolveExternalAgentModelAxis({
            agentId: extAgentId,
            sessionModel: session?.model,
            sessionProviderOverride: session?.providerOverride,
            defaultModel: appSettings?.defaultModel,
            defaultProvider: appSettings?.defaultProvider,
          })
          const externalModelAxes = {
            ...(cogniaModel !== undefined ? { cogniaModel } : {}),
            ...(externalModel ? { model: externalModel } : {}),
            ...(sendOptions.requestedEffort || sendOptions.effort
              ? { reasoningEffort: sendOptions.requestedEffort ?? sendOptions.effort }
              : {}),
          }

          const { resolvedMcpServerMapToAcpConfigs } =
            await import("@/lib/ai/agent/external/runtimes/acp/resolve-acp-mcp-servers")
          const externalMcpServers = resolvedMcpServerMapToAcpConfigs(sendOptions.mcpServers)
          let externalContinuationContext: string | undefined
          let resetExternalSession = false
          let verifiedNativeResume = false
          // A stale tool host belongs to the previous runtime, including when
          // the new target cannot host MCP and would otherwise skip cleanup.
          const previousHost = externalToolHostsRef.current.get(sessionId)
          if (previousHost && (hostSelection || previousHost.agentId !== extAgentId)) {
            await releaseExternalToolHost(sessionId)
          }
          if (!hostSelection) {
            const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
            const manager = getExternalAgentManager()
            const agentConfig = manager.getAgent(extAgentId)?.config
            const composition = compositionForSession(sessionId)
            verifiedNativeResume = Boolean(
              sessionId.startsWith("import:") &&
              composition.verifiedNativeResume &&
              composition.verifiedNativeResumeAgentId === extAgentId &&
              session?.importOwnership === "native-bound" &&
              session.importRuntimeBinding?.nativeSessionId &&
              agentConfig &&
              session?.importRuntimeBinding?.presetId === externalAgentPresetIdOf(agentConfig)
            )
            const { buildDeclaredCapabilityProfile } =
              await import("@/lib/ai/agent/external/capability/capability-profile")
            const profile =
              manager.getAgentCapabilityProfile(extAgentId, sessionId) ??
              (agentConfig
                ? buildDeclaredCapabilityProfile({ protocol: agentConfig.protocol })
                : undefined)
            if (
              agentConfig?.protocol === "dsh-sdk" &&
              managedGatewayTask &&
              session?.externalAgentSession
            ) {
              const { renderTranscript } = await import("@/lib/chat/branch-session")
              externalContinuationContext = renderTranscript(
                (await listMessages(sessionId)).filter((message) => message.id !== userMsg.id)
              )
            }
            const mcpLevel = profile?.effective.mcp.level
            if (mcpLevel === "native" || mcpLevel === "equivalent") {
              const { createRendererToolHost } =
                await import("@/lib/ai/agent/external/session/renderer-tool-host")
              let entry = externalToolHostsRef.current.get(sessionId)
              if (entry && entry.agentId !== extAgentId) {
                await releaseExternalToolHost(sessionId)
                entry = undefined
              }
              if (!entry) {
                entry = { host: createRendererToolHost(sessionId), agentId: extAgentId }
                externalToolHostsRef.current.set(sessionId, entry)
              }
              const hosted = await entry.host.start({
                sendOptions,
                signal: gatewayController?.signal,
                // DSH publishes its own broker tool calls; duplicating them here
                // would render two calls for one execution.
                onToolEvent:
                  isCapabilityUsable(profile?.effective["tools.ordinary"]?.level ?? "unknown") &&
                  isCapabilityUsable(profile?.effective["tools.results"]?.level ?? "unknown")
                    ? undefined
                    : handleExternalEvent,
                onPermissionRequest: async (request, signal) => {
                  const { awaitApproval, hasSessionBypass } =
                    await import("@/lib/connectors/hitl/approval-registry")
                  if (hasSessionBypass(sessionId, request.toolName)) return { decision: "allow" }
                  if (sendOptions.permissionMode === "auto") {
                    let automatic: { decision: "allow" | "deny"; message?: string } | undefined
                    await tryAutoModeDecision(
                      { ...request, sessionId },
                      async (decision, message) => {
                        automatic = { decision, message }
                      }
                    )
                    if (signal.aborted)
                      return { decision: "deny", message: "Tool turn was cancelled" }
                    if (automatic) return automatic
                  }
                  const pending = awaitApproval(sessionId, request.requestId, { signal })
                  store.getState().pushApproval({ ...request, sessionId, status: "pending" })
                  try {
                    return await pending
                  } finally {
                    store.getState().clearApproval(request.requestId, sessionId)
                  }
                },
              })
              const launchContextSignature = JSON.stringify({
                catalog: hosted.catalogFingerprint,
                servers: [...hosted.mcpServers, ...externalMcpServers],
                cwd: sendOptions.cwd,
                additionalDirectories: sendOptions.additionalDirectories ?? [],
                systemPrompt: sendOptions.systemPrompt,
                appendSystemPrompt: sendOptions.appendSystemPrompt,
                permissionMode: sendOptions.permissionMode,
                allowedTools: sendOptions.allowedTools,
              })
              if (
                entry.launchContextSignature &&
                entry.launchContextSignature !== launchContextSignature &&
                entry.nativeSessionId
              ) {
                await manager.closeSession(extAgentId, entry.nativeSessionId)
                if (!isCapabilityUsable(profile?.effective["session.resume"]?.level ?? "unknown")) {
                  // A protocol without resume starts a fresh native session.
                  // Preserve Cognia's transcript explicitly as task context.
                  const { renderTranscript } = await import("@/lib/chat/branch-session")
                  externalContinuationContext = renderTranscript(
                    (await listMessages(sessionId)).filter((message) => message.id !== userMsg.id)
                  )
                  resetExternalSession = true
                  entry.nativeSessionId = undefined
                }
              }
              entry.launchContextSignature = launchContextSignature
              manager.setSessionHostFacts(extAgentId, sessionId, {
                toolHostRunning: true,
                subagentDispatchProjected:
                  sendOptions.pluginTools?.some((tool) => tool.name === "dispatch_agent") ?? false,
                hookRuntimeAvailable: true,
              })
              hostedServerNames = hosted.mcpServers.map((server) => server.name)
              externalMcpServers.unshift(...hosted.mcpServers)
            }
          }
          if (!verifiedNativeResume && compositionForSession(sessionId).verifiedNativeResume) {
            // Once another runtime takes a turn the original native history no
            // longer contains the full conversation. Returning to it needs a
            // fresh contextual handoff, not the stale verification marker.
            const {
              verifiedNativeResume: _verified,
              verifiedNativeResumeAgentId: _agentId,
              ...composition
            } = compositionForSession(sessionId)
            useAgentRuntimeStore.getState().setSessionComposition(sessionId, composition)
          }
          const hostedSession = externalToolHostsRef.current.get(sessionId)
          const matchingHostedNativeSessionId =
            hostedSession?.agentId === extAgentId ? hostedSession.nativeSessionId : undefined
          const hasMatchingExternalSession =
            session?.externalAgentSession?.agentId === extAgentId ||
            !!matchingHostedNativeSessionId ||
            verifiedNativeResume
          if (
            resetExternalSession ||
            externalContinuationContext !== undefined ||
            !hasMatchingExternalSession
          ) {
            const { buildHandoffContext, prepareHandoffContext } =
              await import("@/lib/chat/handoff-context")
            const history = (await listMessages(sessionId)).filter(
              (message) => message.id !== userMsg.id
            )
            const imported = session?.importCanonicalState
            const state = imported
              ? {
                  tasks: imported.tasks,
                  plans: imported.plans,
                  goals: imported.goals,
                  checkpoints: imported.checkpoints,
                  interAgentMessages: imported.interAgentMessages,
                }
              : undefined
            const projected = buildHandoffContext(history, { state })
            if (projected.losses.some((loss) => loss.kind === "budget")) {
              const { buildAgentBackedLlmClient } =
                await import("@/lib/ai/generation/agent-backed-client")
              externalContinuationContext = (
                await prepareHandoffContext(history, {
                  state,
                  client: await buildAgentBackedLlmClient({
                    session,
                    appSettings,
                    featureId: "handoff",
                    label: "Summarize task handoff",
                  }),
                  signal: gatewayController?.signal,
                })
              ).text
            } else {
              externalContinuationContext = projected.text || undefined
            }
          } else if (!verifiedNativeResume) {
            // The agent resumes its own session, which never saw what the
            // builtin lane answered since this agent last did — an `@claude`
            // turn, or a stretch of the conversation on its own lane between
            // two `@codex` turns. Only that part of the thread is handed over.
            const unseen = unseenForeignTurns(
              selectVisibleMessages(
                (await listMessages(sessionId)).filter((message) => message.id !== userMsg.id),
                store.getState().sessions[sessionId]?.activeBranchByGroup ?? {}
              ),
              "external"
            )
            if (unseen.length > 0) {
              externalContinuationContext =
                (await foreignTurnsHandoffText(unseen, {
                  client: async () => {
                    const { buildAgentBackedLlmClient } =
                      await import("@/lib/ai/generation/agent-backed-client")
                    return buildAgentBackedLlmClient({
                      session,
                      appSettings,
                      featureId: "handoff",
                      label: "Summarize task handoff",
                    })
                  },
                  ...(gatewayController ? { signal: gatewayController.signal } : {}),
                })) || undefined
            }
          }
          // All adapters consume prompt text. The custom context field alone
          // is only understood by some runtimes and cannot carry the handoff.
          const externalExecutionPrompt = externalContinuationContext
            ? `${externalContinuationContext}\n\nCurrent user request:\n${externalSendText}`
            : externalSendText
          // The prompt is one string: images, a native video and fetched pages
          // cannot ride it. Say so instead of dropping them silently.
          warnTextOnlyOmissions("external", externalTurn.omitted, turnManifest)
          // Reuse the completed instruction pipeline, including selected skills,
          // project context and per-turn additions, on the external lane too.
          const externalSystemPrompt = [sendOptions.systemPrompt, sendOptions.appendSystemPrompt]
            .filter((section): section is string => typeof section === "string" && !!section.trim())
            .join("\n\n")

          // Two executors, one contract. `executeOnRemoteHostAgent` presents
          // the same `(prompt, { onEvent }) => ExternalAgentResult | null`
          // shape over the companion plane, so everything downstream of this
          // call — the coalescer, the parts, the failure and fallback paths —
          // is shared rather than duplicated per lane.
          const result =
            hostSelection && executeOnRemoteHostAgent && remoteRunId
              ? await executeOnRemoteHostAgent(externalExecutionPrompt, {
                  stamp: {
                    configId: hostSelection.configId,
                    revision: hostSelection.revision,
                    lifecycleGeneration: hostSelection.lifecycleGeneration,
                  },
                  chatSessionId: sessionId,
                  ...(session?.externalAgentSession?.agentId === extAgentId
                    ? { externalSessionId: session.externalAgentSession.sessionId }
                    : {}),
                  newRunId: () => remoteRunId,
                  ...externalModelAxes,
                  systemPrompt: externalSystemPrompt || undefined,
                  allowedTools: sendOptions.allowedTools,
                  mcpServers: externalMcpServers,
                  onEvent: handleExternalEvent,
                })
              : await executeOnExternalAgent(externalExecutionPrompt, {
                  agentId: extAgentId,
                  ...(gatewayController ? { signal: gatewayController.signal } : {}),
                  ...(!resetExternalSession && session?.externalAgentSession?.agentId === extAgentId
                    ? { sessionId: session.externalAgentSession.sessionId }
                    : {}),
                  ...(!resetExternalSession && matchingHostedNativeSessionId
                    ? { sessionId: matchingHostedNativeSessionId }
                    : {}),
                  // Resume the agent's own native session, but only for an
                  // import whose binding has been verified. The id comes from
                  // the session row, which is where it has always lived. The
                  // composition carries the verification decision, nothing more.
                  ...(!resetExternalSession &&
                  verifiedNativeResume &&
                  session?.importRuntimeBinding?.nativeSessionId
                    ? { sessionId: session.importRuntimeBinding.nativeSessionId }
                    : {}),
                  workingDirectory: sendOptions.cwd,
                  systemPrompt: externalSystemPrompt || undefined,
                  allowedTools: sendOptions.allowedTools,
                  ...externalModelAxes,
                  context: {
                    custom: {
                      additionalDirectories: sendOptions.additionalDirectories ?? [],
                      chatSessionId: sessionId,
                      mcpServers: externalMcpServers,
                      ...(externalContinuationContext
                        ? { conversationHistory: externalContinuationContext }
                        : {}),
                    },
                  },
                  onEvent: handleExternalEvent,
                })

          sealCoalescer()
          persistExternalSession(result?.sessionId)
          await externalSessionWrite
          if (externalSessionWriteError) throw externalSessionWriteError
          if (gatewayController?.signal.aborted) return

          if (!result) {
            await handleExternalFailure("No external agent available for this request")
            return
          }

          if (!result.success) {
            await handleExternalFailure(result.error ?? "External agent execution failed")
            return
          }

          const hasVisibleText = assistantParts.some(
            (p) => (p as { type?: string }).type === "text" && (p as { text?: string }).text
          )

          // An agent that reported an error and produced nothing did not
          // complete: it was refused, and the provider's own words are the
          // only useful thing to show. Checked before the `finalResponse`
          // fallback below, which would otherwise paint an empty string over
          // the reason. Guarded on there being no text so a turn that
          // recovered and answered is still a success.
          if (!hasVisibleText && externalErrorDetail) {
            await handleExternalFailure(externalErrorDetail)
            return
          }

          // When the event stream never produced a text track (some agents
          // only emit a single final response), fall back to the assembled
          // finalResponse to make sure the user always sees something.
          if (!hasVisibleText) {
            assistantParts = [
              ...(assistantParts as unknown as Array<Record<string, unknown>>),
              { type: "text", text: result.finalResponse, state: "done" },
            ] as unknown as UIMessage["parts"]
            chatTurnPerformance.markFirstResponse(sessionId)
            writeAssistant()
            sealCoalescer()
          }

          // Persist this session's final list. The slice already holds the
          // live writes (keyed by session), so read it back; fall back to a
          // locally-assembled list if the slice was somehow cleared.
          const finalAssistant: UIMessage = {
            id: assistantId,
            role: "assistant",
            parts: assistantParts,
            metadata: {
              ...(delegatedMeta ?? {}),
              ...(replyBranch ??= claimReplyBranch(assistantId)),
              run: { providerId: "external", startedAt: externalStartedAt },
            },
          }
          const completedAt = Date.now()
          const withRun = attachRunMetadataToLastAssistant(
            store.getState().sessions[sessionId]?.messages ?? [...baseList, finalAssistant],
            buildCompletedRunMetadata({
              providerId: "external",
              startedAt: externalStartedAt,
              completedAt,
              reportedDurationMs: result.duration,
              routing: buildRoutingRunMetadata(sendOptions),
              agent: turnAgentStamp(sessionId),
              ...(routeStamp ? { route: routeStamp } : {}),
            })
          )
          // The agent's own token accounting — including the context occupancy
          // and window size it reports (ACP `usage_update`, Codex
          // `modelContextWindow`). Without this the turn lands with no usage at
          // all and the context read-out shows an empty window for a session
          // that is anything but.
          const finalMessages = result.tokenUsage
            ? attachUsageToLastAssistant(
                withRun,
                externalTokenUsageToUsageInfo(result.tokenUsage) as unknown as Record<
                  string,
                  unknown
                >
              )
            : withRun
          store.getState().replaceSessionMessages(sessionId, finalMessages)
          chatTurnPerformance.beginFinalPersistence(sessionId)
          await persistMessages(sessionId, finalMessages)
          if (result.tokenUsage) {
            await recordExternalAgentUsage({
              sessionId,
              messageId: assistantId,
              usage: result.tokenUsage,
              model: externalModel ?? cogniaModel?.modelId,
              durationMs: result.duration,
              at: completedAt,
            }).catch((error) => console.warn("recordExternalAgentUsage failed", error))
          }
          chatTurnPerformance.endFinalPersistence(sessionId)
          if (session?.branchSeed) {
            void clearBranchSeed(sessionId).catch((error) =>
              console.error("clearBranchSeed failed", error)
            )
            if (sessionId.startsWith("import:") && session.importOwnership !== "native-bound") {
              void freezeImportedSession(sessionId).catch((error) =>
                console.error("freezeImportedSession failed", error)
              )
            }
          }
          registry.release(sessionId)
          store.getState().setSessionStatus(sessionId, "idle")
          await finishDirectChatExecutionRun(sessionId, "completed")
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
          externalTurnCompleted = true
        } catch (err) {
          if (gatewayController?.signal.aborted) return
          const error = err instanceof Error ? err : new Error(String(err))
          await handleExternalFailure(error.message, error)
        } finally {
          // A turn that wrote no reply (stopped, or failed before its first
          // frame) still has its regenerate slot and edit owner armed, and no
          // `session_ended` drops them on this lane. A sidecar fallback has
          // already armed its own by now, which this leaves alone.
          disarmBranch()
          const hosted = externalToolHostsRef.current.get(sessionId)
          if (hosted) {
            const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
            if (getExternalAgentManager().getAgent(extAgentId))
              getExternalAgentManager().setSessionHostFacts(extAgentId, sessionId, null)
          }
          await hosted?.host.pause().catch((error) => {
            console.error("external tool host pause failed", error)
          })
          if (externalGatewayAbortRef.current.get(sessionId) === gatewayController) {
            externalGatewayAbortRef.current.delete(sessionId)
          }
          // However this turn ended, the adapter's waiters are gone. An entry
          // left behind would be an unanswerable dialog pinned over the pane —
          // the approval dialog has no close button, because on the SDK path
          // closing it would orphan a live promise. Released here rather than
          // on each exit path so a throw between them cannot skip it.
          await releaseExternalDecisionSurfaces()
        }
        // A clean end replays what the user queued behind this turn — the
        // sidecar does this on `session_ended`, and without it a follow-up
        // typed on an external lane with no live steering sat queued forever.
        // After the `finally`, so the next turn cannot race this one's
        // teardown of its decision surfaces.
        if (externalTurnCompleted) {
          // Drive an in-session plan exactly as the sidecar's settle does
          // (`plan-turn-settle.ts`): mark the step done and send the next one.
          const lastAssistant = [...(store.getState().sessions[sessionId]?.messages ?? [])]
            .reverse()
            .find((message) => message.role === "assistant")
          const dispatchedNextStep = await driveInSessionPlanAfterTurn({
            sessionId,
            lastResponse: extractAssistantText(lastAssistant),
            isActiveSession: () => sessionId === activeRef.current,
            dispatchNextStep: (userMessage) =>
              void sendRef.current?.(userMessage, undefined, { skipUserAppend: true }),
          })
          // Follow-ups queued behind this turn wait for the next settle when a
          // plan step was just dispatched; two turns must never start at once.
          if (!dispatchedNextStep) drainSteerVia(sessionId, sendRef)
        }
        if (store.getState().sessions[sessionId]?.errorDiagnostic) rejectSend()
        return
      }
      // ── End external agent branch ──────────────────────────────────────

      // This turn runs on the built-in sidecar, so the session has no external
      // lane — clear any left by a previous turn before a follow-up reads it.
      setSessionExternalLane(sessionId, null)

      // Router + Fusion (ADR-0188): a run created for this turn is released when
      // the dispatch itself fails. A failure this turn already explained (a
      // refusal, the cost ceiling) carries its own diagnostic into the catch.
      let routerFusionAwaitingDispatch = false
      let explainedSendFailure: { code: string; diagnostic: CogniaDiagnostic } | null = null
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
            // The question, as `buildSendOptions`' root span previews it: an
            // eval promoted from this trace takes the preview as its input.
            inputPreview: externalTurn.request || undefined,
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
            // One shared projection (lib/routing/plan-trace-attributes) — the
            // calibration pipeline reads this shape and a hand-written copy
            // here had already drifted once.
            attributes: routingPlanTraceAttributes(plan),
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
        // Durable acceptance (ADR-0123), phase B. This is the last point at
        // which `sendOptions` is still changing — cwd, task workspace and
        // routing have all settled by now — so it is the only honest moment to
        // freeze the execution context. Write-once: on a retry the stored
        // bundle wins, which is what stops a replay from silently re-resolving
        // the project root against whatever the host looks like later.
        if (durableLeaseLost) return
        // Router + Fusion (ADR-0188): create the run of a routed turn right
        // before dispatch, after every early return above. A send without the
        // stamp — every send while the switch is off — skips this block.
        if (sendOptions.routerFusion) {
          const fusionSend = await prepareRouterFusionSend({
            sessionId,
            options: sendOptions,
            reused: Boolean(opts),
            workspaceId: session?.projectId ?? null,
            settings: useSettingsStore.getState().settings,
          })
          if (fusionSend.kind === "refused") {
            explainedSendFailure = {
              code: "router_fusion_refused",
              diagnostic: await routerFusionRefusalDiagnostic({
                code: fusionSend.code,
                reasons: fusionSend.reasons ?? [],
                sessionId,
                ...(sendOptions.spanId ? { spanId: sendOptions.spanId } : {}),
              }),
            }
            throw new RouterFusionRefusalError(
              fusionSend.code,
              "Router + Fusion refused this turn."
            )
          }
          sendOptions = fusionSend.options
          routerFusionAwaitingDispatch = Boolean(sendOptions.routerFusion)
          // The run faulted and the turn takes the original path — including
          // the cost ceiling it skipped above.
          if (!sendOptions.routerFusion && isCostBudgetConfigured()) {
            const lateBudget = await enforceCostBudget({
              ...(sendOptions.provider ? { providerId: sendOptions.provider } : {}),
              runId: executionRunId,
            })
            if (!lateBudget.allowed) {
              explainedSendFailure = {
                code: "cost_budget_exceeded",
                diagnostic: toDiagnostic(new Error("cost_budget_exceeded"), {
                  source: "chat",
                  meta: {
                    sessionId,
                    extra: { blockedBy: lateBudget.blockedBy.map((v) => v.scopeKey).join(",") },
                  },
                }),
              }
              throw new Error("cost_budget_exceeded")
            }
          }
        }
        await bindChatTurnContext({
          runId: executionRunId,
          context: {
            ...(sendOptions.cwd ? { cwd: sendOptions.cwd } : {}),
            ...(session?.projectId ? { projectId: session.projectId } : {}),
            ...(boundWorkspaceRoot ? { workspaceBindingRef: executionRunId } : {}),
            sendOptions,
          },
        })
        // Anything `project_history_search` deposited before this point belongs
        // to a turn that never landed (aborted, errored, or interrupted) — its
        // fold never ran to drain it. Clearing here rather than on the turn's
        // way out avoids racing the fold, and states the rule plainly: a turn
        // cites only what THIS turn read.
        clearProjectHistoryEvidence(sessionId)
        // Cache finalized options before dispatch. A host can settle the turn
        // inside the awaited dispatch, and turnComplete reads this exact row to
        // persist pre-search sources on the assistant reply.
        useChatStore.getState().setLastSend(sessionId, {
          content: effectiveContent,
          options: sendOptions,
          attemptIndex: 0,
          routingCommitted: false,
          ...(routeStamp ? { routeStamp } : {}),
        })
        // Armed BEFORE the dispatch, not after it. `sendPrompt` is awaited, and
        // a turn can settle inside that await (the host rejects the prompt, an
        // error or `sidecar_exited` frame is processed). The store subscription
        // that disarms only walks `watchdog.armed()`, so arming afterwards meant
        // the settle found nothing to disarm and the clock then ran against an
        // already-idle session — surfacing "the turn has gone silent" 90 seconds
        // later on a conversation that had finished. Arming first puts the
        // session in `armed()` before any frame can arrive.
        silenceWatchdogRef.current?.arm(sessionId)
        if (standaloneEngineTurn) {
          // Standalone (BYOK): run the turn in-renderer against the user's own
          // provider. Fire-and-forget like `sendPrompt` — streaming reaches the
          // store via the same event queue; the engine emits `session_ended`.
          const controller = new AbortController()
          abortStaleLocalRuntime = () => controller.abort()
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
          if (
            (sendOptions.execution?.runtimeAdapter ??
              (sendOptions.provider === "anthropic" || !sendOptions.provider
                ? "claude-agent-sdk"
                : "ai-sdk")) === "claude-agent-sdk"
          ) {
            const { sdkSessionStorageFromOptions } = await import("@/lib/claude/claude-sdk-rollout")
            await updateSession(sessionId, {
              sdkSessionStorage: sdkSessionStorageFromOptions(sendOptions),
            })
          }
          chatTurnPerformance.markDispatched(sessionId)
          if (dispatchClaim === "claimed") {
            await sendPrompt(sessionId, effectiveContent, sendOptions, {
              commandId: chatSubmissionId(executionRunId),
            })
          } else {
            await sendPrompt(sessionId, effectiveContent, sendOptions)
          }
        }
        // The host owns the turn now; its `session_ended` seals the run.
        routerFusionAwaitingDispatch = false
        if (durableLeaseLost) return
        // The live handoff won this turn. Recording it keeps the periodic
        // pending-work sweep from dispatching the same accepted input again.
        await markChatTurnStarted(executionRunId)
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
          if (sessionId.startsWith("import:") && session.importOwnership !== "native-bound") {
            void freezeImportedSession(sessionId).catch((err) =>
              console.error("freezeImportedSession failed", err)
            )
          }
        }
        // Least-busy signal: this turn is now in flight against the resolved
        // deployment; `session_ended` (any flavor) settles it.
        if (sendOptions.provider) {
          useInFlightStore
            .getState()
            .begin(sessionId, sendOptions.provider, { modelId: sendOptions.model })
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        const sendFailureCode = explainedSendFailure?.code ?? "send_failed"
        if (routerFusionAwaitingDispatch) {
          await abortRouterFusionSend(sessionId, sendOptions, error.message)
        }
        store.getState().setSessionDiagnostic(
          sessionId,
          explainedSendFailure?.diagnostic ??
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
            errorType: sendFailureCode,
            errorMessage: error.message,
          })
        }
        chatTurnPerformance.finish(sessionId, "failed")
        await finishDirectChatExecutionRun(sessionId, "failed", Date.now(), error.message)
        await settleChatTurnForSession(sessionId, {
          outcome: "failed",
          errorCode: sendFailureCode,
        })
        stopAssemblyHeartbeat()
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
        rejectSend(error)
      }
    },
    [
      store,
      tRouting,
      tInlineErr,
      tDiagnostics,
      tVideo,
      tCollab,
      warnTextOnlyOmissions,
      registry,
      releaseExternalToolHost,
      enqueueClaudeEvent,
      getExecutionHandle,
      executionHandleDirectory,
    ]
  )

  // Keep the module-scope `handleEvent` pointed at the latest `send` so it can
  // dispatch a silent goal continuation (ADR-0019) without closing over it.
  useEffect(() => {
    sendRef.current = send
    return () => {
      if (sendRef.current === send) sendRef.current = null
    }
  }, [send])

  useEffect(() => {
    const inFlight = new Set<string>()
    const pendingDrains = new Set<string>()
    const pendingPulses = new Set<string>()
    let disposed = false
    const request = async (event: Event) => {
      const detail = (
        event as CustomEvent<{ sessionId: string; messageId?: string; takeover?: boolean }>
      ).detail
      if (!detail?.sessionId || disposed) return
      if (inFlight.has(detail.sessionId)) {
        if (event.type === "cognia:shared-queue-updated") pendingPulses.add(detail.sessionId)
        return
      }
      inFlight.add(detail.sessionId)
      try {
        const target = await getSession(detail.sessionId)
        if (!target?.collaboration) return
        const { resolveCurrentCollabContext } = await import("@/lib/collab/runtime-client")
        const context = await resolveCurrentCollabContext()
        if (
          !context ||
          context.orgId !== target.collaboration.orgId ||
          (target.collaboration.endpoint &&
            target.collaboration.endpoint !== context.client.baseUrl)
        )
          return
        const { syncSharedSession } = await import("@/lib/collab/shared-chat-sync")
        const synced = await syncSharedSession(
          context.client,
          context.orgId,
          target.collaboration.sessionId
        )
        const { getDb } = await import("@/lib/db/schema")
        const messages = await getDb()
          .messages.where("sessionId")
          .equals(detail.sessionId)
          .toArray()
        if (detail.messageId) {
          const message = messages.find((candidate) => candidate.id === detail.messageId)
          if (!message || message.role !== "user") return
          const remoteId = message.collaboration?.remoteMessageId ?? message.id
          await context.client.enqueueSessionRunInput(
            context.orgId,
            target.collaboration.sessionId,
            {
              payload: { messageId: remoteId },
              operationId: `ai-request:${crypto.randomUUID()}`,
            }
          )
        }
        const slice = useChatStore.getState().sessions[detail.sessionId]
        if (slice?.status === "streaming" || slice?.status === "awaiting_approval") {
          if (!detail.messageId) pendingDrains.add(detail.sessionId)
          return
        }
        const [next] = await context.client.listSessionRunQueue(
          context.orgId,
          target.collaboration.sessionId
        )
        if (!next) return
        if (event.type === "cognia:shared-queue-updated") {
          const { getDeviceId } = await import("@/lib/device/device-identity")
          if (
            !(await canAutomaticallyDrainSharedQueue(
              context,
              target.collaboration.sessionId,
              Math.max(
                synced?.cursor ?? target.collaboration.syncCursor,
                Number(next.payload.contextSequence)
              ),
              await getDeviceId()
            ))
          )
            return
        }
        const messageId = String(next.payload.messageId)
        const message = messages.find(
          (candidate) => (candidate.collaboration?.remoteMessageId ?? candidate.id) === messageId
        )
        if (!message) return
        const content = await sharedRequestTranscript(
          context.client,
          context.orgId,
          target.collaboration.sessionId,
          Number(next.payload.contextSequence)
        )
        if (!isStandaloneChatMode()) await closeSession(detail.sessionId)
        await sendRef.current?.(content, undefined, {
          sessionId: detail.sessionId,
          skipUserAppend: true,
          sharedRequest: { messageId, queueItemId: next.id, takeover: detail.takeover },
        })
      } catch (error) {
        useChatStore
          .getState()
          .setSessionDiagnostic(
            detail.sessionId,
            toDiagnostic(error, { source: "chat", meta: { sessionId: detail.sessionId } })
          )
      } finally {
        inFlight.delete(detail.sessionId)
        if (pendingPulses.delete(detail.sessionId) && !disposed) {
          queueMicrotask(() =>
            listener(
              new CustomEvent("cognia:shared-queue-updated", {
                detail: { sessionId: detail.sessionId },
              })
            )
          )
        }
      }
    }
    const listener = (event: Event) => {
      void request(event)
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      for (const sessionId of pendingDrains) {
        if (state.sessions[sessionId]?.status !== "idle") continue
        pendingDrains.delete(sessionId)
        queueMicrotask(() =>
          listener(new CustomEvent("cognia:shared-queue-updated", { detail: { sessionId } }))
        )
      }
    })
    window.addEventListener("cognia:shared-queue-updated", listener)
    window.addEventListener("cognia:shared-request-ai", listener)
    window.addEventListener("cognia:shared-run-completed", listener)
    return () => {
      unsubscribe()
      disposed = true
      window.removeEventListener("cognia:shared-queue-updated", listener)
      window.removeEventListener("cognia:shared-request-ai", listener)
      window.removeEventListener("cognia:shared-run-completed", listener)
    }
  }, [])

  // Background-run result delivery: register the hook's send as the replay
  // channel, and drain pending results whenever a session (re)opens idle —
  // covers relaunches (journaled pending rows) and panes closed at settle.
  useEffect(() => {
    return registerBackgroundReplaySend((framedText, sessionId) => {
      void sendRef.current?.(framedText, undefined, { sessionId })
    })
  }, [])

  // Same bridge for surfaces that answer the agent with an ordinary user
  // message — currently the inline async-question card (`data-async-questions`
  // parts). One registration covers every session: the callback carries the
  // target sessionId.
  useEffect(() => {
    return registerChatSendBridge((text, targetSessionId) => {
      void sendRef.current?.(text, undefined, { sessionId: targetSessionId })
    })
  }, [])

  // Retry for a transcript row that records a turn which never ran (see
  // `lib/chat/turn-admission.ts`). The row's turn is the session's last user
  // message, which is exactly what `regenerate` re-issues.
  const regenerateRef = useRef<((sessionId: string) => Promise<void>) | null>(null)
  useEffect(() => {
    return registerChatRetryBridge((targetSessionId) => {
      useChatStore.getState().setSessionError(targetSessionId, null)
      void regenerateRef.current?.(targetSessionId)
    })
  }, [])

  useEffect(
    () =>
      registerSessionPeerRuntime({
        isReachable: isSessionOpen,
        getStatus: sessionStatusOf,
        deliver: async (peerMessage) => {
          const sender = await getSession(peerMessage.senderSessionId)
          if (!sender) throw new Error(`Sender session ${peerMessage.senderSessionId} was removed`)
          const current =
            useChatStore.getState().sessions[peerMessage.receiverSessionId]?.messages ??
            (await listMessages(peerMessage.receiverSessionId))
          const inbound = buildSessionPeerInboundMessage(peerMessage, sender)
          if (!current.some((message) => message.id === inbound.id)) {
            const next = [...current, inbound]
            useChatStore.getState().setSessionMessages(peerMessage.receiverSessionId, next)
            await persistMessages(peerMessage.receiverSessionId, next)
          }
          if (peerMessage.intent === "trigger_turn") {
            const activeSend = sendRef.current
            if (!activeSend) throw new Error("Chat send runtime is unavailable")
            const modelPrompt = renderSessionPeerModelPrompt(peerMessage, sender)
            if (!hasNoLeakingPiiDeep(modelPrompt)) {
              throw new Error("Session peer prompt rejected by the renderer PII gate")
            }
            await activeSend(modelPrompt, undefined, {
              sessionId: peerMessage.receiverSessionId,
              skipUserAppend: true,
            })
          }
        },
      }),
    []
  )
  const openSessionIdsForDrain = useChatStore((s) => s.openSessionIds)
  const paneIdsForDrain = useChatStore((s) => s.paneIdsBySession)
  useEffect(() => {
    void expireSessionPeerMessages().catch(() => undefined)
    const reachable = new Set([...openSessionIdsForDrain, ...Object.keys(paneIdsForDrain ?? {})])
    for (const sessionId of reachable) {
      maybeDrainBackgroundResults(sessionId)
      void drainSessionPeerMessages(sessionId).catch(() => undefined)
    }
  }, [openSessionIdsForDrain, paneIdsForDrain])

  // Self-paced /loop kick-off: when the runtime creates or resumes a loop
  // for a reachable session, dispatch its next iteration silently — the same
  // skipUserAppend path as every later continuation, so the send never trips
  // the fresh-user-message preempt above.
  useEffect(() => {
    const unsub = getLoopRuntime().onKickoff((loop) => {
      if (!isSessionOpen(loop.sessionId)) return
      void sendRef.current?.(renderLoopIterationMessage(loop), undefined, {
        sessionId: loop.sessionId,
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
      let hostStateAbortQueued = false
      try {
        hostStateAbortQueued = Boolean(
          await enqueueHostStateIntentIfAvailable({
            sessionId,
            action: { kind: "turn.abort" },
          })
        )
      } catch (error) {
        store
          .getState()
          .setSessionDiagnostic(
            sessionId,
            toDiagnostic(error, { source: "chat", meta: { sessionId } })
          )
        return
      }
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
      const finishRun = Promise.all([
        finishDirectChatExecutionRun(sessionId, "cancelled"),
        settleChatTurnForSession(sessionId, { outcome: "cancelled" }),
        // A ledgered turn stops granting model calls at once (ADR-0188); the
        // turn's `session_ended` seals the run. A no-op for any other turn.
        cancelRouterFusionTurn(sessionId),
        // A cascade or panel run is cancelled and its calls aborted (B3).
        stopFusionChatTurn(sessionId, useSettingsStore.getState().settings, {
          settled: true,
        }).catch((error) => console.warn("router-fusion chat run stop failed", error)),
      ])

      try {
        // Standalone (BYOK) turns are cancelled by aborting the renderer
        // streamText loop; the engine then emits its own `session_ended`. The
        // sidecar path interrupts the host instead. The follow-up
        // `session_ended` remains idempotent with the optimistic local seal.
        const standaloneController = standaloneAbortRef.current.get(sessionId)
        const gatewayController = externalGatewayAbortRef.current.get(sessionId)
        if (hostStateAbortQueued) {
          // Durable HostState action owns the interrupt; the runner retries it
          // with the same action id after reconnect.
        } else if (gatewayController) {
          gatewayController.abort()
        } else if (standaloneController) {
          standaloneController.abort()
          standaloneAbortRef.current.delete(sessionId)
        } else {
          const handle = getExecutionHandle(sessionId)
          if (handle) await handle.interrupt()
          else await interruptSession(sessionId)
        }
      } catch (err) {
        console.error("interrupt failed", err)
      }
      await finishRun
    },
    [store, registry, getExecutionHandle]
  )

  // "Interrupt & steer now": cut the running turn short so its settle replays
  // the queued steer immediately, instead of waiting for the turn to finish.
  // Arming covers the case where the abort surfaces as an errored
  // `session_ended`. No-op when nothing is queued.
  const interruptAndSteer = useCallback(
    async (targetSessionId?: string) => {
      const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return
      const queued = useChatStore.getState().sessions[sessionId]?.steerQueue ?? []
      if (queued.length === 0) return
      steerArmed.add(sessionId)
      try {
        const gatewayController = externalGatewayAbortRef.current.get(sessionId)
        if (gatewayController) {
          gatewayController.abort()
          return
        }
        if (fusionChatTurnActive(sessionId)) {
          // A verified run has no live input: stop it, and its settle replays
          // the queue.
          await stopFusionChatTurn(sessionId, useSettingsStore.getState().settings, {
            settled: false,
          })
          return
        }
        const handle = getExecutionHandle(sessionId)
        if (handle) await handle.interrupt()
        else await interruptSession(sessionId)
        await cancelRouterFusionTurn(sessionId)
      } catch (err) {
        console.error("interrupt(steer) failed", err)
        steerArmed.delete(sessionId)
      }
    },
    [getExecutionHandle]
  )

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
      if (approval.suppressAlwaysAllowRule && decision === "allow_always") decision = "allow"
      const authorized = await authorizeSharedSessionApproval(approval, decision)
      if (authorized === null) return
      decision =
        approval.suppressAlwaysAllowRule && authorized === "allow_always" ? "allow" : authorized
      {
        const { RENDERER_TOOL_HOST_APPROVAL_PREFIX } =
          await import("@/lib/ai/agent/external/session/renderer-tool-host")
        if (approval.requestId.startsWith(RENDERER_TOOL_HOST_APPROVAL_PREFIX)) {
          const { resolveApproval, grantSessionBypass } =
            await import("@/lib/connectors/hitl/approval-registry")
          if (decision === "allow_always") grantSessionBypass(approval.sessionId, approval.toolName)
          resolveApproval(approval.sessionId, approval.requestId, { decision })
          await recordChatToolApprovalDecision(approval, decision)
          store.getState().clearApproval(approval.requestId, approval.sessionId)
          return
        }
      }
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
      // External agent approvals. Same in-renderer contract as the two
      // branches above: there is no sidecar-side waiter, so these ids must
      // never reach `approveTool`. The answer goes to the adapter that asked,
      // addressed by the agent + session recorded when the request arrived —
      // not by the pane the user happens to be looking at now.
      //
      // `allow_always` also stops here rather than falling through: the code
      // below writes `toolRules` / `alwaysAllowTools`, both of which are read
      // by the SIDECAR. An external agent never talks to it, so the grant
      // would be recorded and then ignored forever, and the agent would keep
      // asking. The remembered choice travels in the agent's own protocol
      // instead (see `toPermissionResponse`).
      {
        const {
          isExternalAgentApprovalRequestId,
          resolveExternalApproval,
          getExternalApprovalTarget,
        } = await import("@/lib/ai/agent/external/session/chat-decision-bridge")
        if (isExternalAgentApprovalRequestId(approval.requestId)) {
          try {
            // Where the agent actually is decides how the answer travels. A
            // host-run agent has no adapter in this shell to hand a response
            // to, so it goes back as an RPC; everything else about the entry —
            // the card, the decision, the bookkeeping below — is the same.
            const remoteDecisionId = getExternalApprovalTarget(approval.requestId)?.remoteDecisionId
            const respond = remoteDecisionId
              ? async () => {
                  const { resolveRemotePermission } =
                    await import("@/lib/ai/agent/external/runtimes/remote/remote-run-client")
                  const outcome = await resolveRemotePermission(remoteDecisionId, decision)
                  // `wrong-device` cannot happen for the client that started
                  // the run, and `unknown` means the host already decided (the
                  // 120s auto-deny, or the run settled). Either way there is
                  // nothing left to wait for, so the card comes down.
                  if (!outcome.resolved && outcome.reason === "wrong-device") {
                    throw new Error("This device is not the one that was asked.")
                  }
                }
              : async (
                  agentId: string,
                  agentSessionId: string,
                  response: import("@/types/agent/external-agent").AcpPermissionResponse
                ) => {
                  const { getExternalAgentManager } =
                    await import("@/lib/ai/agent/external/manager")
                  await getExternalAgentManager().respondToPermission(
                    agentId,
                    agentSessionId,
                    response
                  )
                }
            const answered = await resolveExternalApproval(approval.requestId, decision, respond)
            // An unknown id means the turn already released it (the adapter is
            // gone). Clear the card rather than leaving a dialog the user
            // cannot dismiss.
            if (answered) await recordChatToolApprovalDecision(approval, decision)
          } catch (error) {
            // Leave the approval mounted so the operator can retry; the agent
            // is still waiting.
            store.getState().setSessionDiagnostic(
              approval.sessionId,
              toDiagnostic(error, {
                source: "external-agent",
                meta: {
                  sessionId: approval.sessionId,
                  extra: { requestId: approval.requestId },
                },
              })
            )
            return
          }
          store.getState().clearApproval(approval.requestId, approval.sessionId)
          return
        }
      }
      // Remember a refusal for the rest of this conversation. Without this a
      // "Deny" bought nothing: the same call asked again next turn, and any
      // widening in between (a new always-allow, a broader rule in Settings)
      // would start auto-approving the very thing the user just refused.
      if (decision === "deny") {
        const { rememberDenial } = await import("@/lib/claude/permissions/session-denials")
        rememberDenial(approval.sessionId, approval.toolName, approval.input)
      }
      // Persist the always-allow choice. Prefer a TARGET-SCOPED rule
      // (`Bash(git status)`, `Read(/path/x)`) so the grant is precise and
      // future matching calls auto-resolve via the sidecar ruleset — falling
      // back to a coarse tool-NAME grant only when no useful target can be
      // extracted.
      //
      // The scope is the action the user READ, never its family: the example
      // here used to say `Bash(git *)`, and so did the derivation, which meant
      // approving `git status` also bought `git push --force` forever. See
      // `deriveAllowRuleFromApproval` — a family grant is now something the
      // user authors deliberately in Settings, not something a click arrives at.
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
        if (!approval.suppressAlwaysAllowRule && isComputerUsePluginToolName(approval.toolName)) {
          const { recordSessionGrant } = await import("@/lib/claude/computer-use-session-grants")
          recordSessionGrant(approval.sessionId, approval.toolName)
        }
      }
      try {
        const queued = await enqueueHostStateIntentIfAvailable({
          sessionId: approval.sessionId,
          action: {
            kind: "approval.respond",
            requestId: approval.requestId,
            decision,
          },
        })
        if (queued) {
          store.getState().clearApproval(approval.requestId, approval.sessionId)
          return
        }
      } catch (error) {
        store.getState().setSessionDiagnostic(
          approval.sessionId,
          toDiagnostic(error, {
            source: "chat",
            meta: {
              sessionId: approval.sessionId,
              extra: { requestId: approval.requestId },
            },
          })
        )
        return
      }
      const handle = getExecutionHandle(approval.sessionId)
      if (handle) {
        await handle.resolvePermission(approval.requestId, decision)
      } else {
        await approveTool(
          approval.sessionId,
          approval.requestId,
          decision === "allow_always" ? "allow" : decision
        )
      }
      // The receipt asserts the backend received the decision, so it is written
      // only after either dispatch path succeeds. A failure leaves the approval
      // mounted and pending, allowing the operator to retry.
      await recordChatToolApprovalDecision(approval, decision)
      // Scope the clear to the approval's own session so resolving a gate in
      // one pane never disturbs another pane's pending queue.
      store.getState().clearApproval(approval.requestId, approval.sessionId)
    },
    [store, getExecutionHandle]
  )

  useEffect(() => {
    sharedApprovalResponseRef.current = respondToApproval
    return () => {
      sharedApprovalResponseRef.current = null
    }
  }, [respondToApproval])

  const close = useCallback(
    async (sessionId: string) => {
      const handle = getExecutionHandle(sessionId)
      try {
        const gatewayController = externalGatewayAbortRef.current.get(sessionId)
        if (gatewayController) gatewayController.abort()
        else if (handle) await handle.cancel()
        else await closeSession(sessionId)
      } catch (err) {
        console.error("close session failed", err)
      } finally {
        // Tear down this session's pane state: cancel its coalescing, drop its
        // streaming mirror, and remove its store slice / tab.
        chatTurnPerformance.finish(sessionId, "cancelled")
        registry.release(sessionId)
        messagesMirrorRef.current.delete(sessionId)
        executionHandlesRef.current.delete(sessionId)
        executionHandleDirectory.unregister(sessionId, handle)
        await releaseExternalToolHost(sessionId).catch((error) => {
          console.error("external tool host close failed", error)
        })
        useChatStore.getState().closeSession(sessionId)
        clearSessionGrants(sessionId)
        const { clearSessionBypass } = await import("@/lib/connectors/hitl/approval-registry")
        clearSessionBypass(sessionId)
        releaseSkillLoadContext(sessionId)
        // Drop this session's nested-dispatch state (budget guard + resolved
        // permission ceiling) so neither leaks for the renderer's lifetime. Both
        // are keyed by session id and kept alive across a turn's multiple
        // dispatch_agent calls, so teardown is the only safe release point.
        const { releaseDispatchStateForSession } =
          await import("@/lib/claude/agents/dispatch-agent-handler")
        releaseDispatchStateForSession(sessionId)
      }
    },
    [registry, getExecutionHandle, executionHandleDirectory, releaseExternalToolHost]
  )

  const compact = useCallback(
    async (sessionId: string) => {
      const handle = getExecutionHandle(sessionId)
      if (handle) await handle.compact()
      else await compactSession(sessionId)
    },
    [getExecutionHandle]
  )

  const setModel = useCallback(
    async (sessionId: string, model: string) => {
      const handle = getExecutionHandle(sessionId)
      if (handle) await handle.setModel(model)
      else await setSessionModel(sessionId, model)
    },
    [getExecutionHandle]
  )

  const resetRuntime = useCallback(
    async (sessionId: string) => {
      const handle = getExecutionHandle(sessionId)
      try {
        if (handle) await handle.cancel()
        else await closeSession(sessionId)
      } finally {
        executionHandlesRef.current.delete(sessionId)
        executionHandleDirectory.unregister(sessionId, handle)
      }
    },
    [getExecutionHandle, executionHandleDirectory]
  )

  const rewindFiles = useCallback(
    async (sessionId: string, checkpointId: string, dryRun: boolean) => {
      const handle = getExecutionHandle(sessionId)
      if (!handle) throw new Error("checkpoint execution handle is unavailable")
      const result = await handle.rewindFiles(checkpointId, { dryRun })
      if (!dryRun) {
        await refreshGitStatus(useGitStore.getState().rootDir).catch(() => undefined)
      }
      return result
    },
    [getExecutionHandle]
  )

  /** Name the files an edit or a regenerate could not send again. */
  const warnNotResent = useCallback(
    (filenames: readonly string[]) => {
      if (filenames.length === 0) return
      toast.warning(
        tAttachments("notResent", { count: filenames.length, names: filenames.join(", ") })
      )
    },
    [tAttachments]
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
   *
   * The edit resends the original's files, as other chat apps keep a message's
   * attachments when it is edited. Every edit surface drafts the typed text
   * alone, so plain-text `newContent` takes the files from the original row
   * (`resendableAttachments`). No edit surface offers to remove them. A file
   * the row cannot send again is named to the user rather than dropped
   * silently.
   *
   * A caller that builds the blocks itself passes `attachmentManifest` for the
   * leading attachment blocks of `newContent`, as `send`'s option of the same
   * name, and decides the files itself. Without the manifest, the first file's
   * extracted text would be read as the question: its `@handle`, the envelope
   * carried onto it, and everything `send` reads from the typed block.
   */
  const editAndResend = useCallback(
    async (
      messageId: string,
      newContent: SendContent,
      targetSessionId?: string,
      resourceContext?: string,
      attachmentManifest?: readonly AttachmentManifestEntry[]
    ) => {
      const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return
      // Mid-turn this send would land as a steer — and a steer never consumes
      // `branchTag`, leaving the group `tagEditSibling` is about to persist
      // with no replacement variant. Surfaces disable the affordance; this is
      // the backstop for draft submits racing a turn start. A turn still
      // waiting for admission counts as live too: it has not flipped the
      // status yet, and re-issuing it would queue the same turn twice.
      const st = sessionStatusOf(sessionId)
      if (st === "streaming" || st === "awaiting_approval" || isChatTurnQueued(sessionId)) return
      // Rebuilding the branch base invalidates this session's streaming mirror;
      // drop it (and pending coalescing work) so the rebuilt base wins.
      registry.release(sessionId)
      messagesMirrorRef.current.delete(sessionId)

      const messages = store.getState().sessions[sessionId]?.messages ?? []
      const editedIdx = messages.findIndex((m) => m.id === messageId)
      if (editedIdx < 0) return

      const edited = messages[editedIdx]
      // The original's files go with a plain-text edit, read from its row
      // before anything is tagged.
      let editedContent: SendContent = newContent
      let editedManifest = attachmentManifest
      let notResent: string[] = []
      if (typeof newContent === "string" && !attachmentManifest?.length) {
        const { resendableAttachments } = await import("@/lib/chat/attachments/resend")
        const carried = await resendableAttachments(edited.parts)
        notResent = carried.unavailable
        if (carried.blocks.length > 0) {
          editedContent = newContent.trim()
            ? [...carried.blocks, { type: "text", text: newContent }]
            : carried.blocks
          editedManifest = carried.manifest
        }
      }
      // The edit is the question again, so its leading `@handle` is read again:
      // adding, changing or removing it re-routes the resend. Resolved BEFORE
      // the original is tagged as a sibling, so a route that cannot run leaves
      // the thread exactly as it was.
      let turnRoute: TurnRoute | null = null
      const attachmentCount = editedManifest?.length ?? 0
      const editedTyped = stripPromptPreamble(userPromptText(editedContent, attachmentCount))
      if (/^\s*@/.test(editedTyped)) {
        const editedSession = await getSession(sessionId)
        if (isRoutableSession(editedSession)) {
          const snapshot = await snapshotRouteContext(sessionId, { session: editedSession ?? null })
          const parsed = parseLeadingRoute(editedTyped, snapshot.targets)
          if (parsed) {
            const lane = resolveRouteLane(parsed.route.target, snapshot)
            if (!lane.ok) {
              store.getState().setSessionDiagnostic(
                sessionId,
                createDiagnostic("turnRouteUnavailable", {
                  source: "chat",
                  ...(lane.detail ? { message: lane.detail } : {}),
                  meta: { sessionId, extra: { handle: parsed.route.handle, reason: lane.reason } },
                })
              )
              return
            }
            turnRoute = parsed.route
          }
        }
      }
      const { merged, groupId, nextIndex } = tagEditSibling(messages, editedIdx)
      store.getState().replaceSessionMessages(sessionId, merged)
      await persistMessages(sessionId, merged)

      // Every edit surface drafts from the typed text, so the context envelope
      // the question was originally sent with — and the citations it made —
      // are carried over from the original row. Passing the citations (even
      // an empty list) also stops the send path from reading whatever chips
      // happen to be staged in the composer right now.
      const promptPreamble = readPromptPreambleSummary(edited.metadata)
      warnNotResent(notResent)
      await send(carryPromptPreamble(edited.parts, editedContent, attachmentCount), undefined, {
        sessionId,
        ...(editedManifest?.length ? { attachmentManifest: editedManifest } : {}),
        citations: chipCitationsOf(edited.metadata),
        ...(promptPreamble ? { promptPreamble } : {}),
        resourceContext: resourceContext ?? lastResourceContextRef.current.get(sessionId),
        // The replacement is a *user* message, created inside `send` itself,
        // so it is tagged there rather than through the assistant-event path
        // `regenerate` uses.
        branchTag: { groupId, index: nextIndex },
        ...(turnRoute ? { turnRoute } : {}),
      })
    },
    [send, store, registry, warnNotResent]
  )

  /**
   * Re-issue the most recent user turn. Drops the assistant reply that
   * followed it (and anything after) and resends the original content.
   */
  const regenerate = useCallback(
    async (targetSessionId?: string, resourceContext?: string) => {
      const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return

      // Regenerate bypasses the steer gate via `skipUserAppend`, so mid-turn
      // it would re-enter the normal send path — restarting the sidecar and
      // silently dropping the live turn's context (see the send-gate comment).
      // Surfaces disable the affordance; this is the backstop. A turn parked
      // waiting for admission is live as well (its status is still idle):
      // regenerating it would queue a second copy of the same turn.
      const st = sessionStatusOf(sessionId)
      if (st === "streaming" || st === "awaiting_approval" || isChatTurnQueued(sessionId)) return

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
      // A turn addressed with `@codex` is regenerated on Codex again, not on
      // whatever the conversation is on now. A route that can no longer run
      // (the agent disabled since, the member removed) is refused by `send`
      // like every other refusal: before `regenerateBranch` touches the thread.
      const turnRoute = readTurnRoute(anchor.metadata)

      // The turn goes again as it was sent. The cache holds exactly that for
      // the turn this controller last sent; any other (one sent before a
      // reload, or from another surface) is rebuilt from its own row, files
      // included, with the manifest that keeps them from reading as the
      // question.
      const cached = lastUserContentRef.current.get(sessionId)
      let content: SendContent
      let manifest: readonly AttachmentManifestEntry[] | undefined
      if (cached?.messageId === anchor.id) {
        content = cached.content
        manifest = cached.manifest
      } else {
        const { resendableUserTurn } = await import("@/lib/chat/attachments/resend")
        const rebuilt = await resendableUserTurn(anchor.parts)
        content = rebuilt.content
        manifest = rebuilt.manifest
        warnNotResent(rebuilt.unavailable)
      }
      await send(content, undefined, {
        skipUserAppend: true,
        sessionId,
        ...(manifest?.length ? { attachmentManifest: manifest } : {}),
        resourceContext: resourceContext ?? lastResourceContextRef.current.get(sessionId),
        // The replies become siblings, and the next one's slot is armed, only
        // once the send has passed every gate that can refuse it.
        regenerateBranch: { anchorId: anchor.id },
        ...(turnRoute ? { turnRoute } : {}),
      })
    },
    [send, registry, warnNotResent]
  )
  useEffect(() => {
    regenerateRef.current = regenerate
  }, [regenerate])

  return {
    send,
    stop,
    interruptAndSteer,
    flushSteer,
    respondToApproval,
    compact,
    setModel,
    resetRuntime,
    rewindFiles,
    close,
    editAndResend,
    regenerate,
  }
}
