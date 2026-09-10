/**
 * The room runner: character-team orchestration with no React in it
 * (ADR-0177, batch 1).
 *
 * # What moved here and why
 *
 * `hooks/chat/use-team-chat.ts` owned routing, transcript building, round
 * planning, supervisor dispatch, per-member sub-sessions and the streaming
 * mirror, all inside a React hook. That meant a paired phone orchestrated the
 * whole round itself (losing the phone mid-turn abandoned the round) and a
 * headless host, which has no React tree, could not run a team room at all.
 *
 * Everything the hook did is now a method on `RoomRunner`, with IO behind
 * `RoomRunnerDeps` and observers behind `RoomRunnerSinks`. The desktop
 * renderer, the headless brain and a node test construct it the same way.
 * The hook is a thin adapter that builds store-backed sinks and forwards.
 *
 * # What did not change
 *
 * The decisions still live in the pure modules they always did:
 * `lib/claude/team-router.ts` (who speaks), `lib/chat/team-transcript.ts`
 * (what each member reads), `lib/claude/team-primary-router.ts` (the smart
 * primary). Members run under one broker lease, one after another or, when
 * the team says `parallel`, all at once over the streaming state keyed by
 * sub-session (`runner-streaming.ts`).
 *
 * # What batch 3 added
 *
 * The room's settings steer the turn: `replyMode` and `mutedMemberIds` go
 * into `planUserTurn`, a composer pick arrives as `targetMemberIds`, the
 * last speaker is sticky for an unaddressed follow-up, a member's
 * `handoffTargets` and `talkativeness` shape the auto rounds, one member can
 * be stopped without stopping the room (`stopMember`), and an auto round
 * waits while the human is typing and stands down once they send.
 */

import type { UIMessage } from "ai"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { createDiagnostic } from "@cognia/diagnostics"
import { toDiagnostic } from "@/lib/diagnostics/to-diagnostic"
import { drainProjectHistoryEvidence } from "@/lib/claude/project-history-evidence-registry"
import {
  applySdkEvent,
  makeUserMessage,
  mergeAgentKnowledgeSourcesIntoLastAssistant,
  mergeMemorySourcesIntoLastAssistant,
  mergeProjectClaimSourcesIntoLastAssistant,
  mergeProjectHistorySourcesIntoLastAssistant,
  mergeProjectKnowledgeSourcesIntoLastAssistant,
  mergeTwinSourcesIntoLastAssistant,
  mergeWebSearchSourcesIntoLastAssistant,
} from "@/lib/claude/adapter"
import { shouldGenerateTitle, isPlaceholderTitle } from "@/lib/ai/generation/run-title-task"
import { markTitleFailed, clearTitleRetry } from "@/lib/ai/generation/title-retry"
import { smartContentPreview } from "@/lib/ai/generation/smart-preview"
import { resolveMemoryConfig } from "@/types/memory/memory"
import type { ApplyMemoryContextDeps } from "@/lib/memory/runtime/apply-memory-context"
import type { TwinDepsForBuild } from "@/lib/twin/runtime/build-deps"
import { attachInteractiveGrounding } from "@/lib/rag/chat-grounding"
import {
  buildSupervisorRoster,
  parseDispatches,
  holdReasonFor,
  parseMentions,
  planAutoRound,
  hasHandoffStopToken,
  routeTurn,
  stickyResponderOf,
  stripDispatches,
  stripHandoffStopToken,
  type AutoRoundStop,
  type TeamReply,
} from "@/lib/claude/team-router"
import { canSendMessage, type RecentMessage } from "@/lib/ai/agent/team/message-guard"
import {
  duplicateTeamResponseIds,
  resolveTeamResponseCap,
  selectPrimaryResponder,
} from "@/lib/claude/team-primary-router"
import {
  buildTeamTranscript,
  textFromParts,
  type TeamTranscriptMessage,
} from "@/lib/chat/team-transcript"
import {
  attachRunMetadataToLastAssistant,
  buildCompletedRunMetadata,
} from "@/lib/chat/message-run-metadata"
import type {
  ApprovalDecision,
  ChatSession,
  Character,
  ClaudeEvent,
  PendingApproval,
  SendContent,
  SendOptions,
  Team,
  TeamMember,
  MessageReplyTo,
} from "@cognia/agent-config-types"
import { subSessionId, decodeSubSession } from "@/lib/claude/team-session-id"
import { steerBlocksOf, steerTextOf, type SteerMessageMeta } from "@/lib/claude/steer"
import {
  senderIdOf,
  tagBranchSiblings,
  tagEditSibling,
  teamBranchGroupId,
} from "@/lib/chat/branch-regen"
import { SessionCoalescingRegistry } from "@/hooks/chat/stream-coalescing"
import { renderWorkingSetForCompaction } from "@/lib/chat/working-set"
import { RoutingAttemptController } from "@cognia/provider-routing"
import { DEFAULT_ROUTING_CONFIG } from "@cognia/provider-types/model-mapping"
import { resolveRoomSettings, buildRoomInstructionsSection } from "./settings"
import type { ResolvedRoomSettings } from "./types"
import { RoomStreamRegistry } from "./runner-streaming"
import { deriveMemberActivity } from "./member-activity"
import type { RoomRunnerDeps, RoomRunnerSinks } from "./runner-deps"

const MAX_SUPERVISOR_ROUNDS = 2
/** A running tool with no result after this long stops being reported as the member's activity. */
export const ACTIVITY_STALE_MS = 90_000
/** A keystroke this recent means the human is mid-sentence, and an auto round waits. */
export const TYPING_WINDOW_MS = 4_000
/** The longest an auto round waits for the human, so a half-typed draft cannot park the room. */
export const TYPING_YIELD_MAX_MS = 20_000
/** How often a waiting auto round re-reads the typing signal and the steer queue. */
export const TYPING_POLL_MS = 250

/** Options for a room send. `sessionId` is required here: the hook resolves
 * the active pane, the RPC arm carries it explicitly. */
export interface RoomSendOptions {
  sessionId: string
  /** Attachment provenance for the optimistic user message. */
  attachmentManifest?: readonly AttachmentManifestEntry[]
  skipPersistUserTurn?: boolean
  /**
   * This turn is the steer queue replaying itself. Like `skipPersistUserTurn`
   * it must not write a second user message, but it IS a genuine user turn.
   */
  steerDrain?: boolean
  /** Stamp an edited replacement into the original user message's branch group. */
  branchTag?: { groupId: string; index: number }
  /** Search sources resolved by the composer before this team turn. */
  webSearchContext?: SendOptions["webSearchContext"]
  /**
   * The message this turn answers (ADR-0177 batch 2). Stamped as
   * `metadata.replyTo` on the user row and read by the transcript, so every
   * member sees which message the user was answering.
   */
  replyTo?: MessageReplyTo
  /**
   * Who wrote the user turn, when it did not come from this host's own
   * composer. Stamped as `collaboration.author` so `resolveMessageSpeaker`
   * can name the person, and never trusted from a raw client payload.
   */
  author?: { kind: "human"; id: string; displayName?: string; source?: string }
  /**
   * The members the user picked in the composer (ADR-0177 batch 3), in pick
   * order. Routes above every policy, mute and reply mode included, the way
   * an explicit `@` does. This is how a `manual` team gets its reply.
   */
  targetMemberIds?: readonly string[]
}

interface SubResolver {
  resolve: () => void
  reject: (err: Error) => void
}
type ResolverMap = Map<string, SubResolver>

interface SubResolverCtx {
  senderId: string
  providerId?: string
  model?: string
  startedAt: number
  extraMetadata?: Record<string, unknown>
  postProcessText?: (text: string) => string
  options: SendOptions
  onRoutingCommit?: () => void
}

interface PendingBranchTag {
  anchorId: string
  nextIndexByGroup: Map<string, number>
  seenByMember: Map<string, number>
}

interface RunCommonArgs {
  session: ChatSession
  sessionId: string
  team: Team
  members: Character[]
  memberByCharId: Map<string, TeamMember>
  roomSettings: ResolvedRoomSettings
  turnId: string
  turnTwinDeps?: TwinDepsForBuild
  turnEmbedding?: number[]
  turnMemoryDeps?: ApplyMemoryContextDeps
  turnUserMessage?: string
}

interface RunLinearArgs extends RunCommonArgs {
  content: SendContent
  targets: Character[]
  stopRequests?: Set<string>
}

interface RunMemberArgs {
  session: ChatSession
  sessionId: string
  team: Team
  character: Character
  members: Character[]
  memberByCharId: Map<string, TeamMember>
  sub: string
  sendContent: SendContent
  promptAddendum?: string
  messageMetadata?: Record<string, unknown>
  postProcessText?: (text: string) => string
  turnTwinDeps?: TwinDepsForBuild
  turnEmbedding?: number[]
  turnMemoryDeps?: ApplyMemoryContextDeps
  turnUserMessage?: string
}

/** Neither a drain nor a regenerate writes the user turn a second time. */
function skipsUserTurn(opts: RoomSendOptions): boolean {
  return Boolean(opts.skipPersistUserTurn || opts.steerDrain)
}

const isInterruption = (err: unknown): boolean =>
  err instanceof Error && err.message === "Interrupted"

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class RoomRunner {
  private readonly resolvers: ResolverMap = new Map()
  private readonly eventQueues = new Map<string, Promise<void>>()
  private readonly interrupted = new Set<string>()
  /** Member sub-sessions the user stopped on their own, without stopping the room. */
  private readonly memberStops = new Set<string>()
  private readonly streams = new RoomStreamRegistry()
  private readonly coalescing: SessionCoalescingRegistry
  private readonly subCtx = new Map<string, SubResolverCtx>()
  private readonly pendingBranchTags = new Map<string, PendingBranchTag>()
  private readonly pendingWebSearch = new Map<string, SendOptions["webSearchContext"]>()
  private readonly lastUserContent = new Map<string, SendContent>()
  /** Per member sub-session: the activity last published and its stale timer. */
  private readonly activity = new Map<
    string,
    { label: string | null; timer: ReturnType<typeof setTimeout> | null }
  >()
  private disposed = false

  constructor(
    private readonly deps: RoomRunnerDeps,
    private readonly sinks: RoomRunnerSinks
  ) {
    this.coalescing = new SessionCoalescingRegistry({
      onCommit: (sub) => {
        const roomId = decodeSubSession(sub)?.teamSessionId
        if (roomId && this.sinks.messages.isOpen(roomId)) {
          this.sinks.messages.commit(roomId, this.streams.compose(roomId))
        }
      },
      onPersist: (sub) => {
        const roomId = decodeSubSession(sub)?.teamSessionId
        if (!roomId) return
        void this.deps.db
          .persistMessages(roomId, this.streams.compose(roomId))
          .catch((err) => console.error("team debounced persistMessages failed", err))
      },
      persistDelayMs: this.deps.persistDelayMs,
    })
  }

  /** Flush pending streaming writes and forget every room. */
  dispose(): void {
    this.disposed = true
    for (const entry of this.activity.values()) if (entry.timer) clearTimeout(entry.timer)
    this.activity.clear()
    this.coalescing.flushAllPersist()
    this.coalescing.clear()
    this.streams.clear()
  }

  // ---- Event intake ------------------------------------------------------

  /**
   * Feed one sidecar event. Events are serialized per member sub-session: a
   * result event persists before `session_ended` resolves the member turn,
   * and without the queue the orchestration could read the transcript while
   * the sealed reply was still absent from it.
   */
  handleEvent(evt: ClaudeEvent): void {
    const key =
      typeof (evt as { sessionId?: unknown }).sessionId === "string"
        ? (evt as { sessionId: string }).sessionId
        : "__nosession__"
    const tail = (this.eventQueues.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.applyEvent(evt))
      .catch((err) => {
        console.error("team handleEvent failed", err)
      })
    this.eventQueues.set(key, tail)
    void tail.finally(() => {
      if (this.eventQueues.get(key) === tail) this.eventQueues.delete(key)
    })
  }

  // ---- Public actions ----------------------------------------------------

  async send(content: SendContent, opts: RoomSendOptions): Promise<void> {
    const { sessionId } = opts
    const { deps, sinks } = this

    if (deps.execution.isAtCapacity("ai-turn", sessionId)) {
      console.warn("room send blocked: concurrent stream cap reached", { sessionId })
      return
    }

    // Steer instead of a concurrent orchestration loop: a fresh user turn
    // while THIS room is still streaming would start a second orchestrator
    // over half-written state. Queue it and replay once the turn settles.
    if (!skipsUserTurn(opts)) {
      const st = sinks.status.get(sessionId)
      if (st === "streaming" || st === "awaiting_approval") {
        const text = steerTextOf(content)
        const blocks = steerBlocksOf(content)
        if (!text && blocks.length === 0) return
        const entryId = crypto.randomUUID()
        const steerMeta: SteerMessageMeta = { entryId, state: "queued" }
        const optimistic = withMetadata(
          makeUserMessage(content, undefined, opts.attachmentManifest),
          { senderKind: "user", steer: steerMeta, ...replyMetadata(opts), ...authorMetadata(opts) }
        )
        sinks.steer.appendMessage(sessionId, optimistic)
        sinks.steer.enqueue(sessionId, {
          id: entryId,
          text,
          blocks: blocks.length > 0 ? blocks : undefined,
          webSearchContext: opts.webSearchContext,
          ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
        })
        return
      }
    }

    const session = await deps.db.getSession(sessionId)
    if (!session || session.kind !== "team" || !session.teamId) {
      sinks.diagnostic(
        sessionId,
        createDiagnostic("teamSessionMissing", { source: "agent-team", meta: { sessionId } })
      )
      return
    }
    if (opts.webSearchContext) this.pendingWebSearch.set(sessionId, opts.webSearchContext)
    else this.pendingWebSearch.delete(sessionId)
    const team = await deps.db.getTeam(session.teamId)
    if (!team) {
      sinks.diagnostic(
        sessionId,
        createDiagnostic("teamMissing", {
          source: "agent-team",
          meta: { sessionId, extra: { teamId: session.teamId } },
        })
      )
      return
    }

    this.interrupted.delete(sessionId)
    sinks.members.clearStopRequestsFor(sessionId)

    const memberIds = team.members.map((m) => m.characterId)
    const members = await deps.db.listCharactersByIds(memberIds)
    const memberByCharId = new Map<string, TeamMember>(team.members.map((m) => [m.characterId, m]))
    const userText = asPlainText(content)
    this.lastUserContent.set(sessionId, content)

    // Embed the user message ONCE per turn so twin-bound members can share the
    // same query vector, and build the memory read deps once for the same reason.
    let turnTwinDeps: TwinDepsForBuild | undefined
    let turnEmbedding: number[] | undefined
    let turnMemoryDeps: ApplyMemoryContextDeps | undefined
    const roomSettings = resolveRoomSettings(session)
    if (userText.trim()) {
      turnTwinDeps = await deps.ai.tryBuildTwinDeps()
      if (turnTwinDeps) {
        try {
          const result = await deps.ai.generateSafeEmbedding(userText, {
            profileId: "team-chat-shared",
            purpose: "query",
            embedding: turnTwinDeps.embedding,
            vectorBackend: turnTwinDeps.vectorBackend ?? "native",
          })
          turnEmbedding = result.embedding
        } catch {
          turnEmbedding = undefined
        }
      }
      // A room whose memory is switched off never builds the read deps, so no
      // member can recall a private memory into a room it does not belong in.
      if (roomSettings.memory) {
        turnMemoryDeps = await deps.ai.tryBuildMemoryDeps(
          resolveMemoryConfig(sinks.settings.read()?.memory),
          turnTwinDeps
        )
      }
    }

    // 1. Persist the user turn first, tagging it as a "user" sender.
    let instantPreviewTitle: string | undefined
    if (!skipsUserTurn(opts)) {
      const userMsg = withMetadata(makeUserMessage(content, undefined, opts.attachmentManifest), {
        senderKind: "user",
        ...replyMetadata(opts),
        ...authorMetadata(opts),
      })
      if (opts.branchTag) {
        ;(userMsg as { metadata?: Record<string, unknown> }).metadata = {
          ...((userMsg as { metadata?: Record<string, unknown> }).metadata ?? {}),
          branchGroupId: opts.branchTag.groupId,
          branchIndex: opts.branchTag.index,
        }
        sinks.messages.setActiveBranch(sessionId, opts.branchTag.groupId, userMsg.id)
      }
      const before = sinks.messages.read(sessionId) ?? (await deps.db.listMessages(sessionId))
      const after = [...before, userMsg]
      sinks.messages.commit(sessionId, after)
      try {
        await deps.db.persistMessages(sessionId, after)
        await deps.db.touchSession(sessionId)
        if (isPlaceholderTitle(session.title)) {
          const title = smartContentPreview(content, 40)
          if (title) {
            instantPreviewTitle = title
            await deps.db.updateSession(sessionId, { title, titleAuto: true })
          }
        }
      } catch (err) {
        sinks.diagnostic(
          sessionId,
          toDiagnostic(err, { source: "agent-team", meta: { sessionId } })
        )
        return
      }
    }

    // Register the team turn with the execution broker (one lease for the
    // whole sequential fan-out). Best effort: a broker hiccup never blocks
    // the committed turn.
    const turnCwd = await deps.execution.resolveEffectiveCwdForSession(session).catch(() => null)
    try {
      await deps.execution.acquireChatLease({
        sessionId,
        projectId: session.projectId,
        label: session.title || team.name || `#${sessionId.slice(0, 8)}`,
        kind: "team",
        slotKey: deps.execution.slotKeyForTurn({
          executionContext: session.executionContext,
          effectiveCwd: turnCwd,
        }),
        onCancel: () => {
          this.interrupted.add(sessionId)
          void this.interruptTurn(sessionId)
        },
      })
    } catch (leaseErr) {
      console.warn("team chat lease acquire failed; sending without admission", leaseErr)
    }
    // Clear any stale error BEFORE flipping to streaming: setError(null) resets
    // status to idle, so the reverse order would strand the run status.
    sinks.status.setError(sessionId, null)
    sinks.status.set(sessionId, "streaming")

    const turnId = deps.newTurnId()

    // 2. Branch on orchestration. Supervisor has its own multi-round loop.
    try {
      const muted = new Set(roomSettings.mutedMemberIds)
      const picked = (opts.targetMemberIds ?? []).length > 0
      let primaryCharacterId: string | undefined
      if (
        team.orchestration === "mention_round_robin" &&
        roomSettings.replyMode === "auto" &&
        !picked &&
        parseMentions(userText, members).length === 0
      ) {
        // The smart primary picks among the members the room may pick on its
        // own, and is told who spoke last: a follow-up that names nobody most
        // often continues the exchange the user was just having.
        const candidates = members.filter((member) => !muted.has(member.id))
        const history = sinks.messages.read(sessionId) ?? (await deps.db.listMessages(sessionId))
        const primary = await selectPrimaryResponder({
          client: deps.ai.buildUtilityLlmClient({
            session,
            appSettings: sinks.settings.read(),
            featureId: "team-primary-router",
          }) as never,
          userText,
          members: candidates,
          memberByCharId,
          sticky: stickyResponderOf(history, candidates),
        })
        primaryCharacterId = primary?.id
      }
      const routeOptions = {
        mutedMemberIds: roomSettings.mutedMemberIds,
        explicitTargetIds: opts.targetMemberIds,
        replyMode: roomSettings.replyMode,
      }
      const targets = routeTurn(team, members, userText, primaryCharacterId, routeOptions)
      const held = holdReasonFor(team, targets, routeOptions)
      const common: RunCommonArgs = {
        session,
        sessionId,
        team,
        members,
        memberByCharId,
        roomSettings,
        turnId,
        turnTwinDeps,
        turnEmbedding,
        turnMemoryDeps,
        turnUserMessage: userText,
      }

      if (held) {
        // The room chose silence: asleep, unmentioned in mention_only, or a
        // manual team with no pick. The turn is stored, the composer says why.
        sinks.status.set(sessionId, "idle")
        return
      }
      if (team.orchestration === "supervisor" && targets.length === 0) {
        await this.runSupervisorTurn(common)
      } else {
        if (targets.length === 0) {
          sinks.status.set(sessionId, "idle")
          return
        }
        const stopRequests = new Set<string>()
        await this.runLinearTurn({ ...common, content, targets, stopRequests })
        await this.runAutoRounds({ ...common, content, firstRoundTargets: targets, stopRequests })
      }

      // Long-term memory write parity with direct chat. Only on clean completion.
      const finalMessages =
        sinks.messages.read(sessionId) ?? (await deps.db.listMessages(sessionId))
      const lastAssistant = [...finalMessages].reverse().find((m) => m.role === "assistant")
      if (roomSettings.memory) {
        void deps.ai.runTurnMemory(sessionId, {
          userText,
          assistantText: lastAssistant ? textFromParts(lastAssistant.parts) : "",
          assistantMessageId: lastAssistant?.id,
          transcript: finalMessages.map((m) => ({
            id: m.id,
            role: m.role,
            text: textFromParts(m.parts),
            parts: m.parts,
          })),
        })
      }

      // Conversation-title upgrade, parity with direct chat.
      const settings = sinks.settings.read()
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
        const sourceText = firstUser ? textFromParts(firstUser.parts) : userText
        const resultText = firstAssistant ? textFromParts(firstAssistant.parts) : undefined
        const locale = settings?.language
        void deps.ai
          .runTitleTask({
            session,
            appSettings: settings,
            override: titleCfg,
            featureId: "conversation-title",
            sourceText,
            resultText,
            locale,
            currentTitle: instantPreviewTitle ?? session.title,
            dedupKey: sessionId,
            isStillAuto: async () => {
              const fresh = await deps.db.getSession(sessionId).catch(() => undefined)
              return !fresh || fresh.titleAuto !== false
            },
            persist: (title: string) =>
              deps.db.updateSession(sessionId, { title, titleAuto: true }),
          })
          .then((titleResult) => {
            if (titleResult) clearTitleRetry(sessionId)
            else markTitleFailed(sessionId, { sourceText, resultText, locale })
          })
      }
    } finally {
      // Seal any coalesced streaming state left by this turn (interrupt and
      // error paths can end mid-stream), then drop the room's stream state so
      // the next turn re-reads a fresh base.
      for (const sub of this.streams.activeSubSessions(sessionId)) {
        const pair = this.coalescing.get(sub)
        pair.commit.flush()
        pair.persist.flush()
        this.coalescing.release(sub)
      }
      this.streams.release(sessionId)
      const hadError = sinks.status.get(sessionId) === "error"
      const wasInterrupted = this.interrupted.has(sessionId)
      this.pendingBranchTags.delete(sessionId)
      this.pendingWebSearch.delete(sessionId)
      for (const sub of [...this.memberStops]) {
        if (decodeSubSession(sub)?.teamSessionId === sessionId) this.memberStops.delete(sub)
      }
      sinks.status.set(sessionId, "idle")
      sinks.members.clearFor(sessionId)
      sinks.members.clearStopRequestsFor(sessionId)
      if ((!hadError && !wasInterrupted) || sinks.steer.armed.has(sessionId)) {
        this.drainSteerInto(sessionId)
      }
    }
  }

  /** Cancel an in-flight room turn. Aborts the current sub-session and stops issuing new ones. */
  async stop(sessionId: string): Promise<void> {
    this.interrupted.add(sessionId)
    // Plain stop discards any queued steer, the user is taking over.
    this.sinks.steer.clear(sessionId)
    this.sinks.steer.armed.delete(sessionId)
    // Release the visible state before waiting for every interrupt ack.
    this.sinks.status.set(sessionId, "idle")
    this.sinks.members.clearFor(sessionId)
    this.sinks.members.clearStopRequestsFor(sessionId)
    await this.interruptTurn(sessionId)
  }

  /**
   * Stop one member without stopping the room (ADR-0177 batch 3). A member
   * that is mid-reply is interrupted and its partial reply stays; one that
   * has not started yet is skipped when its turn comes. The others go on,
   * and the auto rounds still run.
   */
  async stopMember(sessionId: string, characterId: string): Promise<void> {
    this.sinks.members.requestStop(sessionId, characterId)
    for (const [sub, r] of this.resolvers.entries()) {
      const decoded = decodeSubSession(sub)
      if (decoded?.teamSessionId !== sessionId || decoded.characterId !== characterId) continue
      this.memberStops.add(sub)
      try {
        await this.deps.ipc.interruptSession(sub)
      } catch {
        /* best effort */
      }
      r.reject(new Error("Interrupted"))
    }
  }

  /** Cut the running turn short so its settle replays the queued steer. */
  async interruptAndSteer(sessionId: string): Promise<void> {
    if (this.sinks.steer.queue(sessionId).length === 0) return
    this.sinks.steer.armed.add(sessionId)
    this.interrupted.add(sessionId)
    await this.interruptTurn(sessionId)
  }

  /** Replay a session's queued steer NOW, without a turn boundary. */
  flushSteer(sessionId: string): void {
    this.drainSteerInto(sessionId)
  }

  /**
   * Re-issue the most recent user turn. Non-destructive: existing replies
   * become branches, tagged per member.
   */
  async regenerate(sessionId: string): Promise<void> {
    const messages =
      this.sinks.messages.read(sessionId) ?? (await this.deps.db.listMessages(sessionId))
    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx < 0) return

    const anchor = messages[lastUserIdx]
    const seen = new Map<string, number>()
    const { merged, nextIndexByGroup } = tagBranchSiblings(messages, lastUserIdx, (m) => {
      const senderId = senderIdOf(m)
      const ord = seen.get(senderId) ?? 0
      seen.set(senderId, ord + 1)
      return teamBranchGroupId(anchor.id, senderId, ord)
    })
    this.sinks.messages.commit(sessionId, merged)
    await this.deps.db.persistMessages(sessionId, merged)

    this.pendingBranchTags.set(sessionId, {
      anchorId: anchor.id,
      nextIndexByGroup,
      seenByMember: new Map(),
    })

    const cached = this.lastUserContent.get(sessionId)
    const content: SendContent =
      cached ??
      anchor.parts
        .filter(
          (p): p is { type: "text"; text: string } => (p as { type?: string }).type === "text"
        )
        .map((p) => p.text)
        .join("")
    await this.send(content, { sessionId, skipPersistUserTurn: true })
  }

  /** Edit a sent user message without destroying the turn below it. */
  async editAndResend(
    sessionId: string,
    messageId: string,
    newContent: SendContent
  ): Promise<void> {
    const messages =
      this.sinks.messages.read(sessionId) ?? (await this.deps.db.listMessages(sessionId))
    const editedIdx = messages.findIndex((message) => message.id === messageId)
    if (editedIdx < 0) return
    const { merged, groupId, nextIndex } = tagEditSibling(messages, editedIdx)
    this.sinks.messages.commit(sessionId, merged)
    await this.deps.db.persistMessages(sessionId, merged)
    await this.send(newContent, { sessionId, branchTag: { groupId, index: nextIndex } })
  }

  /** Approve or deny a tool call on a member sub-session. */
  async respondToApproval(approval: PendingApproval, decision: ApprovalDecision): Promise<void> {
    if (decision === "allow_always") {
      await this.sinks.settings.toggleAlwaysAllow(approval.toolName, true)
    }
    await this.deps.ipc.approveTool(
      approval.sessionId,
      approval.requestId,
      decision === "allow_always" ? "allow" : decision
    )
    await this.deps.ai.recordChatToolApprovalDecision(approval, decision)
    this.sinks.approvals.clear(approval.requestId)
  }

  // ---- Internals ---------------------------------------------------------

  /**
   * Publish a member's activity string when it changed, and arm a stale
   * timer so a tool whose result never arrives does not pin the label on
   * the member forever. `null` clears both.
   */
  private publishActivity(
    roomId: string,
    characterId: string,
    sub: string,
    label: string | null
  ): void {
    const entry = this.activity.get(sub)
    if ((entry?.label ?? null) === label) return
    if (entry?.timer) clearTimeout(entry.timer)
    if (label === null) {
      this.activity.delete(sub)
      if (entry) this.sinks.members.setActivity(roomId, characterId, null)
      return
    }
    const timer = setTimeout(() => {
      this.activity.delete(sub)
      this.sinks.members.setActivity(roomId, characterId, null)
    }, ACTIVITY_STALE_MS)
    this.activity.set(sub, { label, timer })
    this.sinks.members.setActivity(roomId, characterId, label)
  }

  private drainSteerInto(sessionId: string): void {
    this.sinks.steer.drain(sessionId, (payload, webSearchContext, replyTo) => {
      void this.send(payload, {
        sessionId,
        steerDrain: true,
        webSearchContext,
        ...(replyTo ? { replyTo } : {}),
      })
    })
  }

  /** Interrupt every in-flight sub-session of `roomId` and reject its resolvers. */
  private async interruptTurn(roomId: string): Promise<void> {
    for (const [sub, r] of this.resolvers.entries()) {
      const decoded = decodeSubSession(sub)
      if (decoded?.teamSessionId !== roomId) continue
      try {
        await this.deps.ipc.interruptSession(sub)
      } catch {
        /* best effort */
      }
      r.reject(new Error("Interrupted"))
    }
  }

  /**
   * One round of replies. Sequential by default, so each member reads the
   * replies before it. `parallel` starts every member at once over the same
   * base; the streaming registry keeps their partial output apart and folds
   * each reply as it lands.
   */
  private async runLinearTurn(args: RunLinearArgs): Promise<void> {
    const { sessionId, targets } = args
    if (args.team.replyConcurrency === "parallel") {
      await Promise.all(targets.map((character) => this.runOneMember(args, character)))
      return
    }
    for (const character of targets) {
      if (this.interrupted.has(sessionId)) break
      await this.runOneMember(args, character)
    }
  }

  private async runOneMember(args: RunLinearArgs, character: Character): Promise<void> {
    const { sessionId, turnId } = args
    const { sinks } = this
    if (this.interrupted.has(sessionId)) return

    // Per-member stop check: skip this one but keep going.
    if (sinks.members.isStopRequested(sessionId, character.id)) {
      sinks.members.clearStopRequest(sessionId, character.id)
      sinks.members.setStatus(sessionId, character.id, "idle")
      return
    }

    const sub = subSessionId(sessionId, character.id, turnId)
    sinks.members.setStatus(sessionId, character.id, "thinking")

    try {
      await this.runMemberSubSession({
        session: args.session,
        sessionId,
        team: args.team,
        character,
        members: args.members,
        memberByCharId: args.memberByCharId,
        sub,
        sendContent: args.content,
        // The handoff protocol is between the members. A reader seeing
        // the stop token in a reply is reading our plumbing.
        postProcessText: (text) => {
          if (hasHandoffStopToken(text)) args.stopRequests?.add(character.id)
          return stripHandoffStopToken(text)
        },
        turnTwinDeps: args.turnTwinDeps,
        turnEmbedding: args.turnEmbedding,
        turnMemoryDeps: args.turnMemoryDeps,
        turnUserMessage: args.turnUserMessage,
      })
      sinks.members.setStatus(sessionId, character.id, "idle")
    } catch (err) {
      if (isInterruption(err) && this.memberStops.has(sub) && !this.interrupted.has(sessionId)) {
        // The user stopped this one member. Not a fault, and not the room's
        // stop either: the partial reply stays and the round goes on.
        this.memberStops.delete(sub)
        sinks.members.clearStopRequest(sessionId, character.id)
        sinks.members.setStatus(sessionId, character.id, "idle")
        return
      }
      sinks.members.setStatus(sessionId, character.id, "errored")
      sinks.diagnostic(
        sessionId,
        toDiagnostic(err, {
          source: "agent-team",
          meta: { sessionId, extra: { memberName: character.name, characterId: character.id } },
        })
      )
    }
  }

  /**
   * Before an auto round: wait while the human is typing, and stand down if
   * they sent something (a queued steer) or stopped the room. A room that
   * talks over the person composing a reply to it is the thing SillyTavern's
   * group mode taught everyone to switch off, so the wait is the default
   * and bounded by `TYPING_YIELD_MAX_MS`.
   */
  private async yieldToHuman(sessionId: string): Promise<"go" | "taken-over"> {
    const deadline = this.deps.now() + TYPING_YIELD_MAX_MS
    for (;;) {
      if (this.interrupted.has(sessionId)) return "taken-over"
      if (this.sinks.steer.queue(sessionId).length > 0) return "taken-over"
      const typedAt = this.sinks.human.lastTypedAt(sessionId)
      const now = this.deps.now()
      if (typedAt === null || now - typedAt >= TYPING_WINDOW_MS || now >= deadline) return "go"
      await (this.deps.sleep ?? defaultSleep)(TYPING_POLL_MS)
    }
  }

  /**
   * Let the room keep talking when a member hands the floor to a teammate.
   * The decision is `planAutoRound`, kept pure so the three ceilings that
   * stop this thing are testable. `canSendMessage` drops idle acks and
   * duplicate handoffs, the two ways a room burns rounds saying nothing.
   */
  private async runAutoRounds(
    args: Omit<RunLinearArgs, "targets"> & { firstRoundTargets: Character[] }
  ): Promise<void> {
    const { sessionId, team, members, firstRoundTargets } = args
    const stopRequests = args.stopRequests ?? new Set<string>()
    const maxAutoRounds = Math.max(0, Math.trunc(team.maxAutoRounds ?? 0))
    if (maxAutoRounds === 0) return

    const responseCap = resolveTeamResponseCap(team.maxResponses)
    const spokenIds: string[] = firstRoundTargets.map((member) => member.id)
    let lastRoundTargets = firstRoundTargets
    const recentMessages: RecentMessage[] = []

    for (let round = 0; ; round++) {
      if (this.interrupted.has(sessionId)) return

      const replies: TeamReply[] = []
      for (const member of lastRoundTargets) {
        const stopRequested = stopRequests.has(member.id)
        const text = await this.readLastAssistantText(sessionId, member.id)
        if (!text.trim()) {
          if (stopRequested) replies.push({ characterId: member.id, text: "", stopRequested: true })
          continue
        }
        const decision = canSendMessage({
          senderId: member.id,
          content: text,
          now: this.deps.now(),
          recentMessages,
        })
        if (!decision.allow) continue
        recentMessages.push({ senderId: member.id, content: text, createdAt: this.deps.now() })
        replies.push({ characterId: member.id, text, stopRequested })
      }

      const plan = planAutoRound({
        replies,
        members,
        spokenCount: spokenIds.length,
        responseCap,
        round,
        maxAutoRounds,
        spokenIds,
        mutedMemberIds: args.roomSettings.mutedMemberIds,
        slots: args.memberByCharId,
        random: this.deps.random,
      })
      if (plan.targets.length === 0) {
        this.reportChainCapped(sessionId, plan.stop)
        return
      }
      // Only once there is something to run: a room that has finished has
      // nothing to wait for.
      if ((await this.yieldToHuman(sessionId)) === "taken-over") return

      await this.runLinearTurn({ ...args, targets: plan.targets })
      spokenIds.push(...plan.targets.map((member) => member.id))
      lastRoundTargets = plan.targets
    }
  }

  /** Say so when the room was cut off mid-conversation, and only then. */
  private reportChainCapped(sessionId: string, stop: AutoRoundStop | null): void {
    if (stop !== "budget" && stop !== "cap" && stop !== "repeat") return
    this.sinks.diagnostic(
      sessionId,
      createDiagnostic("handoffChainCapped", {
        source: "agent-team",
        meta: { sessionId, extra: { stop } },
      })
    )
  }

  private async runSupervisorTurn(args: RunCommonArgs): Promise<void> {
    const { session, sessionId, team, members, memberByCharId, turnId } = args
    const { sinks } = this

    if (!team.supervisorCharacterId) {
      sinks.diagnostic(
        sessionId,
        createDiagnostic("supervisorMissing", { source: "agent-team", meta: { sessionId } })
      )
      return
    }
    const supervisor = members.find((m) => m.id === team.supervisorCharacterId)
    if (!supervisor) {
      sinks.diagnostic(
        sessionId,
        createDiagnostic("supervisorNotMember", { source: "agent-team", meta: { sessionId } })
      )
      return
    }

    const dispatchedReplies: { name: string; reply: string }[] = []
    const responseCap = resolveTeamResponseCap(team.maxResponses)
    let responseCount = 0
    const seenDispatches = new Set<string>()

    for (let round = 1; round <= MAX_SUPERVISOR_ROUNDS; round++) {
      if (this.interrupted.has(sessionId) || responseCount >= responseCap) return

      const sub = subSessionId(sessionId, supervisor.id, `${turnId}r${round}`)
      sinks.members.setStatus(sessionId, supervisor.id, "thinking")

      try {
        const roster = round === 1 ? buildSupervisorRoster(members, memberByCharId) : ""
        const synthesisHeader = round === 2 ? buildSynthesisAddendum(dispatchedReplies) : ""
        const promptAddendum = [roster, synthesisHeader]
          .filter((s) => s.trim().length > 0)
          .join("\n\n")
        const trigger = round === 1 ? "Respond to the user." : "Synthesize the final reply."

        await this.runMemberSubSession({
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
          // Strip dispatch tags from EVERY supervisor round's visible reply.
          postProcessText: (text) => stripDispatches(text),
          turnTwinDeps: args.turnTwinDeps,
          turnEmbedding: args.turnEmbedding,
          turnMemoryDeps: args.turnMemoryDeps,
          turnUserMessage: args.turnUserMessage,
        })
        responseCount += 1
        sinks.members.setStatus(sessionId, supervisor.id, "idle")
      } catch (err) {
        sinks.members.setStatus(sessionId, supervisor.id, "errored")
        sinks.diagnostic(
          sessionId,
          toDiagnostic(err, {
            source: "agent-team",
            meta: { sessionId, extra: { memberName: supervisor.name, characterId: supervisor.id } },
          })
        )
        return
      }

      if (round >= MAX_SUPERVISOR_ROUNDS) break

      const supervisorText = await this.readLastAssistantText(sessionId, supervisor.id)
      const dispatches = parseDispatches(supervisorText, members)
      if (dispatches.length === 0) return

      for (const d of dispatches) {
        if (this.interrupted.has(sessionId) || responseCount >= responseCap) return
        const target = members.find((m) => m.id === d.characterId)
        if (!target) continue
        // The user muted this member in the room; the supervisor's ask does
        // not outrank that.
        if (args.roomSettings.mutedMemberIds.includes(target.id)) continue
        const dispatchKey = `${d.characterId}\u0000${d.task.trim().replace(/\s+/g, " ").toLowerCase()}`
        if (seenDispatches.has(dispatchKey)) continue
        seenDispatches.add(dispatchKey)

        if (sinks.members.isStopRequested(sessionId, target.id)) {
          sinks.members.clearStopRequest(sessionId, target.id)
          continue
        }

        const dSub = subSessionId(sessionId, target.id, `${turnId}d${round}`)
        sinks.members.setStatus(sessionId, target.id, "thinking")
        try {
          await this.runMemberSubSession({
            session,
            sessionId,
            team,
            character: target,
            members,
            memberByCharId,
            sub: dSub,
            sendContent: `Dispatch from supervisor:\n${d.task}`,
            turnTwinDeps: args.turnTwinDeps,
            turnEmbedding: args.turnEmbedding,
            turnMemoryDeps: args.turnMemoryDeps,
            turnUserMessage: args.turnUserMessage,
          })
          responseCount += 1
          sinks.members.setStatus(sessionId, target.id, "idle")
          const reply = await this.readLastAssistantText(sessionId, target.id)
          if (reply.trim()) dispatchedReplies.push({ name: target.name, reply })
        } catch (err) {
          sinks.members.setStatus(sessionId, target.id, "errored")
          sinks.diagnostic(
            sessionId,
            toDiagnostic(err, {
              source: "agent-team",
              meta: { sessionId, extra: { memberName: target.name, characterId: target.id } },
            })
          )
        }
      }
      if (dispatchedReplies.length === 0) return
    }
  }

  private async runMemberSubSession(args: RunMemberArgs): Promise<void> {
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
      turnTwinDeps,
      turnEmbedding,
      turnMemoryDeps,
      turnUserMessage,
    } = args
    const { deps, sinks } = this

    const referencedPaths = sinks.referencedPaths()
    const teamRecoveryPhase = deps.ai.pendingRecoveryPhase(sinks.messages.read(sessionId) ?? [])
    const baseOpts = await deps.ai.resolveSendOptions({
      session: session as never,
      character,
      appSettings: sinks.settings.read(),
      memberOverride: memberByCharId.get(character.id),
      referencedPaths,
      twinDeps: turnTwinDeps,
      twinUserMessage: turnUserMessage,
      precomputedQueryEmbedding: turnEmbedding,
      memoryDeps: turnMemoryDeps,
      memoryUserMessage: turnMemoryDeps ? turnUserMessage : undefined,
      twinInjectSource: "team",
      postCompaction: postCompactionFor(teamRecoveryPhase, session.workingSet),
      routingSurface: "chat",
      routingContextHint: { promptText: turnUserMessage },
    } as never)
    const roomSettings = resolveRoomSettings(session)
    const handoffTargets = memberByCharId.get(character.id)?.handoffTargets
    const transcript = buildTeamTranscript({
      messages: (await deps.db.listMessages(sessionId)) as unknown as TeamTranscriptMessage[],
      respondingCharacterId: character.id,
      members: members.map((member) => ({
        id: member.id,
        name: member.name,
        role: memberByCharId.get(member.id)?.role,
      })),
      scratchpad: session.scratchpad,
      handoffEnabled: (args.team.maxAutoRounds ?? 0) > 0,
      handoffTargetNames: handoffTargets
        ? handoffTargets.flatMap((id) => {
            const target = members.find((member) => member.id === id)
            return target ? [target.name] : []
          })
        : undefined,
    })
    const finalSystemPrompt = [
      baseOpts.systemPrompt,
      promptAddendum,
      buildRoomInstructionsSection(roomSettings.instructions),
      transcript,
    ]
      .filter((p) => p && p.trim())
      .join("\n\n---\n\n")
    let opts: SendOptions = {
      ...baseOpts,
      ...(finalSystemPrompt ? { systemPrompt: finalSystemPrompt } : {}),
    }
    const plan = baseOpts.routingPlan
    const settings = sinks.settings.read()
    const controller = plan
      ? new RoutingAttemptController(
          plan,
          settings?.routingConfig?.maxFallbackAttempts ?? DEFAULT_ROUTING_CONFIG.maxFallbackAttempts
        )
      : undefined
    let candidate = controller?.begin()

    const ctx: SubResolverCtx = {
      senderId: character.id,
      providerId: opts.provider,
      model: opts.model,
      startedAt: deps.now(),
      extraMetadata: messageMetadata,
      postProcessText,
      options: baseOpts,
      onRoutingCommit: () => controller?.commit(),
    }
    this.subCtx.set(sub, ctx)

    let lastError: unknown
    try {
      do {
        const done = new Promise<void>((resolve, reject) => {
          this.resolvers.set(sub, { resolve, reject })
        })
        try {
          await deps.execution.runWithExecutionLease(
            {
              kind: "team",
              label: `${character.name} · ${opts.model ?? opts.provider ?? "provider"}`,
              sessionId,
              providerId: opts.provider,
              providerLimit: opts.providerConcurrencyLimit,
              exempt: true,
            },
            async () => {
              await deps.ipc.sendPrompt(sub, sendContent, opts)
              await done
            }
          )
          controller?.complete()
          return
        } catch (error) {
          lastError = error
          if (error instanceof Error && error.message === "Interrupted") {
            controller?.cancel()
            throw error
          }
          const next = controller?.failAndAdvance() ?? null
          if (!next || !settings) throw error
          candidate = next
          const attempt = await deps.ai.resolveProviderAttemptOptions(next.providerId, settings)
          opts = {
            ...opts,
            provider: next.providerId,
            model: next.modelId,
            providerCredentials: attempt.providerCredentials,
            protocolAdapterSpec: attempt.protocolAdapterSpec,
            modelParams: attempt.modelParams,
            providerConcurrencyLimit: attempt.concurrentLimit,
            fallbackModel: undefined,
            aliasResolution: opts.aliasResolution
              ? {
                  ...opts.aliasResolution,
                  resolvedTo: { providerId: next.providerId, modelId: next.modelId },
                }
              : undefined,
          }
          ctx.model = next.modelId
          ctx.providerId = next.providerId
        } finally {
          this.resolvers.delete(sub)
        }
      } while (candidate)
      throw lastError instanceof Error ? lastError : new Error("Room chat has no routing candidate")
    } finally {
      this.resolvers.delete(sub)
      this.subCtx.delete(sub)
      this.streams.discard(sessionId, sub)
      this.coalescing.release(sub)
      try {
        await deps.ipc.closeSession(sub)
      } catch {
        /* sub-session may already be torn down */
      }
    }
  }

  // ---- Event handler -----------------------------------------------------

  private async applyEvent(evt: ClaudeEvent): Promise<void> {
    if (this.disposed) return
    if (evt.type !== "event" && evt.type !== "session_ended" && evt.type !== "permission_request") {
      return
    }
    if (typeof evt.sessionId !== "string") return
    const decoded = decodeSubSession(evt.sessionId)
    if (!decoded) return
    const { teamSessionId, characterId } = decoded
    const { deps, sinks } = this
    const isOpen = sinks.messages.isOpen(teamSessionId)

    switch (evt.type) {
      case "session_ended": {
        this.publishActivity(teamSessionId, characterId, evt.sessionId, null)
        const r = this.resolvers.get(evt.sessionId)
        if (r) {
          if (evt.error) r.reject(new Error(evt.error))
          else r.resolve()
        }
        return
      }
      case "permission_request": {
        if (sinks.settings.alwaysAllowTools().includes(evt.toolName)) {
          try {
            await deps.ipc.approveTool(
              evt.sessionId,
              evt.requestId,
              "allow",
              undefined,
              undefined,
              undefined,
              { authority: "policy-rule" } as never
            )
          } catch (err) {
            console.error("auto-approve failed", err)
          }
          return
        }
        if (!isOpen) {
          const deny = async (reason: string) => {
            await deps.ipc.approveTool(
              evt.sessionId,
              evt.requestId,
              "deny",
              reason,
              undefined,
              undefined,
              { authority: "system" } as never
            )
          }
          // A remote controller attached to the room decides, if one holds
          // the lease. Otherwise the waiter had nowhere to ask.
          if (sinks.approvals.routeRemote(teamSessionId, evt, deny)) return
          try {
            await deny("auto-denied: session not open")
          } catch (err) {
            console.error("non-open deny failed", err)
          }
          return
        }
        sinks.approvals.push({
          sessionId: evt.sessionId,
          requestId: evt.requestId,
          toolUseID: evt.toolUseID,
          toolName: evt.toolName,
          input: evt.input,
          title: evt.title,
          displayName: evt.displayName ? `${evt.displayName}` : evt.toolName,
          description: evt.description
            ? `From ${characterId}: ${evt.description}`
            : `From ${characterId}`,
          blockedPath: evt.blockedPath,
          decisionReason: evt.decisionReason,
        })
        return
      }
      case "event": {
        const sub = evt.sessionId
        sinks.approvals.onEvent?.(sub)
        const ctx = this.subCtx.get(sub)
        const senderId = ctx?.senderId ?? characterId

        // Seed the committed base once per turn from the store slice (open
        // pane) or Dexie, then read every member's view off the registry so
        // no member ever sees another's half-written slice.
        if (this.streams.baseOf(teamSessionId) === null) {
          this.streams.setBase(
            teamSessionId,
            isOpen
              ? (sinks.messages.read(teamSessionId) ?? (await deps.db.listMessages(teamSessionId)))
              : await deps.db.listMessages(teamSessionId)
          )
        }
        const { view: teamMsgs, baseLength } = this.streams.viewOf(teamSessionId, sub)
        const existingIds = new Set(teamMsgs.map((m) => m.id))
        const { messages: nextMessages, result: sdkResult } = applySdkEvent(teamMsgs, evt.event)

        try {
          deps.ai.applySdkSubagentBridge(evt.event, teamSessionId)
        } catch (err) {
          console.warn("sdkSubagentBridge (room) failed", err)
        }

        if (sdkResult) {
          const newAssistant = [...nextMessages]
            .reverse()
            .find((m) => m.role === "assistant" && !existingIds.has(m.id))
          if (newAssistant) {
            await deps.db
              .recordResultUsage({
                sessionId: teamSessionId,
                messageId: newAssistant.id,
                characterId: senderId,
                model: ctx?.model,
                result: sdkResult,
              })
              .catch((err) => {
                console.warn("recordResultUsage (room) failed", err)
              })
          }
        }

        if (nextMessages === teamMsgs) return

        if (
          nextMessages.some(
            (message) => message.role === "assistant" && !existingIds.has(message.id)
          )
        ) {
          ctx?.onRoutingCommit?.()
        }
        const pendingBranch = this.pendingBranchTags.get(teamSessionId)
        let tagged = nextMessages.map((m) => {
          if (existingIds.has(m.id)) return m
          if (m.role !== "assistant") return m
          let extra: Record<string, unknown> = { senderId, ...(ctx?.extraMetadata ?? {}) }
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

        if (ctx?.postProcessText) {
          tagged = tagged.map((m) => {
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
            return { ...m, parts: newParts }
          })
        }

        // The status string (ADR-0177 batch 2): the tool this member is on,
        // read off its own slice so another member's tools never show here.
        this.publishActivity(
          teamSessionId,
          characterId,
          sub,
          deriveMemberActivity(tagged.slice(baseLength))
        )

        const coalesce = this.coalescing.get(sub)
        if (sdkResult) {
          // Member turn boundary: drop pending coalesced work and write the
          // final list synchronously. Fold the member's recalled sources onto
          // its reply first.
          coalesce.commit.cancel()
          coalesce.persist.cancel()
          const duplicateIds = duplicateTeamResponseIds(
            tagged
              .filter((message) => message.role === "assistant")
              .map((message) => ({
                id: message.id,
                text: message.parts
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join(" "),
                existing: existingIds.has(message.id),
              }))
          )
          if (duplicateIds.size > 0) {
            tagged = tagged.filter((message) => !duplicateIds.has(message.id))
          }
          tagged = mergeTwinSourcesIntoLastAssistant(tagged, ctx?.options.twinContext)
          tagged = mergeMemorySourcesIntoLastAssistant(tagged, ctx?.options.memoryContext)
          tagged = mergeProjectClaimSourcesIntoLastAssistant(
            tagged,
            ctx?.options.projectContinuityContext
          )
          tagged = mergeProjectHistorySourcesIntoLastAssistant(
            tagged,
            drainProjectHistoryEvidence(sub)
          )
          tagged = mergeProjectKnowledgeSourcesIntoLastAssistant(
            tagged,
            ctx?.options.projectKnowledgeContext
          )
          tagged = mergeAgentKnowledgeSourcesIntoLastAssistant(
            tagged,
            ctx?.options.agentKnowledgeContext
          )
          tagged = mergeWebSearchSourcesIntoLastAssistant(
            tagged,
            this.pendingWebSearch.get(teamSessionId)
          )
          tagged = attachInteractiveGrounding(tagged, ctx?.options)
          const completedAt = deps.now()
          const result = sdkResult as unknown as { duration_ms?: number; subtype?: string }
          tagged = attachRunMetadataToLastAssistant(
            tagged,
            buildCompletedRunMetadata({
              providerId: ctx?.providerId,
              modelId: ctx?.model,
              startedAt: ctx?.startedAt,
              completedAt,
              reportedDurationMs: result.duration_ms,
              finishReason: result.subtype,
            })
          )
          this.streams.fold(teamSessionId, sub, tagged)
          const persisted = this.streams.compose(teamSessionId)
          await deps.db.persistMessages(teamSessionId, persisted)
          if (isOpen) sinks.messages.commit(teamSessionId, persisted)
          this.coalescing.release(sub)
        } else {
          // Mid-stream: coalesce the store commit to one per frame and
          // debounce the Dexie write. The registry keeps the next event's
          // base correct.
          this.streams.applySubResult(teamSessionId, sub, tagged, baseLength)
          if (isOpen) coalesce.commit.call(tagged)
          coalesce.persist.call(tagged)
        }
        if (
          !isOpen &&
          tagged.length > teamMsgs.length &&
          tagged[tagged.length - 1]?.role === "assistant"
        ) {
          await deps.db.bumpUnread(teamSessionId).catch(() => {})
        }
        return
      }
    }
  }

  /** Most recent assistant message authored by `characterId` (from Dexie, so background rooms work). */
  private async readLastAssistantText(roomId: string, characterId: string): Promise<string> {
    const all = await this.deps.db.listMessages(roomId)
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
}

// ---- Helpers ---------------------------------------------------------------

/**
 * One-shot post-compaction recovery, the same shape `buildWorkingSetPostCompaction`
 * builds for direct chat. Inlined so the runner does not import the direct
 * chat send-options module, whose import graph reaches the renderer.
 */
function postCompactionFor(
  phaseNumber: number | null,
  workingSet: ChatSession["workingSet"]
): { phaseNumber: number; durableInstructions?: string } | undefined {
  if (phaseNumber === null) return undefined
  const durableInstructions = workingSet ? renderWorkingSetForCompaction(workingSet) : ""
  return { phaseNumber, ...(durableInstructions ? { durableInstructions } : {}) }
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

export function withMetadata(msg: UIMessage, extra: Record<string, unknown>): UIMessage {
  const prior = ((msg as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<
    string,
    unknown
  >
  return {
    ...msg,
    ...({ metadata: { ...prior, ...extra } } as { metadata: Record<string, unknown> }),
  }
}

/** The `replyTo` stamp for a user turn that answers an earlier message. */
function replyMetadata(opts: RoomSendOptions): Record<string, unknown> {
  return opts.replyTo ? { replyTo: opts.replyTo } : {}
}

/** The `collaboration.author` stamp for a user turn written by another principal. */
function authorMetadata(opts: RoomSendOptions): Record<string, unknown> {
  if (!opts.author) return {}
  return {
    collaboration: {
      author: {
        kind: opts.author.kind,
        id: opts.author.id,
        ...(opts.author.displayName ? { displayName: opts.author.displayName } : {}),
        ...(opts.author.source ? { source: opts.author.source } : {}),
      },
    },
  }
}

export function asPlainText(content: SendContent): string {
  if (typeof content === "string") return content
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join(" ")
}
