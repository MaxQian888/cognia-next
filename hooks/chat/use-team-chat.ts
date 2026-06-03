"use client"

import { useCallback, useEffect, useRef } from "react"
import type { UnlistenFn } from "@tauri-apps/api/event"
import type { UIMessage } from "ai"
import { applySdkEvent, contentPreview, makeUserMessage } from "@/lib/claude/adapter"
import {
  approveTool,
  closeSession,
  deleteMessage,
  interruptSession,
  onClaudeMessage,
  sendPrompt,
} from "@/lib/claude/ipc"
import { detectPlatform } from "@/hooks/use-platform"
import { getDb } from "@/lib/db/schema"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { runTurnMemory } from "@/lib/memory/run-turn-memory"
import { tryBuildTwinDeps, type TwinDepsForBuild } from "@/lib/twin/runtime/build-deps"
import { generateEmbedding } from "@/lib/ai/embedding/embedding"
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
} from "@/lib/claude/types"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui"
import { isTauri } from "@/lib/tauri"

const SUB_SEPARATOR = "::char::"
const MAX_SUPERVISOR_ROUNDS = 2

/**
 * Build a sub-session id from the team session and character. A turnId suffix
 * keeps successive turns (e.g. regenerates) from colliding with stale resolver
 * entries inside the in-flight orchestrator loop.
 */
function subSessionId(teamSessionId: string, characterId: string, turnId: string): string {
  return `${teamSessionId}${SUB_SEPARATOR}${characterId}::${turnId}`
}

/**
 * Decode a sub-session id into its team-session + character pair, or null if
 * the id isn't a team sub-session. The optional `::turnId` suffix is stripped.
 */
function decodeSubSession(id: string): { teamSessionId: string; characterId: string } | null {
  const idx = id.indexOf(SUB_SEPARATOR)
  if (idx < 0) return null
  const tail = id.slice(idx + SUB_SEPARATOR.length)
  const sep = tail.indexOf("::")
  return {
    teamSessionId: id.slice(0, idx),
    characterId: sep < 0 ? tail : tail.slice(0, sep),
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
 * partition the event stream by `sessionId.includes("::char::")` so they
 * never both react to the same event.
 */
export function useTeamChat() {
  const activeRef = useRef<string | null>(null)
  useEffect(() => {
    const unsub = useChatStore.subscribe((s) => {
      activeRef.current = s.activeSessionId
    })
    activeRef.current = useChatStore.getState().activeSessionId
    return unsub
  }, [])

  const allowListRef = useRef<string[]>([])
  useEffect(() => {
    const unsub = useSettingsStore.subscribe((s) => {
      allowListRef.current = s.settings?.alwaysAllowTools ?? []
    })
    allowListRef.current = useSettingsStore.getState().settings?.alwaysAllowTools ?? []
    return unsub
  }, [])

  const resolvers = useRef<ResolverMap>(new Map())
  const interruptedRef = useRef(false)

  // Cache the original SendContent per team session so regenerate can resend
  // it without losing attachments to the text-only round-trip.
  const lastUserContentRef = useRef<Map<string, SendContent>>(new Map())

  // Subscribe to sidecar events; only react to sub-session-tagged ones.
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: UnlistenFn | null = null
    let cancelled = false

    onClaudeMessage((evt) => {
      void handleTeamEvent(evt, activeRef, allowListRef, resolvers.current).catch((err) => {
        console.error("team handleEvent failed", err)
      })
    })
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
  }, [])

  /**
   * Send a user prompt to every member of the active team session, sequenced
   * by `routeTurn`. Returns once every member has either replied or errored.
   *
   * If the active session isn't a team session, this is a no-op — the caller
   * should fall back to `useClaudeChat.send`.
   *
   * `skipPersistUserTurn` is set internally by `regenerate` so we don't double
   * up the user message after `truncateAfter` has already left it on disk.
   */
  const send = useCallback(async (content: SendContent, skipPersistUserTurn = false) => {
    const sessionId = useChatStore.getState().activeSessionId
    if (!sessionId) {
      useChatStore.getState().setError("No session selected")
      return
    }
    const session = await getSession(sessionId)
    if (!session || session.kind !== "team" || !session.teamId) {
      useChatStore.getState().setError("Team session not found")
      return
    }
    const team = await getTeam(session.teamId)
    if (!team) {
      useChatStore.getState().setError(`Team ${session.teamId} no longer exists`)
      return
    }

    interruptedRef.current = false
    useUIStore.getState().clearStopRequestsFor(sessionId)

    const memberIds = team.members.map((m) => m.characterId)
    const members = await listCharactersByIds(memberIds)
    const memberByCharId = new Map<string, TeamMember>(team.members.map((m) => [m.characterId, m]))
    const userText = asPlainText(content)
    lastUserContentRef.current.set(sessionId, content)

    // Embed the user message ONCE per turn so twin-bound members can share the
    // same query vector rather than each paying an individual embed call.
    let turnTwinDeps: TwinDepsForBuild | undefined
    let turnEmbedding: number[] | undefined
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
    }

    // 1. Persist the user turn first, tagging it as a "user" sender.
    if (!skipPersistUserTurn) {
      const userMsg = withMetadata(makeUserMessage(content), {
        senderKind: "user",
      })
      const before = useChatStore.getState().messages
      const after = [...before, userMsg]
      useChatStore.getState().replaceMessages(after)
      useChatStore.getState().setStatus("streaming")
      useChatStore.getState().setError(null)
      try {
        await persistMessages(sessionId, after)
        await touchSession(sessionId)
        if (session.title === "New conversation" || !session.title) {
          const title = contentPreview(content, 40)
          if (title) await updateSession(sessionId, { title })
        }
      } catch (err) {
        useChatStore.getState().setError(err instanceof Error ? err.message : String(err))
        return
      }
    } else {
      useChatStore.getState().setStatus("streaming")
      useChatStore.getState().setError(null)
    }

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
          turnUserMessage: userText,
        })
      } else {
        const targets = routeTurn(team, members, userText)
        if (targets.length === 0) {
          // `manual` mode → user picks a member explicitly. Stop here.
          useChatStore.getState().setStatus("idle")
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
          turnUserMessage: userText,
        })
      }

      // Long-term memory write parity with direct chat (team↔direct): the team
      // runtime previously only *read* memory (via resolveSendOptions per member)
      // and never wrote it back. Extract from the completed team turn — the user
      // prompt plus the final team reply (last assistant message; for supervisor
      // mode that is the synthesis). Only runs on clean completion: interrupt and
      // error throw past this point, and the manual no-target case returns above.
      const finalMessages = useChatStore.getState().messages
      const lastAssistant = [...finalMessages].reverse().find((m) => m.role === "assistant")
      void runTurnMemory(sessionId, {
        userText,
        assistantText: lastAssistant ? textFromParts(lastAssistant.parts) : "",
        transcript: finalMessages.map((m) => ({ role: m.role, text: textFromParts(m.parts) })),
      })
    } finally {
      useChatStore.getState().setStatus("idle")
      useUIStore.getState().clearMemberStatusFor(sessionId)
      useUIStore.getState().clearStopRequestsFor(sessionId)
    }
  }, [])

  /** Cancel an in-flight team turn. Aborts the current sub-session and
   * stops issuing new ones. */
  const stop = useCallback(async () => {
    interruptedRef.current = true
    const teamSessionId = useChatStore.getState().activeSessionId
    if (!teamSessionId) return
    // Interrupt anything currently sending.
    for (const [sub, r] of resolvers.current.entries()) {
      const decoded = decodeSubSession(sub)
      if (decoded?.teamSessionId !== teamSessionId) continue
      try {
        await interruptSession(sub)
      } catch {
        /* best effort */
      }
      r.reject(new Error("Interrupted"))
    }
    useChatStore.getState().setStatus("idle")
    useUIStore.getState().clearMemberStatusFor(teamSessionId)
  }, [])

  /**
   * Re-issue the most recent user turn for the active team session. Drops
   * every assistant message after the last user turn (covers linear and
   * supervisor modes uniformly) then re-routes the same content.
   */
  const regenerate = useCallback(async () => {
    const sessionId = useChatStore.getState().activeSessionId
    if (!sessionId) return

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
    if (detectPlatform() === "mobile") {
      await mirrorTeamTruncateToDesktop(sessionId, anchor.id)
    }
    // Drop the user message AND everything after it. We then re-call send()
    // with the original content; the user message will be re-persisted via the
    // normal optimistic-append path so attachments survive the round-trip.
    await truncateAfter(sessionId, anchor.id, { inclusive: true })
    const remaining = await listMessages(sessionId)
    useChatStore.getState().replaceMessages(remaining)

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
    await send(content)
  }, [send])

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
    async (messageId: string, newContent: SendContent) => {
      const sessionId = useChatStore.getState().activeSessionId
      if (!sessionId) return
      if (detectPlatform() === "mobile") {
        await mirrorTeamTruncateToDesktop(sessionId, messageId)
      }
      await truncateAfter(sessionId, messageId, { inclusive: true })
      const remaining = await listMessages(sessionId)
      useChatStore.getState().replaceMessages(remaining)
      await send(newContent)
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

  return { send, stop, regenerate, editAndResend, respondToApproval }
}

/**
 * Mobile-only mirror for the team-chat truncate path (mobile completeness
 * Phase 2). Identical contract to `useClaudeChat`'s `mirrorTruncateToDesktop`
 * — fans out a per-message `deleteMessage` RPC to the desktop's Dexie so a
 * mobile-driven edit/regenerate doesn't desync. Errors are best-effort
 * (sync will reconcile later).
 */
async function mirrorTeamTruncateToDesktop(
  sessionId: string,
  anchorMessageId: string
): Promise<void> {
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
        console.warn("mirrorTeamTruncateToDesktop: deleteMessage failed", { id, err })
      }
    }
  } catch (err) {
    console.warn("mirrorTeamTruncateToDesktop failed", err)
  }
}

// ---- Linear orchestration (round_robin / mention / manual-targeted) ------

interface RunCommonArgs {
  session: { id: string; scratchpad?: string }
  sessionId: string
  team: Team
  members: Character[]
  memberByCharId: Map<string, TeamMember>
  turnId: string
  interruptedRef: React.MutableRefObject<boolean>
  resolvers: ResolverMap
  /** Pre-built twin runtime deps shared across all members for this turn. */
  turnTwinDeps?: TwinDepsForBuild
  /** Pre-computed query embedding for the user message; avoids N×embed cost. */
  turnEmbedding?: number[]
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
    turnUserMessage,
  } = args

  for (const character of targets) {
    if (interruptedRef.current) break

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
        turnUserMessage,
      })
      useUIStore.getState().setMemberStatus(sessionId, character.id, "idle")
    } catch (err) {
      useUIStore.getState().setMemberStatus(sessionId, character.id, "errored")
      const msg = err instanceof Error ? err.message : String(err)
      useChatStore.getState().setError(`${character.name}: ${msg}`)
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
    turnUserMessage,
  } = args

  if (!team.supervisorCharacterId) {
    useChatStore.getState().setError("Supervisor team has no supervisor configured")
    return
  }
  const supervisor = members.find((m) => m.id === team.supervisorCharacterId)
  if (!supervisor) {
    useChatStore.getState().setError("Configured supervisor is not a member")
    return
  }

  const dispatchedReplies: { name: string; reply: string }[] = []

  for (let round = 1; round <= MAX_SUPERVISOR_ROUNDS; round++) {
    if (interruptedRef.current) return

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
        turnUserMessage,
      })

      useUIStore.getState().setMemberStatus(sessionId, supervisor.id, "idle")
    } catch (err) {
      useUIStore.getState().setMemberStatus(sessionId, supervisor.id, "errored")
      const msg = err instanceof Error ? err.message : String(err)
      useChatStore.getState().setError(`${supervisor.name}: ${msg}`)
      return
    }

    if (round >= MAX_SUPERVISOR_ROUNDS) break

    // Inspect the supervisor's freshly-persisted reply for dispatch tags.
    const supervisorText = await readLastAssistantText(sessionId, supervisor.id)
    const dispatches = parseDispatches(supervisorText, members)
    if (dispatches.length === 0) return

    for (const d of dispatches) {
      if (interruptedRef.current) return
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
          turnUserMessage,
        })
        useUIStore.getState().setMemberStatus(sessionId, target.id, "idle")
        const reply = await readLastAssistantText(sessionId, target.id)
        if (reply.trim()) dispatchedReplies.push({ name: target.name, reply })
      } catch (err) {
        useUIStore.getState().setMemberStatus(sessionId, target.id, "errored")
        const msg = err instanceof Error ? err.message : String(err)
        useChatStore.getState().setError(`${target.name}: ${msg}`)
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
    turnUserMessage,
  } = args

  const referencedPaths = useChatStore
    .getState()
    .referencedPaths.map((r) => ({ absolute: r.absolute, isDir: r.isDir }))
  // NOTE: long-term memory injection is wired for direct chat only. Team chat
  // builds twin deps + the shared query embedding exactly once per turn; reusing
  // that for memory recall (without a second `tryBuildTwinDeps`) needs a small
  // deps-reuse refactor, deferred to keep the per-turn embed invariant intact.
  const baseOpts = await resolveSendOptions({
    session: session as never,
    character,
    appSettings: useSettingsStore.getState().settings,
    memberOverride: memberByCharId.get(character.id),
    referencedPaths,
    twinDeps: turnTwinDeps,
    twinUserMessage: turnUserMessage,
    precomputedQueryEmbedding: turnEmbedding,
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
}
const subResolverCtx = new Map<string, SubResolverCtx>()

// ---- Event handler -------------------------------------------------------

async function handleTeamEvent(
  evt: ClaudeEvent,
  activeRef: React.MutableRefObject<string | null>,
  allowListRef: React.MutableRefObject<string[]>,
  resolvers: ResolverMap
): Promise<void> {
  if (evt.type !== "event" && evt.type !== "session_ended" && evt.type !== "permission_request") {
    return
  }
  if (typeof evt.sessionId !== "string") return
  const decoded = decodeSubSession(evt.sessionId)
  if (!decoded) return
  const { teamSessionId, characterId } = decoded
  const isActive = teamSessionId === activeRef.current

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
      if (!isActive) {
        try {
          await approveTool(evt.sessionId, evt.requestId, "deny", "auto-denied: session not active")
        } catch (err) {
          console.error("non-active deny failed", err)
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

      const teamMsgs = isActive
        ? useChatStore.getState().messages
        : await listMessages(teamSessionId)

      const existingIds = new Set(teamMsgs.map((m) => m.id))
      const { messages: nextMessages, result: sdkResult } = applySdkEvent(teamMsgs, evt.event)

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
        let tagged = nextMessages.map((m) => {
          if (existingIds.has(m.id)) return m
          if (m.role !== "assistant") return m
          return withMetadata(m, {
            senderId,
            ...(ctx?.extraMetadata ?? {}),
          })
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

        await persistMessages(teamSessionId, tagged)
        if (isActive) {
          useChatStore.getState().replaceMessages(tagged)
        } else if (
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
