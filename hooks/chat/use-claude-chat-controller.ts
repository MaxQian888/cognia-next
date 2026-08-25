"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import type { UnlistenFn } from "@tauri-apps/api/event"
import { makeUserMessage } from "@/lib/claude/adapter"
import { toast } from "sonner"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { createDiagnostic } from "@cognia/diagnostics"
import { resolveTurnSquad } from "@/lib/ai/agent/team/resolve-turn-squad"
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
  sessionExternalLane,
  sessionStatusOf,
  setSessionExternalLane,
  setSteerMessageState,
  steerArmed,
} from "./steer-runtime"
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
import {
  attachRunMetadataToLastAssistant,
  buildCompletedRunMetadata,
} from "@/lib/chat/message-run-metadata"
import {
  maybeDrainBackgroundResults,
  registerBackgroundReplaySend,
} from "./background-result-runtime"
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
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { useInFlightStore } from "@/stores/settings/in-flight-store"
import { endSpan, recordEvent, startSpan } from "@cognia/agent-trace/emitter"
import { toTraceparent } from "@/lib/agent-trace/trace-context"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"
import { beginCodeAdoptionTurn } from "@/lib/code-adoption/client"
import { markTaskWorkspaceTurnCancelled } from "@/lib/code-adoption/turn-tracker"
import { acquireWorkspaceBundle, runIdForTurn, taskIdForMessage } from "@/lib/task-workspace/client"
import { sandboxSessionRuntime } from "@/lib/sandbox/session-runtime"
import {
  finishDirectChatExecutionRun,
  projectDirectChatCaptureEvent,
  startDirectChatExecutionRun,
} from "@/lib/execution/direct-chat-run"
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
import { buildChatMentionTargets } from "@/lib/claude/agents/chat-mention-targets"
import { resolveMentions } from "@/lib/chat/mentions/resolve-mentions"
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
} from "@cognia/agent-config-types"
import {
  selectComposerEphemeralSkillIds,
  selectComposerPendingCommandOverrides,
  useChatStore,
} from "@/stores/chat"
import { getExecutionBroker } from "@/lib/execution/broker"
import { slotKeyForTurn } from "@/lib/execution/slot-key"
import { resolveEffectiveCwdForSession } from "@/hooks/chat/use-effective-cwd"
import { acquireChatLease } from "@/lib/execution/chat-lease"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import {
  selectSessionSubagents,
  applySubagentsToMessages,
  subagentSignature,
} from "@/lib/claude/subagent-bridge"
import { useSettingsStore } from "@/stores/settings"
import { useProjectStore } from "@/stores/project/project-store"
import { useAgentRuntimeStore, useExternalAgentStore } from "@/stores/agent"
import { isTauri } from "@/lib/tauri"
import { isCapacitor } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { chatTurnPerformance } from "@/lib/perf/chat-turn-performance"
import { enforceCostBudget, isCostBudgetConfigured } from "@/lib/usage/cost-budget-gate"
import type { UIMessage } from "ai"
import { registerInteractiveWorkSubmissionEvents } from "@/lib/work-submission/terminal-events"
import {
  behaviorTurnStartedAt,
  finishBehaviorTurn,
  isComputerUsePluginToolName,
} from "./claude-chat-tool-hooks"
import { applyInstantTitle, clearPendingLoopContinuation } from "./claude-chat-turn-tasks"
import type { SendFn } from "./claude-chat-turn-tasks"
import { buildSendOptions } from "./claude-chat-send-options"
import { drainSteerVia, handleEvent } from "./claude-chat-events"

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
      const ids = new Set(chat.openSessionIds)
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
    return () => {
      registry.flushAllPersist()
      registry.clear()
      executionHandles.clear()
      // Each watcher owns a Dexie subscription and an interval. The Squad run
      // itself is unaffected — it is fire-and-forget and reports through the
      // run surfaces; only this hook's hold on the session goes away with it.
      for (const stop of squadWatchers.values()) stop()
      squadWatchers.clear()
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
            getExecutionHandle,
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
        /** The executor chosen for THIS turn only (ADR-0117 axes).
         *
         *  Deliberately not persisted: a sticky override would quietly become
         *  a session-level switch, leaving nothing on screen to name what the
         *  conversation is actually bound to. The composer resets after send;
         *  the durable binding is `ChatSession.squadId`. */
        compositionOverride?:
          import("@cognia/agent-config-types/agent-composition").AgentCompositionSelectionV1 | null
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

          const externalAgentId = sessionExternalLane(sessionId)
          if (!externalAgentId && text && blocks.length === 0 && !isStandaloneChatMode()) {
            try {
              const queued = await enqueueHostStateIntentIfAvailable({
                sessionId,
                action: { kind: "turn.steer", text },
              })
              if (queued) {
                appendSteerMessage(sessionId, optimistic)
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
              const handle = getExecutionHandle(sessionId)
              if (handle) await handle.steer(content)
              else {
                const { steerSession } = await import("@/lib/claude/ipc")
                await steerSession(sessionId, content)
              }
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
        sendOptions =
          opts ??
          (await buildSendOptions(session, userMessageText, (spec) => {
            const existingHandle = getExecutionHandle(sessionId)
            if (existingHandle) {
              executionHandlesRef.current.set(sessionId, existingHandle)
              return
            }
            const handle = createAgentExecutionHandle(sessionId, spec)
            executionHandlesRef.current.set(sessionId, handle)
            executionHandleDirectory.register(handle)
          }))
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
      const hostStateEligible =
        !skipAppend &&
        typeof effectiveContent === "string" &&
        callOptions?.resourceContext === undefined &&
        (callOptions?.attachmentManifest?.length ?? 0) === 0 &&
        useAgentRuntimeStore.getState().runtime !== "external" &&
        !isStandaloneChatMode()
      if (hostStateEligible) {
        try {
          const queued = await enqueueHostStateIntentIfAvailable({
            sessionId,
            action: {
              kind: "message.enqueue",
              messageId: userMsg.id,
              text: providerText,
              attachments: [],
            },
          })
          if (queued) {
            // The outbox transaction completed before this optimistic write.
            // Runtime dispatch, transcript persistence and authoritative title
            // updates now belong to HostStateService on every attached surface.
            store.getState().replaceSessionMessages(sessionId, next)
            store.getState().setSessionStatus(sessionId, "streaming")
            store.getState().setSessionError(sessionId, null)
            lastUserContentRef.current.set(sessionId, displayContent)
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
          return
        }
      }
      if (!skipAppend) {
        store.getState().replaceSessionMessages(sessionId, next)
      }
      // Register this chat turn with the global execution broker so it counts
      // toward — and is observable / cancellable via — the same governor as
      // every headless leg. Acquired before the `streaming` flip so the broker
      // watcher releases it on settle; gated by the `isAtCapacity` check above,
      // so it admits immediately. Best-effort: a broker hiccup never blocks the
      // turn the user already committed to.
      // Resolved before the lease so the slot names the directory this turn
      // actually writes into. Best-effort: an unresolvable cwd means no slot,
      // which is what it was before any of this existed.
      const turnCwd = await resolveEffectiveCwdForSession(session).catch(() => null)
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
        })
      } catch (leaseErr) {
        console.warn("chat lease acquire failed; sending without admission", leaseErr)
      }
      store.getState().setSessionStatus(sessionId, "streaming")
      if (session?.attachedChild) {
        void markAttachedSessionRunning(sessionId).catch((error) =>
          console.warn("attached session start state failed", error)
        )
      }
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
      const squadDecision = resolveTurnSquad({
        turnOverride: callOptions?.compositionOverride ?? null,
        session,
      })
      if (squadDecision.squadId) {
        const squadId = squadDecision.squadId
        try {
          const [{ startSquadRun }, { agentTeamExecutionRunId }] = await Promise.all([
            import("@/lib/ai/agent/team/start-squad-run"),
            import("@/lib/execution/agent-team-bridge"),
          ])
          const result = await startSquadRun({
            squadId,
            goal: providerText,
            origin: "chat",
            triggeredFrom: { source: "chat", sessionId },
            ...(session ? { session } : {}),
            ...(session?.characterId ? { characterId: session.characterId } : {}),
          })
          if (!result.started || !result.runId) {
            store.getState().setSessionStatus(sessionId, "idle")
            store
              .getState()
              .setSessionDiagnostic(
                sessionId,
                createDiagnostic(
                  result.reason === "squad_not_found" ? "squadNotFound" : "squadDispatchFailed",
                  { source: "chat", meta: { sessionId, extra: { squadId } } }
                )
              )
            chatTurnPerformance.finish(sessionId, "failed")
            return
          }
          // Leave the conversation's own record of the handoff, now rather
          // than when the run finishes. A Squad run takes minutes, and a
          // conversation that shows nothing for that long reads as broken.
          // The part carries identity only; everything else is live-queried
          // from the run, so this stays true after a reload instead of
          // freezing at whatever was known at dispatch.
          const squadMessage: UIMessage = {
            id: crypto.randomUUID(),
            role: "assistant",
            parts: [
              {
                type: "squad-run",
                runId: agentTeamExecutionRunId(result.runId),
                squadId,
                squadName: result.squadName ?? squadId,
                objective: providerText,
              },
            ] as unknown as UIMessage["parts"],
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
          const { watchSquadRunSettlement } = await import("@/lib/ai/agent/team/watch-squad-run")
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
        }
        return
      }

      // A persisted execution context owns the chat's Task Workspace identity.
      // Repeated turns create versioned TaskRuns inside that same managed
      // worktree. The developer flag remains a compatibility path for sessions
      // created before execution contexts existed.
      const chatRunId = store.getState().sessions[sessionId]?.runId ?? 0
      let executionContext = session?.executionContext
      const hasNoToolSurface = sendOptions.toolSurface === "none"
      const agentRuntime = useAgentRuntimeStore.getState().runtime
      const manualExternal = !hasNoToolSurface && agentRuntime === "external"

      // Resolve rule-based delegation before opening the Task Workspace and
      // adoption windows so their durable agent identity reflects the runtime
      // that will actually write the files.
      let delegation: import("@/lib/ai/agent/external/delegation-router").RoutingDecision | null =
        null
      if (
        !hasNoToolSurface &&
        !manualExternal &&
        !callOptions?.skipUserAppend &&
        !callOptions?.bypassDelegation
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
            const decision = routeDelegation(
              { prompt: providerText, context: { sessionId } },
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
      const routedExternalAgentId = manualExternal
        ? useAgentRuntimeStore.getState().externalAgentId
        : delegation?.targetAgentId
      const adoptionAgentKind = routedExternalAgentId ? "external" : "in-app"
      if (!hasNoToolSurface && executionContext?.location === "local") {
        sendOptions = { ...sendOptions, cwd: executionContext.projectRoot }
      }
      const executionRunId = runIdForTurn(sessionId, chatRunId)

      // ADR-0130 hard cost ceiling. Evaluated BEFORE any durable acceptance so
      // a refused overrun leaves no half-open run behind. Fails open on any
      // infrastructure error — the user asked for a spending limit, not for
      // their app to stop when Dexie hiccups.
      //
      // The synchronous pre-check keeps the default install (no ceiling
      // configured) on exactly the code path it had before: no extra await, no
      // Dexie read, nothing to pay for a feature that is switched off.
      const budgetDecision = isCostBudgetConfigured()
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
      if (!hasNoToolSurface && executionContext?.location === "managedWorktree") {
        const project = useProjectStore
          .getState()
          .projects.find((candidate) => candidate.id === executionContext?.projectId)
        if (!project) {
          store.getState().setSessionStatus(sessionId, "idle")
          store.getState().setSessionError(sessionId, tInlineErr("managedWorktreeUnavailable"))
          chatTurnPerformance.finish(sessionId, "failed")
          await settleChatTurnForSession(sessionId, {
            outcome: "failed",
            errorCode: "managed_project_unavailable",
          })
          stopAssemblyHeartbeat()
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
          store.getState().setSessionStatus(sessionId, "idle")
          store.getState().setSessionError(sessionId, tInlineErr("managedWorktreeUnavailable"))
          chatTurnPerformance.finish(sessionId, "failed")
          await settleChatTurnForSession(sessionId, {
            outcome: "failed",
            errorCode: "workspace_bundle_unavailable",
          })
          stopAssemblyHeartbeat()
          return
        }
      }
      const boundWorkspaceRoot = executionContext
        ? resolveSessionWorkspaceRoot(executionContext)
        : undefined
      try {
        await startDirectChatExecutionRun({
          sessionId,
          runId: executionRunId,
          ...(providerText ? { prompt: providerText } : {}),
          ...(session?.projectId ? { projectId: session.projectId } : {}),
          ...((boundWorkspaceRoot ?? sendOptions.cwd)
            ? { workspaceRoot: boundWorkspaceRoot ?? sendOptions.cwd }
            : {}),
        })
      } catch (error) {
        store.getState().setSessionStatus(sessionId, "idle")
        store
          .getState()
          .setSessionDiagnostic(
            sessionId,
            toDiagnostic(error, { source: "chat", meta: { sessionId } })
          )
        chatTurnPerformance.finish(sessionId, "failed")
        await settleChatTurnForSession(sessionId, {
          outcome: "failed",
          errorCode: "execution_run_start_failed",
        })
        stopAssemblyHeartbeat()
        return
      }
      const legacyWorkspaceEnabled = !executionContext && Boolean(sendOptions.cwd)
      if (
        !hasNoToolSurface &&
        (executionContext?.location === "managedWorktree" || legacyWorkspaceEnabled)
      ) {
        if (executionContext?.location === "managedWorktree" && !boundWorkspaceRoot) {
          await finishDirectChatExecutionRun(sessionId, "failed")
          const message = tInlineErr("managedWorktreeUnavailable")
          store.getState().setSessionStatus(sessionId, "idle")
          store.getState().setSessionError(sessionId, message)
          chatTurnPerformance.finish(sessionId, "failed")
          await settleChatTurnForSession(sessionId, {
            outcome: "failed",
            errorCode: "managed_worktree_unavailable",
          })
          stopAssemblyHeartbeat()
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
          attemptId: "a1",
          surface: "chat",
          agentId: routedExternalAgentId ?? "built-in",
          agentKind: adoptionAgentKind,
          workspaceRoot,
          ...(executionContext?.taskWorkspace.workspaceKey
            ? { workspaceKey: executionContext.taskWorkspace.workspaceKey }
            : {}),
        }
        const legacyBundle = legacyWorkspaceEnabled
          ? await acquireWorkspaceBundle({
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
            }).catch(() => null)
          : null
        const bundleTurnLease =
          executionContext?.location === "managedWorktree" && managedBundle && bundlePrimaryRootId
            ? await openWorkspaceBundleTurnLease(managedBundle, bundlePrimaryRootId, taskEnvelope)
            : legacyBundle
              ? await openWorkspaceBundleTurnLease(legacyBundle, "primary", {
                  ...taskEnvelope,
                  base: { kind: "workingState" },
                })
              : null
        const taskLease = bundleTurnLease
        if (
          !taskLease &&
          (executionContext?.location === "managedWorktree" || legacyWorkspaceEnabled)
        ) {
          await finishDirectChatExecutionRun(sessionId, "failed")
          const message = tInlineErr("managedWorktreeUnavailable")
          store.getState().setSessionStatus(sessionId, "idle")
          store.getState().setSessionError(sessionId, message)
          chatTurnPerformance.finish(sessionId, "failed")
          await settleChatTurnForSession(sessionId, {
            outcome: "failed",
            errorCode: "task_workspace_unavailable",
          })
          stopAssemblyHeartbeat()
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

      if (!hasNoToolSurface && executionContext?.environmentId) {
        const environment = await getProjectEnvironment(executionContext.environmentId)
        if (!environment || environment.projectId !== executionContext.projectId) {
          await finishDirectChatExecutionRun(sessionId, "failed")
          store.getState().setSessionStatus(sessionId, "idle")
          store.getState().setSessionError(sessionId, tInlineErr("environmentUnavailable"))
          chatTurnPerformance.finish(sessionId, "failed")
          await settleChatTurnForSession(sessionId, {
            outcome: "failed",
            errorCode: "environment_unavailable",
          })
          stopAssemblyHeartbeat()
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
          await finishDirectChatExecutionRun(sessionId, "failed")
          store.getState().setSessionStatus(sessionId, "idle")
          store
            .getState()
            .setSessionError(sessionId, setup.error || tInlineErr("environmentSetupFailed"))
          chatTurnPerformance.finish(sessionId, "failed")
          await settleChatTurnForSession(sessionId, {
            outcome: "failed",
            errorCode: "environment_setup_failed",
          })
          stopAssemblyHeartbeat()
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
        const extAgentId = manualExternal
          ? useAgentRuntimeStore.getState().externalAgentId
          : delegation!.targetAgentId
        if (!extAgentId) {
          await finishDirectChatExecutionRun(sessionId, "failed")
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
          await settleChatTurnForSession(sessionId, {
            outcome: "failed",
            errorCode: "external_agent_not_selected",
          })
          stopAssemblyHeartbeat()
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
          if (delegation && chatFailurePolicy === "fallback") {
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
          const externalStartedAt = behaviorTurnStartedAt.get(sessionId)
          let assistantParts: UIMessage["parts"] = [] as unknown as UIMessage["parts"]
          const baseList = store.getState().sessions[sessionId]?.messages ?? []

          // ADR-0127 §1: the external rail rides the same per-session
          // coalescer as the sidecar rail — ≤1 React commit per frame and a
          // debounced mid-stream Dexie write — instead of a synchronous full
          // `replaceSessionMessages` per delta and a Dexie write only at the
          // end (which lost the partial on a mid-turn crash).
          const coalesce = registry.get(sessionId)
          const writeAssistant = () => {
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
          /** Seal the coalescer: apply the last frame now, drop the debounced write. */
          const sealCoalescer = () => {
            coalesce.commit.flush()
            coalesce.persist.cancel()
          }

          chatTurnPerformance.markDispatched(sessionId)
          const result = await executeOnExternalAgent(externalSendText, {
            agentId: extAgentId,
            workingDirectory: sendOptions.cwd,
            // The composer's thinking level, which before this reached only the
            // built-in runtime — on an external agent the control was silently
            // inert. Both fields carry the same resolved precedence chain (IM
            // override > session > bot > app default), and the adapter folds
            // the value onto whatever ladder its model publishes.
            //
            // `requestedEffort` rather than `effort`: the latter has already
            // been through the `modelSupportsEffort` gate against the SESSION's
            // model, which this rail does not run — the external agent brings
            // its own. Reading the gated field made the control inert again
            // whenever the session happened to sit on a model that rejects the
            // Anthropic `effort` parameter (Haiku, Sonnet 4.5), even though the
            // agent about to run it honours the level fine.
            ...(sendOptions.requestedEffort || sendOptions.effort
              ? { reasoningEffort: sendOptions.requestedEffort ?? sendOptions.effort }
              : {}),
            context: {
              custom: {
                additionalDirectories: sendOptions.additionalDirectories ?? [],
              },
            },
            onEvent: (event) => {
              const capture = captureEventFromCanonical(canonicalEventFromExternalEvent(event))
              if (capture) void projectDirectChatCaptureEvent(sessionId, capture)
              const nextParts = applyExternalAgentEventToParts(assistantParts, event)
              if (nextParts !== assistantParts) {
                assistantParts = nextParts as UIMessage["parts"]
                chatTurnPerformance.markFirstResponse(sessionId)
                writeAssistant()
              }
            },
          })

          sealCoalescer()

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
              run: { providerId: "external", startedAt: externalStartedAt },
            },
          }
          const completedAt = Date.now()
          const finalMessages = attachRunMetadataToLastAssistant(
            store.getState().sessions[sessionId]?.messages ?? [...baseList, finalAssistant],
            buildCompletedRunMetadata({
              providerId: "external",
              startedAt: externalStartedAt,
              completedAt,
              reportedDurationMs: result.duration,
            })
          )
          store.getState().replaceSessionMessages(sessionId, finalMessages)
          chatTurnPerformance.beginFinalPersistence(sessionId)
          await persistMessages(sessionId, finalMessages)
          chatTurnPerformance.endFinalPersistence(sessionId)
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
        // Durable acceptance (ADR-0123), phase B. This is the last point at
        // which `sendOptions` is still changing — cwd, task workspace and
        // routing have all settled by now — so it is the only honest moment to
        // freeze the execution context. Write-once: on a retry the stored
        // bundle wins, which is what stops a replay from silently re-resolving
        // the project root against whatever the host looks like later.
        if (durableLeaseLost) return
        await bindChatTurnContext({
          runId: executionRunId,
          context: {
            ...(sendOptions.cwd ? { cwd: sendOptions.cwd } : {}),
            ...(session?.projectId ? { projectId: session.projectId } : {}),
            ...(boundWorkspaceRoot ? { workspaceBindingRef: executionRunId } : {}),
            sendOptions,
          },
        })
        if (isStandaloneChatMode()) {
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
          chatTurnPerformance.markDispatched(sessionId)
          if (dispatchClaim === "claimed") {
            await sendPrompt(sessionId, effectiveContent, sendOptions, {
              commandId: chatSubmissionId(executionRunId),
            })
          } else {
            await sendPrompt(sessionId, effectiveContent, sendOptions)
          }
        }
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
        await finishDirectChatExecutionRun(sessionId, "failed", Date.now(), error.message)
        await settleChatTurnForSession(sessionId, {
          outcome: "failed",
          errorCode: "send_failed",
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
      }
    },
    [
      store,
      tRouting,
      tInlineErr,
      registry,
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

  // Background-run result delivery: register the hook's send as the replay
  // channel, and drain pending results whenever a session (re)opens idle —
  // covers relaunches (journaled pending rows) and panes closed at settle.
  useEffect(() => {
    return registerBackgroundReplaySend((framedText, sessionId) => {
      void sendRef.current?.(framedText, undefined, { sessionId })
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
  useEffect(() => {
    void expireSessionPeerMessages().catch(() => undefined)
    for (const sessionId of openSessionIdsForDrain) {
      maybeDrainBackgroundResults(sessionId)
      void drainSessionPeerMessages(sessionId).catch(() => undefined)
    }
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
      ])

      try {
        // Standalone (BYOK) turns are cancelled by aborting the renderer
        // streamText loop; the engine then emits its own `session_ended`. The
        // sidecar path interrupts the host instead. The follow-up
        // `session_ended` remains idempotent with the optimistic local seal.
        const standaloneController = standaloneAbortRef.current.get(sessionId)
        if (hostStateAbortQueued) {
          // Durable HostState action owns the interrupt; the runner retries it
          // with the same action id after reconnect.
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
        const handle = getExecutionHandle(sessionId)
        if (handle) await handle.interrupt()
        else await interruptSession(sessionId)
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

  const close = useCallback(
    async (sessionId: string) => {
      const handle = getExecutionHandle(sessionId)
      try {
        if (handle) await handle.cancel()
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
        useChatStore.getState().closeSession(sessionId)
        clearSessionGrants(sessionId)
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
    [registry, getExecutionHandle, executionHandleDirectory]
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
    compact,
    setModel,
    resetRuntime,
    rewindFiles,
    close,
    editAndResend,
    regenerate,
  }
}
