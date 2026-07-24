"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import type { UnlistenFn } from "@tauri-apps/api/event"
import type { UIMessage } from "ai"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import {
  applySdkEvent,
  contentPreview,
  makeUserMessage,
  mergeMemorySourcesIntoLastAssistant,
  type MemorySourcesContext,
} from "@/lib/claude/adapter"
import {
  runTitleTask,
  shouldGenerateTitle,
  isPlaceholderTitle,
} from "@/lib/ai/generation/run-title-task"
import {
  approveTool,
  closeSession,
  interruptSession,
  onClaudeMessage,
  sendPrompt,
} from "@/lib/claude/ipc"
import { detectPlatform } from "@/hooks/use-platform"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { pendingRecoveryPhase } from "@/lib/usage/compaction-metrics"
import { runTurnMemory } from "@/lib/memory/run-turn-memory"
import { tryBuildMemoryDeps } from "@/lib/memory/runtime/build-deps"
import type { ApplyMemoryContextDeps } from "@/lib/memory/runtime/apply-memory-context"
import { resolveMemoryConfig } from "@/types/memory/memory"
import { tryBuildTwinDeps, type TwinDepsForBuild } from "@/lib/twin/runtime/build-deps"
import { generateEmbedding } from "@cognia/provider-embedding/embedding"
import {
  buildSupervisorRoster,
  parseDispatches,
  routeTurn,
  stripDispatches,
} from "@/lib/claude/team-router"
import { listMessages, persistMessages, truncateAfter } from "@/lib/db/messages"
import { getSession, touchSession, updateSession } from "@/lib/db/sessions"
import { listCharactersByIds } from "@/lib/db/characters"
import { recordResultUsage } from "@/lib/db/session-usage"
import { bumpUnread } from "@/lib/db/session-state"
import { getTeam } from "@/lib/db/teams"
import type {
  ApprovalDecision,
  Character,
  ClaudeEvent,
  PendingApproval,
  SendContent,
  Team,
  TeamMember,
} from "@cognia/agent-config-types"
import { subSessionId, decodeSubSession } from "@/lib/claude/team-session-id"
import { steerBlocksOf, steerTextOf } from "@/lib/claude/steer"
import { senderIdOf, tagBranchSiblings, teamBranchGroupId } from "@/lib/chat/branch-regen"
import { mirrorTruncateToDesktop } from "@/lib/chat/mirror-truncate"
import { isSessionOpen, maybeDrainSteer, sessionStatusOf, steerArmed } from "./steer-runtime"
import { SessionCoalescingRegistry } from "./stream-coalescing"
import { getExecutionBroker } from "@/lib/execution/broker"
import { acquireChatLease } from "@/lib/execution/chat-lease"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui"
import { isTauri } from "@/lib/tauri"
import { isCapacitor } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"

const MAX_SUPERVISOR_ROUNDS = 2

/** Options for a team send. `sessionId` targets a background pane (defaults
 * to the active session); `skipPersistUserTurn` marks an internal re-issue
 * (regenerate) whose user message is already on disk. */
export interface TeamSendOptions {
  /** Attachment provenance for the optimistic user message. */
  attachmentManifest?: readonly AttachmentManifestEntry[]
  sessionId?: string
  skipPersistUserTurn?: boolean
}

type TeamSendFn = (content: SendContent, opts?: TeamSendOptions) => Promise<void>

/**
 * Interrupt every in-flight sub-session of `teamSessionId` and reject its
 * resolvers so the orchestration loop unwinds. Shared by `stop` and the
 * broker lease's cancel bridge.
 */
async function interruptTeamTurn(teamSessionId: string, resolvers: ResolverMap): Promise<void> {
  for (const [sub, r] of resolvers.entries()) {
    const decoded = decodeSubSession(sub)
    if (decoded?.teamSessionId !== teamSessionId) continue
    try {
      await interruptSession(sub)
    } catch {
      /* best effort */
    }
    r.reject(new Error("Interrupted"))
  }
}

function newTurnId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

interface SubResolver {
  resolve: () => void
  reject: (err: Error) => void
}

/**
 * Per-sub-session bookkeeping for the in-flight team turn:
 * a promise that resolves when the SDK's `result` event arrives and the
 * sub-session can be torn down.
 */
type ResolverMap = Map<string, SubResolver>

/**
 * Sibling of `useClaudeChat`, but for team sessions. Sends the user turn to
 * each member sequentially under a distinct sub-session id so the sidecar's
 * existing per-session machinery (streaming, tool approval, interrupt) just
 * works without protocol changes.
 *
 * Mount this hook once at the shell level alongside `useClaudeChat`. The two
 * partition the event stream with `decodeSubSession` (`::char::` sub-session
 * ids) so they never both react to the same event.
 *
 * Behavioral parity with `useClaudeChat`: sends are session-parameterized
 * (background panes), gated by the execution broker (one "team" lease per
 * turn), and steer-queued while streaming. Principled exclusions — no
 * standalone/BYOK or external-agent branch (`TeamMember` has no runtime
 * field; members are sidecar-only by data model) and no plan-approval dock
 * (plan mode is a direct-chat surface).
 */
export function useTeamChat() {
  const tInlineErr = useTranslations("chat.inlineError")
  const allowListRef = useRef<string[]>([])
  useEffect(() => {
    const unsub = useSettingsStore.subscribe((s) => {
      allowListRef.current = s.settings?.alwaysAllowTools ?? []
    })
    allowListRef.current = useSettingsStore.getState().settings?.alwaysAllowTools ?? []
    return unsub
  }, [])

  const resolvers = useRef<ResolverMap>(new Map())
  const eventQueuesRef = useRef<Map<string, Promise<void>>>(new Map())
  // Team sessions whose in-flight turn was interrupted (stop / broker cancel).
  // Per-session so stopping one team pane never aborts a sibling team turn.
  const interruptedRef = useRef<Set<string>>(new Set())

  // Streaming coalescing — parity with direct chat's per-session registry.
  // Mid-turn team events commit to the store at most once per animation frame
  // and write to Dexie on a trailing debounce, instead of one full
  // `persistMessages` transaction + React commit per token batch. The mirror
  // holds the authoritative latest list per team session so the next event
  // never reads a coalesced-stale base. Sealed on each member's `result`
  // event (in `handleTeamEvent`) and in `send`'s finally (interrupt / error
  // settles). 0ms persist in tests degrades to synchronous so existing
  // persist-ordering assertions hold.
  const TEAM_PERSIST_DEBOUNCE_MS = process.env.NODE_ENV === "test" ? 0 : 250
  const streamMirrorRef = useRef<Map<string, UIMessage[]>>(new Map())
  const [coalescing] = useState(
    () =>
      new SessionCoalescingRegistry({
        onCommit: (sid, msgs) => useChatStore.getState().replaceSessionMessages(sid, msgs),
        onPersist: (sid, msgs) =>
          void persistMessages(sid, msgs).catch((err) =>
            console.error("team debounced persistMessages failed", err)
          ),
        persistDelayMs: TEAM_PERSIST_DEBOUNCE_MS,
      })
  )

  // Best-effort flush of every pending streaming write on unmount so the last
  // partial isn't lost when the hook tears down mid-turn.
  useEffect(() => {
    const mirror = streamMirrorRef.current
    return () => {
      coalescing.flushAllPersist()
      coalescing.clear()
      mirror.clear()
    }
  }, [coalescing])

  // Cache the original SendContent per team session so regenerate can resend
  // it without losing attachments to the text-only round-trip.
  const lastUserContentRef = useRef<Map<string, SendContent>>(new Map())

  // Serialize events per member sub-session. A result event performs async
  // persistence before `session_ended` resolves the member turn; without this
  // queue the orchestration could start final memory extraction while the
  // sealed assistant reply was still absent from the team transcript.
  const enqueueTeamEvent = useCallback(
    (evt: ClaudeEvent) => {
      const key =
        typeof (evt as { sessionId?: unknown }).sessionId === "string"
          ? (evt as { sessionId: string }).sessionId
          : "__nosession__"
      const queues = eventQueuesRef.current
      const tail = (queues.get(key) ?? Promise.resolve())
        .catch(() => {})
        .then(() =>
          handleTeamEvent(evt, allowListRef, resolvers.current, {
            mirror: streamMirrorRef.current,
            registry: coalescing,
          })
        )
        .catch((err) => {
          console.error("team handleEvent failed", err)
        })
      queues.set(key, tail)
      void tail.finally(() => {
        if (queues.get(key) === tail) queues.delete(key)
      })
    },
    [coalescing]
  )

  // Subscribe to sidecar events; only react to sub-session-tagged ones.
  // Same event sources as direct chat: Tauri events on desktop, the mirrored
  // companion WebSocket on Capacitor / web-companion. Plain web has none.
  useEffect(() => {
    if (!isTauri() && !isCapacitor() && !hasWebCompanionTarget()) return
    let unlisten: UnlistenFn | null = null
    let cancelled = false

    onClaudeMessage((evt) => enqueueTeamEvent(evt))
      .then((u) => {
        if (cancelled) u()
        else unlisten = u
      })
      .catch((err) => {
        console.error("listen team events failed", err)
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [enqueueTeamEvent])

  // Self-reference for the steer drain in `send`'s finally (replay = fresh send).
  const sendRef = useRef<TeamSendFn | null>(null)

  /**
   * Send a user prompt to every member of a team session (the active one by
   * default, or `opts.sessionId` for a background pane), sequenced by
   * `routeTurn`. Returns once every member has either replied or errored.
   *
   * If the session isn't a team session, this is a no-op — the caller should
   * fall back to `useClaudeChat.send`.
   *
   * `opts.skipPersistUserTurn` is set by internal re-issues (regenerate) so we
   * don't double up the user message already left on disk.
   */
  const send = useCallback(
    async (content: SendContent, opts?: TeamSendOptions) => {
      const sessionId = opts?.sessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) {
        useChatStore.getState().setError(tInlineErr("noSession"))
        return
      }

      // Concurrency cap backstop — parity with direct chat. A session that is
      // already streaming is a continuation (its own lease exempts it).
      if (getExecutionBroker().isAtCapacity("ai-turn", sessionId)) {
        console.warn("team send blocked: concurrent stream cap reached", { sessionId })
        return
      }

      // Steer instead of a concurrent orchestration loop: a fresh user turn
      // while THIS team session is still streaming / awaiting approval would
      // start a second orchestrator over half-written state. Queue it and
      // replay once the turn settles. The replayed steer addresses the *team*
      // (it re-routes through routeTurn / the supervisor); members later in the
      // current turn's sequence do NOT see it mid-turn — same "no mid-turn
      // injection" constraint as direct chat. Internal re-issues bypass this.
      if (!opts?.skipPersistUserTurn) {
        const st = sessionStatusOf(sessionId)
        if (st === "streaming" || st === "awaiting_approval") {
          const text = steerTextOf(content)
          const blocks = steerBlocksOf(content)
          if (text || blocks.length > 0) {
            useChatStore.getState().enqueueSteer(sessionId, {
              id: crypto.randomUUID(),
              text,
              blocks: blocks.length > 0 ? blocks : undefined,
            })
          }
          return
        }
      }

      const session = await getSession(sessionId)
      if (!session || session.kind !== "team" || !session.teamId) {
        useChatStore.getState().setSessionError(sessionId, "Team session not found")
        return
      }
      const team = await getTeam(session.teamId)
      if (!team) {
        useChatStore
          .getState()
          .setSessionError(sessionId, `Team ${session.teamId} no longer exists`)
        return
      }

      interruptedRef.current.delete(sessionId)
      useUIStore.getState().clearStopRequestsFor(sessionId)

      const memberIds = team.members.map((m) => m.characterId)
      const members = await listCharactersByIds(memberIds)
      const memberByCharId = new Map<string, TeamMember>(
        team.members.map((m) => [m.characterId, m])
      )
      const userText = asPlainText(content)
      lastUserContentRef.current.set(sessionId, content)

      // Embed the user message ONCE per turn so twin-bound members can share the
      // same query vector rather than each paying an individual embed call.
      let turnTwinDeps: TwinDepsForBuild | undefined
      let turnEmbedding: number[] | undefined
      let turnMemoryDeps: ApplyMemoryContextDeps | undefined
      if (userText.trim()) {
        turnTwinDeps = await tryBuildTwinDeps()
        if (turnTwinDeps) {
          try {
            const result = await generateEmbedding(userText, turnTwinDeps.embedding)
            turnEmbedding = result.embedding
          } catch {
            turnEmbedding = undefined // resolver falls back to per-member embed
          }
        }
        // Long-term memory recall parity with direct chat: build the read-runtime
        // deps once per turn so every member injects the shared memory store (the
        // team runtime previously read twin RAG but never recalled memory).
        turnMemoryDeps = await tryBuildMemoryDeps(
          resolveMemoryConfig(useSettingsStore.getState().settings?.memory),
          turnTwinDeps
        )
      }

      // 1. Persist the user turn first, tagging it as a "user" sender.
      // Captures the instant title preview (if written) so the later LLM-title
      // smoothing can compare against what the user actually sees.
      // Base off this session's own slice — never the focused projection — and
      // fall back to Dexie when no pane has materialised the slice yet.
      let instantPreviewTitle: string | undefined
      if (!opts?.skipPersistUserTurn) {
        const userMsg = withMetadata(
          makeUserMessage(content, undefined, opts?.attachmentManifest),
          {
            senderKind: "user",
          }
        )
        const before =
          useChatStore.getState().sessions[sessionId]?.messages ?? (await listMessages(sessionId))
        const after = [...before, userMsg]
        useChatStore.getState().replaceSessionMessages(sessionId, after)
        try {
          await persistMessages(sessionId, after)
          await touchSession(sessionId)
          // Instant first-message preview — parity with direct chat. Only claims
          // a still-placeholder title and marks it machine-set (`titleAuto`) so
          // the turn-complete path may later upgrade it to an LLM title.
          if (isPlaceholderTitle(session.title)) {
            const title = contentPreview(content, 40)
            if (title) {
              instantPreviewTitle = title
              await updateSession(sessionId, { title, titleAuto: true })
            }
          }
        } catch (err) {
          useChatStore
            .getState()
            .setSessionError(sessionId, err instanceof Error ? err.message : String(err))
          return
        }
      }

      // Register the team turn with the global execution broker (one lease for
      // the whole sequential fan-out). Acquired before the `streaming` flip so
      // the status watcher releases it on settle; the broker's cancel bridge
      // interrupts the live sub-sessions (their ids differ from `sessionId`).
      // Best-effort: a broker hiccup never blocks the committed turn.
      try {
        await acquireChatLease({
          sessionId,
          projectId: session.projectId,
          label: session.title || team.name || `#${sessionId.slice(0, 8)}`,
          kind: "team",
          onCancel: () => {
            interruptedRef.current.add(sessionId)
            void interruptTeamTurn(sessionId, resolvers.current)
          },
        })
      } catch (leaseErr) {
        console.warn("team chat lease acquire failed; sending without admission", leaseErr)
      }
      // Clear any stale error BEFORE flipping to streaming — setSessionError(null)
      // resets status to idle, so the reverse order would strand the run status
      // (and release the broker lease) the moment the turn started.
      useChatStore.getState().setSessionError(sessionId, null)
      useChatStore.getState().setSessionStatus(sessionId, "streaming")

      const turnId = newTurnId()

      // 2. Branch on orchestration. Supervisor has its own multi-round loop.
      try {
        if (team.orchestration === "supervisor") {
          await runSupervisorTurn({
            session,
            sessionId,
            team,
            members,
            memberByCharId,
            turnId,
            interruptedRef,
            resolvers: resolvers.current,
            turnTwinDeps,
            turnEmbedding,
            turnMemoryDeps,
            turnUserMessage: userText,
          })
        } else {
          const targets = routeTurn(team, members, userText)
          if (targets.length === 0) {
            // `manual` mode → user picks a member explicitly. Stop here.
            useChatStore.getState().setSessionStatus(sessionId, "idle")
            return
          }
          await runLinearTurn({
            session,
            sessionId,
            team,
            content,
            members,
            targets,
            memberByCharId,
            turnId,
            interruptedRef,
            resolvers: resolvers.current,
            turnTwinDeps,
            turnEmbedding,
            turnMemoryDeps,
            turnUserMessage: userText,
          })
        }

        // Long-term memory write parity with direct chat (team↔direct): the team
        // runtime previously only *read* memory (via resolveSendOptions per member)
        // and never wrote it back. Extract from the completed team turn — the user
        // prompt plus the final team reply (last assistant message; for supervisor
        // mode that is the synthesis). Only runs on clean completion: interrupt and
        // error throw past this point, and the manual no-target case returns above.
        const finalMessages =
          useChatStore.getState().sessions[sessionId]?.messages ?? (await listMessages(sessionId))
        const lastAssistant = [...finalMessages].reverse().find((m) => m.role === "assistant")
        void runTurnMemory(sessionId, {
          userText,
          assistantText: lastAssistant ? textFromParts(lastAssistant.parts) : "",
          assistantMessageId: lastAssistant?.id,
          transcript: finalMessages.map((m) => ({
            role: m.role,
            text: textFromParts(m.parts),
            parts: m.parts,
          })),
        })

        // Conversation-title upgrade — parity with direct chat. On the first team
        // turn (and while still machine-set), ask the cheap model for a short
        // title built from the first user prompt + first teammate reply. Reuse the
        // send-start `session` snapshot for the gate (no extra DB round-trip); the
        // freshness re-check happens inside `runTitleTask` before it persists.
        const settings = useSettingsStore.getState().settings
        const titleCfg = settings?.conversationTitle
        const assistantCount = finalMessages.filter((m) => m.role === "assistant").length
        if (
          shouldGenerateTitle({
            titleEnabled: titleCfg?.enabled,
            assistantCount,
            titleAuto: session.titleAuto,
          })
        ) {
          const firstUser = finalMessages.find((m) => m.role === "user")
          const firstAssistant = finalMessages.find((m) => m.role === "assistant")
          void runTitleTask({
            session,
            appSettings: settings,
            override: titleCfg,
            featureId: "conversation-title",
            sourceText: firstUser ? textFromParts(firstUser.parts) : userText,
            resultText: firstAssistant ? textFromParts(firstAssistant.parts) : undefined,
            locale: settings?.language,
            currentTitle: instantPreviewTitle ?? session.title,
            isStillAuto: async () => {
              const fresh = await getSession(sessionId).catch(() => undefined)
              return !fresh || fresh.titleAuto !== false
            },
            persist: (title) => updateSession(sessionId, { title, titleAuto: true }),
          })
        }
      } finally {
        // Seal any coalesced streaming state left by this turn: a clean member
        // settle already flushed on its `result` event, but interrupt / error
        // paths can end mid-stream with a pending rAF commit + debounced
        // persist. Flush them (latest snapshot wins) and drop the mirror so the
        // next turn re-reads a fresh base.
        const pair = coalescing.get(sessionId)
        pair.commit.flush()
        pair.persist.flush()
        coalescing.release(sessionId)
        streamMirrorRef.current.delete(sessionId)
        // Capture the settle shape before flipping to idle: a clean end always
        // drains the steer queue; an interrupted / errored end only drains when
        // `interruptAndSteer` armed it (parity with direct chat's settle).
        const hadError = useChatStore.getState().sessions[sessionId]?.status === "error"
        const wasInterrupted = interruptedRef.current.has(sessionId)
        pendingTeamBranchTags.delete(sessionId)
        useChatStore.getState().setSessionStatus(sessionId, "idle")
        useUIStore.getState().clearMemberStatusFor(sessionId)
        useUIStore.getState().clearStopRequestsFor(sessionId)
        if ((!hadError && !wasInterrupted) || steerArmed.has(sessionId)) {
          maybeDrainSteer(sessionId, (payload) => void sendRef.current?.(payload, { sessionId }))
        }
      }
    },
    [coalescing, tInlineErr]
  )

  // Keep the steer drain pointed at the latest `send` without closing over it.
  useEffect(() => {
    sendRef.current = send
    return () => {
      if (sendRef.current === send) sendRef.current = null
    }
  }, [send])

  /** Cancel an in-flight team turn (the active session's by default, or a
   * background pane's via `targetSessionId`). Aborts the current sub-session
   * and stops issuing new ones. */
  const stop = useCallback(async (targetSessionId?: string) => {
    const teamSessionId = targetSessionId ?? useChatStore.getState().activeSessionId
    if (!teamSessionId) return
    interruptedRef.current.add(teamSessionId)
    // Plain stop discards any queued steer — the user is taking over, not
    // steering — and disarms the drain so the settle doesn't replay it.
    useChatStore.getState().clearSteerQueue(teamSessionId)
    steerArmed.delete(teamSessionId)
    await interruptTeamTurn(teamSessionId, resolvers.current)
    useChatStore.getState().setSessionStatus(teamSessionId, "idle")
    useUIStore.getState().clearMemberStatusFor(teamSessionId)
  }, [])

  // "Interrupt & steer now": cut the running team turn short so its settle
  // replays the queued steer immediately. Arming covers interrupted settles
  // (the finally drains armed sessions). No-op when nothing is queued.
  const interruptAndSteer = useCallback(async (targetSessionId?: string) => {
    const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
    if (!sessionId) return
    const queued = useChatStore.getState().sessions[sessionId]?.steerQueue ?? []
    if (queued.length === 0) return
    steerArmed.add(sessionId)
    interruptedRef.current.add(sessionId)
    await interruptTeamTurn(sessionId, resolvers.current)
  }, [])

  // Replay a session's queued steer NOW, without a turn boundary — used after
  // an errored settle where the queue is preserved but no settle is coming.
  const flushSteer = useCallback((targetSessionId?: string) => {
    const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
    if (!sessionId) return
    maybeDrainSteer(sessionId, (payload) => void sendRef.current?.(payload, { sessionId }))
  }, [])

  /**
   * Re-issue the most recent user turn for a team session (active by default).
   * Non-destructive — parity with direct chat: the user anchor stays put and
   * every existing reply after it is kept as a *branch* (tagged with a
   * per-member `branchGroupId`), so the BranchNavigator can flip back to the
   * previous team turn. The re-run replies are stamped as the next branch as
   * they land in `handleTeamEvent`.
   */
  const regenerate = useCallback(
    async (targetSessionId?: string) => {
      const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return

      const messages =
        useChatStore.getState().sessions[sessionId]?.messages ?? (await listMessages(sessionId))
      let lastUserIdx = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          lastUserIdx = i
          break
        }
      }
      if (lastUserIdx < 0) return

      const anchor = messages[lastUserIdx]
      // Per-member branch groups: a team turn holds one reply per member (plus
      // supervisor rounds), and the branch model shows one message per group —
      // so each (member, occurrence) position gets its own group.
      const seen = new Map<string, number>()
      const { merged, nextIndexByGroup } = tagBranchSiblings(messages, lastUserIdx, (m) => {
        const senderId = senderIdOf(m)
        const ord = seen.get(senderId) ?? 0
        seen.set(senderId, ord + 1)
        return teamBranchGroupId(anchor.id, senderId, ord)
      })
      useChatStore.getState().replaceSessionMessages(sessionId, merged)
      await persistMessages(sessionId, merged)

      // Arm the per-member stamping for the re-run replies (consumed in
      // handleTeamEvent as each member's new message lands; cleared in send's
      // finally so later turns are untouched).
      pendingTeamBranchTags.set(sessionId, {
        anchorId: anchor.id,
        nextIndexByGroup,
        seenByMember: new Map(),
      })

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
      // The anchor is still on disk — never re-persist the user message.
      await send(content, { sessionId, skipPersistUserTurn: true })
    },
    [send]
  )

  /**
   * Edit a previously-sent user message in the active team session and resend
   * the whole turn. Mirrors `useClaudeChat.editAndResend` but routes through
   * the team orchestration loop so every member re-replies under the new
   * content.
   *
   * Drops `messageId` and everything after it (inclusive), then re-runs the
   * normal team `send` path with `newContent`. Member statuses, dispatches,
   * and supervisor rounds are reconstructed from a clean slate.
   */
  const editAndResend = useCallback(
    async (messageId: string, newContent: SendContent, targetSessionId?: string) => {
      const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return
      if (detectPlatform() === "mobile") {
        await mirrorTruncateToDesktop(sessionId, messageId)
      }
      await truncateAfter(sessionId, messageId, { inclusive: true })
      const remaining = await listMessages(sessionId)
      useChatStore.getState().replaceSessionMessages(sessionId, remaining)
      await send(newContent, { sessionId })
    },
    [send]
  )

  /** Approve / deny a tool call. Routes the response to the right sub-session
   * and refreshes the always-allow list when the user picks "always". */
  const respondToApproval = useCallback(
    async (approval: PendingApproval, decision: ApprovalDecision) => {
      if (decision === "allow_always") {
        await useSettingsStore.getState().toggleAlwaysAllow(approval.toolName, true)
      }
      try {
        await approveTool(
          approval.sessionId,
          approval.requestId,
          decision === "allow_always" ? "allow" : decision
        )
      } finally {
        useChatStore.getState().clearApproval(approval.requestId)
      }
    },
    []
  )

  return { send, stop, regenerate, editAndResend, respondToApproval, interruptAndSteer, flushSteer }
}

// ---- Linear orchestration (round_robin / mention / manual-targeted) ------

interface RunCommonArgs {
  session: { id: string; scratchpad?: string }
  sessionId: string
  team: Team
  members: Character[]
  memberByCharId: Map<string, TeamMember>
  turnId: string
  /** Team-session ids whose in-flight turn was interrupted (per-session). */
  interruptedRef: React.MutableRefObject<Set<string>>
  resolvers: ResolverMap
  /** Pre-built twin runtime deps shared across all members for this turn. */
  turnTwinDeps?: TwinDepsForBuild
  /** Pre-computed query embedding for the user message; avoids N×embed cost. */
  turnEmbedding?: number[]
  /** Pre-built long-term-memory read deps shared across all members this turn. */
  turnMemoryDeps?: ApplyMemoryContextDeps
  /** Plain-text user message forwarded to resolveSendOptions for twin RAG. */
  turnUserMessage?: string
}

interface RunLinearArgs extends RunCommonArgs {
  content: SendContent
  targets: Character[]
}

async function runLinearTurn(args: RunLinearArgs): Promise<void> {
  const {
    session,
    sessionId,
    team,
    members,
    targets,
    memberByCharId,
    turnId,
    interruptedRef,
    resolvers,
    turnTwinDeps,
    turnEmbedding,
    turnMemoryDeps,
    turnUserMessage,
  } = args

  for (const character of targets) {
    if (interruptedRef.current.has(sessionId)) break

    // Per-member stop check — skip this one but keep going.
    if (useUIStore.getState().isStopRequested(sessionId, character.id)) {
      useUIStore.getState().clearStopRequest(sessionId, character.id)
      useUIStore.getState().setMemberStatus(sessionId, character.id, "idle")
      continue
    }

    const sub = subSessionId(sessionId, character.id, turnId)
    useUIStore.getState().setMemberStatus(sessionId, character.id, "thinking")

    try {
      await runMemberSubSession({
        session,
        sessionId,
        team,
        character,
        members,
        memberByCharId,
        sub,
        sendContent: args.content,
        resolvers,
        turnTwinDeps,
        turnEmbedding,
        turnMemoryDeps,
        turnUserMessage,
      })
      useUIStore.getState().setMemberStatus(sessionId, character.id, "idle")
    } catch (err) {
      useUIStore.getState().setMemberStatus(sessionId, character.id, "errored")
      const msg = err instanceof Error ? err.message : String(err)
      useChatStore.getState().setSessionError(sessionId, `${character.name}: ${msg}`)
    }
  }
}

// ---- Supervisor orchestration --------------------------------------------

async function runSupervisorTurn(args: RunCommonArgs): Promise<void> {
  const {
    session,
    sessionId,
    team,
    members,
    memberByCharId,
    turnId,
    interruptedRef,
    resolvers,
    turnTwinDeps,
    turnEmbedding,
    turnMemoryDeps,
    turnUserMessage,
  } = args

  if (!team.supervisorCharacterId) {
    useChatStore
      .getState()
      .setSessionError(sessionId, "Supervisor team has no supervisor configured")
    return
  }
  const supervisor = members.find((m) => m.id === team.supervisorCharacterId)
  if (!supervisor) {
    useChatStore.getState().setSessionError(sessionId, "Configured supervisor is not a member")
    return
  }

  const dispatchedReplies: { name: string; reply: string }[] = []

  for (let round = 1; round <= MAX_SUPERVISOR_ROUNDS; round++) {
    if (interruptedRef.current.has(sessionId)) return

    const sub = subSessionId(sessionId, supervisor.id, `${turnId}r${round}`)
    useUIStore.getState().setMemberStatus(sessionId, supervisor.id, "thinking")

    try {
      // Build the supervisor's system prompt: per-member resolved + roster
      // (round 1) or + dispatch results (round 2). The transcript is built
      // separately by runMemberSubSession so we only construct the addendum
      // here.
      const roster = round === 1 ? buildSupervisorRoster(members, memberByCharId) : ""
      const synthesisHeader = round === 2 ? buildSynthesisAddendum(dispatchedReplies) : ""

      const promptAddendum = [roster, synthesisHeader]
        .filter((s) => s.trim().length > 0)
        .join("\n\n")

      // We "send" with empty content on round 2 — the SDK still streams a
      // turn from the supervisor based on the augmented system prompt and
      // existing transcript. Round 1 uses the original user content (already
      // persisted as the user message before this function was called), so
      // we forward an empty trigger as well: the supervisor reads the user
      // turn from the transcript injected by runMemberSubSession.
      // Using a single-character prompt avoids the SDK's "empty input"
      // shortcut while keeping the user's voice in the transcript only.
      const trigger = round === 1 ? "Respond to the user." : "Synthesize the final reply."

      await runMemberSubSession({
        session,
        sessionId,
        team,
        character: supervisor,
        members,
        memberByCharId,
        sub,
        sendContent: trigger,
        promptAddendum,
        messageMetadata: { supervisorRound: round },
        // Strip <dispatch> tags from EVERY supervisor round's visible reply.
        // Round 1 is exactly the turn instructed to emit them (team-router
        // roster), so gating this on round===2 leaked raw `<dispatch …>` XML
        // into the round-1 message the user sees.
        postProcessText: (text) => stripDispatches(text),
        resolvers,
        turnTwinDeps,
        turnEmbedding,
        turnMemoryDeps,
        turnUserMessage,
      })

      useUIStore.getState().setMemberStatus(sessionId, supervisor.id, "idle")
    } catch (err) {
      useUIStore.getState().setMemberStatus(sessionId, supervisor.id, "errored")
      const msg = err instanceof Error ? err.message : String(err)
      useChatStore.getState().setSessionError(sessionId, `${supervisor.name}: ${msg}`)
      return
    }

    if (round >= MAX_SUPERVISOR_ROUNDS) break

    // Inspect the supervisor's freshly-persisted reply for dispatch tags.
    const supervisorText = await readLastAssistantText(sessionId, supervisor.id)
    const dispatches = parseDispatches(supervisorText, members)
    if (dispatches.length === 0) return

    for (const d of dispatches) {
      if (interruptedRef.current.has(sessionId)) return
      const target = members.find((m) => m.id === d.characterId)
      if (!target) continue

      if (useUIStore.getState().isStopRequested(sessionId, target.id)) {
        useUIStore.getState().clearStopRequest(sessionId, target.id)
        continue
      }

      const dSub = subSessionId(sessionId, target.id, `${turnId}d${round}`)
      useUIStore.getState().setMemberStatus(sessionId, target.id, "thinking")
      try {
        await runMemberSubSession({
          session,
          sessionId,
          team,
          character: target,
          members,
          memberByCharId,
          sub: dSub,
          sendContent: `Dispatch from supervisor:\n${d.task}`,
          resolvers,
          turnTwinDeps,
          turnEmbedding,
          turnMemoryDeps,
          turnUserMessage,
        })
        useUIStore.getState().setMemberStatus(sessionId, target.id, "idle")
        const reply = await readLastAssistantText(sessionId, target.id)
        if (reply.trim()) dispatchedReplies.push({ name: target.name, reply })
      } catch (err) {
        useUIStore.getState().setMemberStatus(sessionId, target.id, "errored")
        const msg = err instanceof Error ? err.message : String(err)
        useChatStore.getState().setSessionError(sessionId, `${target.name}: ${msg}`)
      }
    }
    if (dispatchedReplies.length === 0) return
  }
}

function buildSynthesisAddendum(results: { name: string; reply: string }[]): string {
  if (results.length === 0) return ""
  const lines = ["## Dispatch results"]
  for (const r of results) {
    const trimmed = r.reply.trim().replace(/\s+/g, " ")
    const snippet = trimmed.length > 600 ? trimmed.slice(0, 600) + "…" : trimmed
    lines.push(`- ${r.name} replied: ${snippet}`)
  }
  lines.push("")
  lines.push("Synthesize a final answer for the user. Do NOT emit any further <dispatch> tags.")
  return lines.join("\n")
}

// ---- Per-member sub-session driver --------------------------------------

interface RunMemberArgs {
  session: { id: string; scratchpad?: string }
  sessionId: string
  team: Team
  character: Character
  members: Character[]
  memberByCharId: Map<string, TeamMember>
  sub: string
  sendContent: SendContent
  /** Extra text appended to the resolved system prompt before transcript. */
  promptAddendum?: string
  /** Extra metadata to merge into any new assistant messages. */
  messageMetadata?: Record<string, unknown>
  /**
   * Optional post-processor for the persisted assistant text. Used by the
   * supervisor's final round to strip stray dispatch tags.
   */
  postProcessText?: (text: string) => string
  resolvers: ResolverMap
  /** Pre-built twin runtime deps shared across all members for this turn. */
  turnTwinDeps?: TwinDepsForBuild
  /** Pre-computed query embedding for the user message; avoids N×embed cost. */
  turnEmbedding?: number[]
  /** Pre-built long-term-memory read deps shared across all members this turn. */
  turnMemoryDeps?: ApplyMemoryContextDeps
  /** Plain-text user message forwarded to resolveSendOptions for twin RAG. */
  turnUserMessage?: string
}

async function runMemberSubSession(args: RunMemberArgs): Promise<void> {
  const {
    session,
    sessionId,
    character,
    members,
    memberByCharId,
    sub,
    sendContent,
    promptAddendum,
    messageMetadata,
    postProcessText,
    resolvers,
    turnTwinDeps,
    turnEmbedding,
    turnMemoryDeps,
    turnUserMessage,
  } = args

  const referencedPaths = useChatStore
    .getState()
    .referencedPaths.map((r) => ({ absolute: r.absolute, isDir: r.isDir }))
  // Long-term memory recall now runs for team members too: `send` builds the
  // read deps once per turn (`turnMemoryDeps`) and threads them here so every
  // member injects the shared memory store, matching direct chat.
  // One-shot post-compaction recovery: when a compaction boundary just landed in
  // the team transcript with no assistant turn after it, re-inject the recovery
  // preamble so the member treats the new summary as authoritative and keeps
  // team-coordination directives in force across the boundary. Stateless.
  const teamRecoveryPhase = pendingRecoveryPhase(
    useChatStore.getState().sessions[sessionId]?.messages ?? useChatStore.getState().messages
  )
  const baseOpts = await resolveSendOptions({
    session: session as never,
    character,
    appSettings: useSettingsStore.getState().settings,
    memberOverride: memberByCharId.get(character.id),
    referencedPaths,
    twinDeps: turnTwinDeps,
    twinUserMessage: turnUserMessage,
    precomputedQueryEmbedding: turnEmbedding,
    memoryDeps: turnMemoryDeps,
    memoryUserMessage: turnMemoryDeps ? turnUserMessage : undefined,
    twinInjectSource: "team",
    postCompaction: teamRecoveryPhase !== null ? { phaseNumber: teamRecoveryPhase } : undefined,
  })
  const transcript = await buildTranscript(sessionId, character.id, members, session.scratchpad)
  const finalSystemPrompt = [baseOpts.systemPrompt, promptAddendum, transcript]
    .filter((p) => p && p.trim())
    .join("\n\n---\n\n")
  const opts = {
    ...baseOpts,
    ...(finalSystemPrompt ? { systemPrompt: finalSystemPrompt } : {}),
  }

  // Stash extras on the resolver so the event handler can apply them.
  const ctx: SubResolverCtx = {
    senderId: character.id,
    model: opts.model,
    extraMetadata: messageMetadata,
    postProcessText,
    // Recalled-memory transparency: direct chat folds this into the assistant
    // message's SourcesPart at turnComplete; the team path seals per member in
    // `handleTeamEvent`, so thread the context through the resolver ctx.
    memoryContext: baseOpts.memoryContext,
  }
  subResolverCtx.set(sub, ctx)

  const done = new Promise<void>((resolve, reject) => {
    resolvers.set(sub, { resolve, reject })
  })
  try {
    await sendPrompt(sub, sendContent, opts)
    await done
  } finally {
    resolvers.delete(sub)
    subResolverCtx.delete(sub)
    try {
      await closeSession(sub)
    } catch {
      /* sub-session may already be torn down */
    }
  }
}

// ---- Sub-session context map (shared with event handler) -----------------

interface SubResolverCtx {
  senderId: string
  /** Model id resolved for this member's turn — stamped on sessionUsage. */
  model?: string
  extraMetadata?: Record<string, unknown>
  postProcessText?: (text: string) => string
  /** Recalled long-term memories for this member's turn (SourcesPart merge). */
  memoryContext?: MemorySourcesContext
}
const subResolverCtx = new Map<string, SubResolverCtx>()

/**
 * Armed by `regenerate` for one team turn: as each member's fresh reply lands
 * in `handleTeamEvent`, it is stamped with the next `branchIndex` of its
 * per-member branch group (see lib/chat/branch-regen.ts). Cleared in `send`'s
 * finally.
 */
interface PendingTeamBranchTag {
  anchorId: string
  nextIndexByGroup: Map<string, number>
  /** How many new replies each member has produced this turn (occurrence). */
  seenByMember: Map<string, number>
}
const pendingTeamBranchTags = new Map<string, PendingTeamBranchTag>()

// ---- Event handler -------------------------------------------------------

/** Hook-scoped streaming coalescing state threaded into the event handler. */
interface TeamStreamingDeps {
  /** Latest in-flight message list per team session (see `streamMirrorRef`). */
  mirror: Map<string, UIMessage[]>
  /** Per-session rAF commit + debounced persist pairs. */
  registry: SessionCoalescingRegistry
}

async function handleTeamEvent(
  evt: ClaudeEvent,
  allowListRef: React.MutableRefObject<string[]>,
  resolvers: ResolverMap,
  streaming: TeamStreamingDeps
): Promise<void> {
  if (evt.type !== "event" && evt.type !== "session_ended" && evt.type !== "permission_request") {
    return
  }
  if (typeof evt.sessionId !== "string") return
  const decoded = decodeSubSession(evt.sessionId)
  if (!decoded) return
  const { teamSessionId, characterId } = decoded
  // Any open pane (tab / split) streams live into its own slice; only closed
  // (no-pane) sessions stay Dexie-only. `isOpen ⊇ isActive`.
  const isOpen = isSessionOpen(teamSessionId)

  switch (evt.type) {
    case "session_ended": {
      const r = resolvers.get(evt.sessionId)
      if (r) {
        if (evt.error) r.reject(new Error(evt.error))
        else r.resolve()
      }
      return
    }
    case "permission_request": {
      if (allowListRef.current.includes(evt.toolName)) {
        try {
          await approveTool(evt.sessionId, evt.requestId, "allow")
        } catch (err) {
          console.error("auto-approve failed", err)
        }
        return
      }
      if (!isOpen) {
        try {
          await approveTool(evt.sessionId, evt.requestId, "deny", "auto-denied: session not open")
        } catch (err) {
          console.error("non-open deny failed", err)
        }
        return
      }
      const approval: PendingApproval = {
        sessionId: evt.sessionId,
        requestId: evt.requestId,
        toolUseID: evt.toolUseID,
        toolName: evt.toolName,
        input: evt.input,
        title: evt.title,
        displayName: evt.displayName ? `${evt.displayName}` : evt.toolName,
        description: evt.description
          ? `From ${charLabel(characterId)}: ${evt.description}`
          : `From ${charLabel(characterId)}`,
        blockedPath: evt.blockedPath,
        decisionReason: evt.decisionReason,
      }
      useChatStore.getState().pushApproval(approval)
      return
    }
    case "event": {
      const ctx = subResolverCtx.get(evt.sessionId)
      const senderId = ctx?.senderId ?? characterId

      // Mirror-first base read: the store commit may be a frame behind (rAF
      // coalesced) and the Dexie copy a debounce behind, so the mirror holds
      // the only authoritative mid-turn base. Falls back to the store slice /
      // Dexie between turns (mirror entries live only while a turn streams).
      const teamMsgs =
        streaming.mirror.get(teamSessionId) ??
        (isOpen
          ? (useChatStore.getState().sessions[teamSessionId]?.messages ??
            (await listMessages(teamSessionId)))
          : await listMessages(teamSessionId))

      const existingIds = new Set(teamMsgs.map((m) => m.id))
      const { messages: nextMessages, result: sdkResult } = applySdkEvent(teamMsgs, evt.event)

      // Bridge SDK-native subagents (the `opts.agents` / Task-tool path used by
      // team sessions) into the runtime store so they render in the chat
      // subagent tree. Guarded — a bridge throw must never break the team loop.
      try {
        const { applySdkSubagentBridge } = await import("@/lib/claude/sdk-subagent-bridge")
        applySdkSubagentBridge(evt.event, teamSessionId)
      } catch (err) {
        console.warn("sdkSubagentBridge (team) failed", err)
      }

      // Persist per-turn usage + cost for the speaking member. The team
      // assistant message id is the same id we're tagging with senderId
      // below, so capture it before the post-processing slice.
      if (sdkResult) {
        const newAssistant = [...nextMessages]
          .reverse()
          .find((m) => m.role === "assistant" && !existingIds.has(m.id))
        if (newAssistant) {
          await recordResultUsage({
            sessionId: teamSessionId,
            messageId: newAssistant.id,
            characterId: senderId,
            model: ctx?.model,
            result: sdkResult,
          }).catch((err) => {
            console.warn("recordResultUsage (team) failed", err)
          })
        }
      }

      if (nextMessages !== teamMsgs) {
        const pendingBranch = pendingTeamBranchTags.get(teamSessionId)
        let tagged = nextMessages.map((m) => {
          if (existingIds.has(m.id)) return m
          if (m.role !== "assistant") return m
          let extra: Record<string, unknown> = { senderId, ...(ctx?.extraMetadata ?? {}) }
          // Regenerated turn: stamp the fresh reply as the next branch of its
          // per-member group so the old reply survives as a sibling.
          if (pendingBranch) {
            const ord = pendingBranch.seenByMember.get(senderId) ?? 0
            pendingBranch.seenByMember.set(senderId, ord + 1)
            const group = teamBranchGroupId(pendingBranch.anchorId, senderId, ord)
            extra = {
              ...extra,
              branchGroupId: group,
              branchIndex: pendingBranch.nextIndexByGroup.get(group) ?? 0,
            }
          }
          return withMetadata(m, extra)
        })

        // Optional post-processor: rewrite the text part of any *new* assistant
        // message before persisting (used by supervisor round-2 to strip
        // residual <dispatch> tags).
        if (ctx?.postProcessText) {
          tagged = tagged.map((m, idx) => {
            if (existingIds.has(m.id)) return m
            if (m.role !== "assistant") return m
            const newParts = m.parts.map((p) => {
              const t = (p as { type?: string }).type
              if (t !== "text") return p
              const orig = (p as { text?: string }).text ?? ""
              const next = ctx.postProcessText!(orig)
              if (next === orig) return p
              return { ...(p as object), text: next } as typeof p
            })
            void idx
            return { ...m, parts: newParts }
          })
        }

        streaming.mirror.set(teamSessionId, tagged)
        const coalesce = streaming.registry.get(teamSessionId)
        if (sdkResult) {
          // Member turn boundary: drop pending coalesced work and write the
          // final tagged list synchronously (parity with direct chat's
          // turnComplete seal — flush would replay pre-tag args). Fold the
          // member's recalled memories onto its reply first (team↔direct
          // transparency parity — previously dropped on the team path).
          coalesce.commit.cancel()
          coalesce.persist.cancel()
          tagged = mergeMemorySourcesIntoLastAssistant(tagged, ctx?.memoryContext)
          await persistMessages(teamSessionId, tagged)
          if (isOpen) {
            useChatStore.getState().replaceSessionMessages(teamSessionId, tagged)
          }
          streaming.mirror.delete(teamSessionId)
          streaming.registry.release(teamSessionId)
        } else {
          // Mid-stream: coalesce the React commit to ≤1/frame and debounce the
          // Dexie write; the mirror above keeps the next event's base correct.
          if (isOpen) coalesce.commit.call(tagged)
          coalesce.persist.call(tagged)
        }
        if (
          !isOpen &&
          tagged.length > teamMsgs.length &&
          tagged[tagged.length - 1]?.role === "assistant"
        ) {
          await bumpUnread(teamSessionId).catch(() => {})
        }
      }
      return
    }
  }
}

// ---- Helpers -------------------------------------------------------------

function withMetadata(msg: UIMessage, extra: Record<string, unknown>): UIMessage {
  const prior = ((msg as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<
    string,
    unknown
  >
  return {
    ...msg,
    ...({ metadata: { ...prior, ...extra } } as {
      metadata: Record<string, unknown>
    }),
  }
}

function asPlainText(content: SendContent): string {
  if (typeof content === "string") return content
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join(" ")
}

function charLabel(characterId: string): string {
  return characterId
}

/**
 * Find the most recent assistant message authored by `characterId` in this
 * team session (reads from Dexie, not from the in-memory store, so it works
 * for background sessions too).
 */
async function readLastAssistantText(teamSessionId: string, characterId: string): Promise<string> {
  const all = await listMessages(teamSessionId)
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i]
    if (m.role !== "assistant") continue
    const meta = (m as { metadata?: Record<string, unknown> }).metadata
    const senderId = typeof meta?.senderId === "string" ? meta.senderId : undefined
    if (senderId !== characterId) continue
    return textFromParts(m.parts)
  }
  return ""
}

/**
 * Build a transcript for `respondingCharacterId` to read as conversation
 * context. Earlier messages are attributed by speaker name; the responder
 * sees their own prior replies un-prefixed (just like the SDK normally would).
 *
 * If `scratchpad` is non-empty, it's prepended as a "Shared scratchpad" block
 * so every member sees the team's shared notes.
 */
async function buildTranscript(
  teamSessionId: string,
  respondingCharacterId: string,
  members: readonly Character[],
  scratchpad?: string
): Promise<string> {
  const messages = await listMessages(teamSessionId)
  const sections: string[] = []

  if (scratchpad && scratchpad.trim()) {
    sections.push(["## Shared scratchpad", "", scratchpad.trim()].join("\n"))
  }

  if (messages.length === 0) {
    return sections.join("\n\n")
  }

  const byId = new Map(members.map((m) => [m.id, m]))
  const lines: string[] = []
  for (const m of messages) {
    const meta = (m as { metadata?: Record<string, unknown> }).metadata
    const senderId = typeof meta?.senderId === "string" ? meta.senderId : undefined
    const text = textFromParts(m.parts)
    if (!text.trim()) continue

    if (m.role === "user") {
      lines.push(`User: ${text}`)
    } else if (senderId === respondingCharacterId) {
      lines.push(`You: ${text}`)
    } else {
      const speaker = senderId ? (byId.get(senderId)?.name ?? senderId) : "Assistant"
      lines.push(`${speaker}: ${text}`)
    }
  }

  if (lines.length > 0) {
    sections.push(
      [
        "## Conversation context",
        "",
        "You are participating in a multi-agent group chat. The transcript so far is below — `User:` is the human, `You:` is your prior turn, others are your teammates. Reply only with your next turn (no transcript, no prefix).",
        "",
        lines.join("\n"),
      ].join("\n")
    )
  }

  return sections.join("\n\n")
}

function textFromParts(parts: UIMessage["parts"]): string {
  const out: string[] = []
  for (const p of parts) {
    const t = (p as { type?: string }).type
    if (t === "text") {
      out.push((p as { text?: string }).text ?? "")
    }
  }
  return out.join("")
}
