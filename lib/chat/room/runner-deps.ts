/**
 * The two seams of the room runner (ADR-0177).
 *
 * `RoomRunnerDeps` is everything that does IO: the sidecar IPC, Dexie, the
 * execution broker, and the per-turn AI helpers. `RoomRunnerSinks` is
 * everything that reports state to whoever is watching: session status,
 * member status, approvals, the steer queue, settings. The split is what lets
 * one orchestration run in three places. The desktop renderer and the
 * headless brain share `createProductionRoomDeps()` (the same lib modules
 * work in both) and differ only in sinks, and a node test hands in fakes for
 * both without a store or a database in sight.
 */

import type { UIMessage } from "ai"
import type {
  ApprovalDecision,
  AppSettings,
  ChatSession,
  Character,
  ClaudeEvent,
  PendingApproval,
  SendContent,
  SendOptions,
  Team,
  MessageReplyTo,
} from "@cognia/agent-config-types"
import type { SDKMessage } from "@cognia/agent-config-types"
import type { SteerEntry, ChatStatus } from "@/stores/chat"
import type { MemberStatus } from "@/stores/ui"
import type { ApplyMemoryContextDeps } from "@/lib/memory/runtime/apply-memory-context"
import type { TwinDepsForBuild } from "@/lib/twin/runtime/build-deps"
import type { BuildOptionsContext } from "@/lib/claude/build-options"
import type { ApproveToolAttribution } from "@/lib/claude/ipc"
import type { CogniaDiagnostic } from "@cognia/diagnostics"

export type ApproveToolFn = (
  sessionId: string,
  requestId: string,
  decision: ApprovalDecision,
  message?: string,
  updatedInput?: unknown,
  remoteExecutionContext?: unknown,
  attribution?: ApproveToolAttribution
) => Promise<void>

export interface RoomRunnerIpc {
  sendPrompt: (sessionId: string, prompt: SendContent, options?: SendOptions) => Promise<void>
  interruptSession: (sessionId: string) => Promise<void>
  closeSession: (sessionId: string) => Promise<void>
  approveTool: ApproveToolFn
}

export interface RoomRunnerDb {
  getSession: (id: string) => Promise<ChatSession | undefined>
  updateSession: (id: string, patch: Partial<ChatSession>) => Promise<void>
  touchSession: (id: string) => Promise<void>
  getTeam: (id: string) => Promise<Team | undefined | null>
  listCharactersByIds: (ids: string[]) => Promise<Character[]>
  listMessages: (sessionId: string) => Promise<UIMessage[]>
  persistMessages: (sessionId: string, messages: UIMessage[]) => Promise<void>
  bumpUnread: (sessionId: string) => Promise<void>
  recordResultUsage: (input: {
    sessionId: string
    messageId: string
    characterId: string
    model?: string
    result: unknown
  }) => Promise<void>
}

export interface RoomRunnerExecution {
  isAtCapacity: (kind: "ai-turn", sessionId: string) => boolean
  runWithExecutionLease: <T>(
    request: {
      kind: "team"
      label: string
      sessionId: string
      providerId?: string
      providerLimit?: number
      exempt: boolean
    },
    run: () => Promise<T>
  ) => Promise<T>
  acquireChatLease: (input: {
    sessionId: string
    projectId?: string
    label: string
    kind: "team"
    slotKey: string | undefined
    onCancel: () => void
  }) => Promise<void>
  slotKeyForTurn: (input: {
    executionContext: ChatSession["executionContext"]
    effectiveCwd: string | null
  }) => string | undefined
  resolveEffectiveCwdForSession: (session: ChatSession) => Promise<string | null>
}

export interface RoomRunnerAi {
  resolveSendOptions: (ctx: BuildOptionsContext) => Promise<SendOptions>
  tryBuildTwinDeps: () => Promise<TwinDepsForBuild | undefined>
  tryBuildMemoryDeps: (
    config: unknown,
    twin: TwinDepsForBuild | undefined
  ) => Promise<ApplyMemoryContextDeps | undefined>
  generateSafeEmbedding: (
    text: string,
    opts: {
      profileId: string
      purpose: "query"
      embedding: TwinDepsForBuild["embedding"]
      vectorBackend: NonNullable<TwinDepsForBuild["vectorBackend"]>
    }
  ) => Promise<{ embedding: number[] }>
  runTurnMemory: (
    sessionId: string,
    input: {
      userText: string
      assistantText: string
      assistantMessageId?: string
      transcript: { id: string; role: string; text: string; parts: UIMessage["parts"] }[]
    }
  ) => Promise<unknown>
  buildUtilityLlmClient: (args: {
    session: ChatSession
    appSettings: AppSettings | undefined
    featureId: string
  }) => unknown
  runTitleTask: (args: Record<string, unknown>) => Promise<unknown>
  resolveProviderAttemptOptions: (
    providerId: string,
    settings: AppSettings
  ) => Promise<{
    providerCredentials?: SendOptions["providerCredentials"]
    protocolAdapterSpec?: SendOptions["protocolAdapterSpec"]
    modelParams?: SendOptions["modelParams"]
    concurrentLimit?: number
  }>
  /**
   * The compaction phase whose recovery preamble is still owed, or `null`.
   * Behind the seam because its module imports the message-part renderer.
   */
  pendingRecoveryPhase: (messages: readonly UIMessage[]) => number | null
  /** Bridge SDK-native subagents into the runtime store. Best effort. */
  applySdkSubagentBridge: (event: SDKMessage, teamSessionId: string) => void
  recordChatToolApprovalDecision: (
    approval: PendingApproval,
    decision: ApprovalDecision
  ) => Promise<void>
}

export interface RoomRunnerDeps {
  ipc: RoomRunnerIpc
  db: RoomRunnerDb
  execution: RoomRunnerExecution
  ai: RoomRunnerAi
  now: () => number
  newTurnId: () => string
  /** Debounce for the streaming Dexie write. `0` degrades to synchronous. */
  persistDelayMs: number
  /** The roll behind `TeamMember.talkativeness`. Defaults to `Math.random`. */
  random?: () => number
  /** Waits while an auto round yields to a typing human. Defaults to a timer. */
  sleep?: (ms: number) => Promise<void>
}

export interface RoomRunnerSinks {
  status: {
    get: (sessionId: string) => ChatStatus
    set: (sessionId: string, status: ChatStatus) => void
    setError: (sessionId: string, error: string | null) => void
  }
  diagnostic: (sessionId: string, diagnostic: CogniaDiagnostic) => void
  messages: {
    /** The live store slice, or `undefined` when no pane holds the session. */
    read: (sessionId: string) => UIMessage[] | undefined
    commit: (sessionId: string, messages: UIMessage[]) => void
    setActiveBranch: (sessionId: string, groupId: string, messageId: string) => void
    /** A session with a visible pane streams into the store, others only touch Dexie. */
    isOpen: (sessionId: string) => boolean
  }
  steer: {
    queue: (sessionId: string) => SteerEntry[]
    enqueue: (sessionId: string, entry: SteerEntry) => void
    clear: (sessionId: string) => void
    appendMessage: (sessionId: string, message: UIMessage) => void
    drain: (
      sessionId: string,
      replay: (
        content: SendContent,
        webSearchContext?: SendOptions["webSearchContext"],
        replyTo?: MessageReplyTo
      ) => void
    ) => void
    armed: Set<string>
  }
  members: {
    setStatus: (sessionId: string, characterId: string, status: MemberStatus) => void
    /** The tool a member is on, `Read · foo.ts`, or `null` when none (ADR-0177 batch 2). */
    setActivity: (sessionId: string, characterId: string, activity: string | null) => void
    clearFor: (sessionId: string) => void
    /** The user asked for one member to stop (ADR-0177 batch 3). */
    requestStop: (sessionId: string, characterId: string) => void
    isStopRequested: (sessionId: string, characterId: string) => boolean
    clearStopRequest: (sessionId: string, characterId: string) => void
    clearStopRequestsFor: (sessionId: string) => void
  }
  approvals: {
    push: (approval: PendingApproval) => void
    clear: (requestId: string) => void
    /**
     * A permission request arrived for a room with no open pane. Return true
     * when a remote controller holds the decision (attach lease) and the
     * runner must wait rather than deny.
     */
    routeRemote: (
      roomId: string,
      evt: Extract<ClaudeEvent, { type: "permission_request" }>,
      deny: (reason: string) => Promise<void>
    ) => boolean
    /** A member event arrived on `subSessionId`, so any armed backstop for it can stand down. */
    onEvent?: (subSessionId: string) => void
  }
  settings: {
    read: () => AppSettings | undefined
    alwaysAllowTools: () => string[]
    toggleAlwaysAllow: (toolName: string, on: boolean) => Promise<void>
  }
  referencedPaths: () => { absolute: string; isDir: boolean }[]
  /**
   * The human's typing signal (ADR-0177 batch 3). `lastTypedAt` is the time
   * of the last keystroke in this room's composer, or `null` when the host
   * has no such signal (a headless brain, whose humans type on companions).
   */
  human: {
    lastTypedAt: (sessionId: string) => number | null
  }
}
