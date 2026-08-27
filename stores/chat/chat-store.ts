"use client"

import type { UIMessage } from "ai"
import { create } from "zustand"
import type {
  PendingApproval,
  SendContent,
  SendContentBlock,
  SendOptions,
} from "@cognia/agent-config-types"
import type { CogniaDiagnostic } from "@cognia/diagnostics"
import type { ContextSelectionRef } from "@/types/artifact/artifact"
import type { ContextRef } from "@/lib/chat/mentions/types"
import { nextNavEpoch } from "@/lib/ui/nav-epoch"
import { decodeSubSession } from "@/lib/claude/team-session-id"
import { getSubagentApprovalRoute } from "@/lib/claude/agents/subagent-approval-routes"
import { useApprovalJournalStore, toPersistedApproval } from "@/stores/agent/approval-journal-store"
import { IDLE_TIMING, nextRunTiming, type RunTiming } from "@/lib/claude/run-status"
import { nextToolTimestamps } from "@/lib/claude/run-record"
import { useSyncExternalStore } from "react"
import { getExecutionBroker, DEFAULT_AI_TURN_LIMIT } from "@/lib/execution/broker"

export type ChatStatus = "idle" | "streaming" | "awaiting_approval" | "error"

/**
 * A queued steer message — a follow-up the user sent while the turn was still
 * running. Holds the framing `text` (for display + replay) plus the original
 * non-text content blocks (`blocks`, e.g. pasted/attached images) so a queued
 * steer keeps its attachments when it is finally replayed. `id` is a stable key
 * for per-entry edit/remove in the Run Panel.
 */
export type SteerEntry = { id: string; text: string; blocks?: SendContentBlock[] }

export type PermissionMode = NonNullable<SendOptions["permissionMode"]>

/**
 * Snapshot of a session's most recent send. The renderer holds this so that
 * `lib/claude/routing-fallback.ts` can re-issue the turn against the next
 * entry in `options.aliasResolution.fallbackEntries` when the SDK reports a
 * transient error. Transient — never persisted to Dexie.
 *
 * `attemptIndex` is the index into `fallbackEntries` for the swap that
 * produced the current `options.provider`/`model` pair: 0 on the original
 * send (alias resolved to its primary), N for retry against `fallbackEntries[N]`.
 * Capping retries at `fallbackEntries.length` keeps us bounded.
 */
export interface LastSendCacheEntry {
  content: SendContent
  options: SendOptions
  attemptIndex: number
  /**
   * Cursor into each error-class-specific fallback chain
   * (`aliasResolution.specialFallbacks`) — independent of `attemptIndex`,
   * which tracks the MAIN chain. Absent until a special-class failure
   * routes through its dedicated chain.
   */
  specialAttempts?: Partial<Record<"contextWindowExceeded" | "contentPolicy", number>>
  /** First visible assistant output or tool dispatch has made replay unsafe. */
  routingCommitted?: boolean
}

/**
 * A workflow graph element staged as a reference chip for the next copilot
 * turn. Denormalized (label + kind stored) so the chip renders without the
 * live editor store, and expanded to `@node:<id>` / `@edge:<id>` at send time.
 */
export interface WorkflowElementRef {
  type: "node" | "edge"
  id: string
  label: string
  kind: string
}

export interface FileReference {
  /** Absolute path on disk; what the SDK needs in `additionalDirectories`. */
  absolute: string
  /** Path relative to the workspace root, with forward slashes. */
  relative: string
  isDir: boolean
}

/**
 * Records that the in-flight turn for a session is an edit request aimed at a
 * specific artifact (set when an artifact-selection chip is sent). Consumed at
 * turn-complete to route the AI revision into a pending review proposal instead
 * of auto-creating a new artifact. See `lib/artifacts/route-ai-revision.ts`.
 */
export interface ArtifactEditTarget {
  artifactId: string
  requestId: string
}

/**
 * Per-command frontmatter overrides applied to the *next* send and then
 * cleared. Set by the composer when the user picks a custom slash command
 * whose `.claude/commands/<name>.md` declares a `model:`, `paths:`, or
 * `allowed-tools:` frontmatter field.
 */
export interface PendingCommandOverrides {
  model?: string
  allowedTools?: string[]
  paths?: string[]
}

/**
 * Per-session transient chat state. One of these exists for every *open*
 * session (tab / pane). The active session's slice is additionally mirrored
 * onto the store's top-level `messages` / `status` / `errorMessage` /
 * `pendingApprovals` / … fields so the ~130 call sites that read "the focused
 * conversation" keep working unchanged, while background panes read their own
 * slice via the `useSession*` selector hooks below.
 *
 * Concurrency note (ADR — concurrent chat sessions): events for a non-focused
 * but open session must keep updating *its* slice (so its pane keeps streaming
 * live); switching focus must never wipe a background slice. The store is the
 * single source of truth for that isolation — `use-claude-chat` routes every
 * SDK event to the slice for `evt.sessionId`.
 */
export interface SessionChatSlice {
  messages: UIMessage[]
  status: ChatStatus
  /**
   * Raw technical failure text. Kept as the log/report artifact and as the
   * legacy channel; `errorDiagnostic` is the one carrying structure.
   */
  errorMessage: string | null
  /**
   * The structured failure, when the producer emitted one.
   *
   * Added alongside `errorMessage` rather than replacing it: the string field
   * is read by ~10 sites plus an e2e spec, and widening it would have meant a
   * breaking rewrite for no benefit the parallel field doesn't give. Producers
   * migrate one at a time; `setSessionDiagnostic` keeps both in lock-step.
   */
  errorDiagnostic: CogniaDiagnostic | null
  pendingApprovals: PendingApproval[]
  /** Per-session assistant-branch selection (see `selectVisibleMessages`). */
  activeBranchByGroup: Record<string, string>
  messagesLoading: boolean
  messagesLoadError: string | null
  messagesReloadNonce: number
  /**
   * Steer queue — follow-up messages the user typed while this session's turn
   * was still running, held client-side until they can be delivered.
   *
   * This is the FALLBACK lane, not the only one: the Anthropic sidecar accepts
   * a message straight into the running query's streaming input, and a message
   * that lands that way never reaches this queue at all. Entries pile up here
   * when there is no live lane (any non-Anthropic provider, or a team turn) or
   * when the running query already closed its input, and are replayed as one
   * fresh framed turn once the turn settles. See `lib/claude/steer.ts` and
   * `hooks/chat/steer-runtime.ts`.
   *
   * Each entry's `id` is mirrored on its transcript message as
   * `metadata.steer.entryId`, which is what carries the delivery state the
   * bubble renders. The run panel shows only the pending count.
   */
  steerQueue: SteerEntry[]
  /** Active-work clock for the run-status bar's elapsed timer. */
  runTiming: RunTiming
  /**
   * Monotonic per-session run counter. Bumped on each fresh idle/error→streaming
   * edge (NOT on an approval resume), and used as the join key for the persisted
   * `RunRecord`. Starts at 0; the first turn is run 1.
   */
  runId: number
  /**
   * Transient per-tool timing keyed by `toolCallId` — `startedAt` on first
   * sighting, `endedAt` on terminal state. Drives the Run Panel's per-tool
   * elapsed. Slice-only (not projected); cleared when a fresh turn starts.
   */
  toolTimestamps: Record<string, { startedAt: number; endedAt?: number }>

  // --- Composer draft context -----------------------------------------------
  // These used to be single top-level fields, wiped on every focus change by a
  // `uiReset` that described them as belonging to "the pane you're typing in".
  // With two panes there are two of those, and one conversation's @-mentions,
  // staged context and permission mode landed in the other's composer. Even
  // single-pane, switching away and back threw the draft's context away.
  //
  // They live in the slice for the same reason `messages` does, and project
  // onto the store top level so existing readers are unchanged.

  /** `null` means "fall back to character / app default". */
  permissionMode: PermissionMode | null
  referencedPaths: FileReference[]
  referencedWorkflowElements: WorkflowElementRef[]
  /**
   * Citations from picks that leave NO token in the message text — a remote
   * document staged as an attachment, a memory / issue / plan / conversation /
   * artifact staged as a context chip. Merged with the tokens
   * `resolve-mentions.ts` parses out of the sent text and stored together as
   * `metadata.mentions`, then cleared with the rest of the composer's staged
   * material once the send commits.
   *
   * Was `referencedDocs` while it sat unread: nothing called `addCitedRef`, so
   * the `doc` ContextRef its own type docs called "the ONLY record that the
   * turn cited that document" was never written. The name went with the wiring
   * — the list is not document-specific and never was (its type is
   * `ContextRef[]`), and a name that says otherwise mis-sends the next reader.
   */
  citedRefs: ContextRef[]
  contextSelections: ContextSelectionRef[]
  pendingCommandOverrides: PendingCommandOverrides | null
  bookmarkedIds: string[]
  webSearchOnForNextSend: boolean
  ephemeralSkillIds: string[]
}

/** Default-initialised slice. `loading` seeds the hydration spinner for a
 * freshly-focused (not-yet-hydrated) session. */
export function makeSessionSlice(loading = false): SessionChatSlice {
  return {
    messages: [],
    status: "idle",
    errorMessage: null,
    errorDiagnostic: null,
    pendingApprovals: [],
    activeBranchByGroup: {},
    messagesLoading: loading,
    messagesLoadError: null,
    messagesReloadNonce: 0,
    steerQueue: [],
    runTiming: IDLE_TIMING,
    runId: 0,
    toolTimestamps: {},
    permissionMode: null,
    referencedPaths: [],
    referencedWorkflowElements: [],
    citedRefs: [],
    contextSelections: [],
    pendingCommandOverrides: null,
    bookmarkedIds: [],
    webSearchOnForNextSend: false,
    ephemeralSkillIds: [],
  }
}

/**
 * Renderer-facing display of the concurrent-stream ceiling. The AUTHORITATIVE
 * cap now lives in the unified {@link getExecutionBroker} (`ai-turn` limit),
 * which also counts headless legs — see `selectIsAtStreamCap` /
 * `useIsAtStreamCap` below. Re-exported from the broker default so any consumer
 * referencing the constant reflects the unified ceiling.
 */
export const MAX_CONCURRENT_STREAMS = DEFAULT_AI_TURN_LIMIT

/** Top-level fields the active session's slice is mirrored onto. */
type ProjectedField =
  | "messages"
  | "status"
  | "errorMessage"
  // Must stay in lock-step with `errorMessage` across all three of the slice
  // type, `projectSlice` and `sliceForId` — a gap in any one of them loses the
  // diagnostic when the user switches the focused session.
  | "errorDiagnostic"
  | "pendingApprovals"
  | "activeBranchByGroup"
  | "messagesLoading"
  | "messagesLoadError"
  | "messagesReloadNonce"
  | "permissionMode"
  | "referencedPaths"
  | "referencedWorkflowElements"
  | "citedRefs"
  | "contextSelections"
  | "pendingCommandOverrides"
  | "bookmarkedIds"
  | "webSearchOnForNextSend"
  | "ephemeralSkillIds"

/** Project a slice onto the store's top-level (active-session) fields. */
function projectSlice(slice: SessionChatSlice): Pick<ChatState, ProjectedField> {
  return {
    messages: slice.messages,
    status: slice.status,
    errorMessage: slice.errorMessage,
    errorDiagnostic: slice.errorDiagnostic,
    pendingApprovals: slice.pendingApprovals,
    activeBranchByGroup: slice.activeBranchByGroup,
    messagesLoading: slice.messagesLoading,
    messagesLoadError: slice.messagesLoadError,
    messagesReloadNonce: slice.messagesReloadNonce,
    permissionMode: slice.permissionMode,
    referencedPaths: slice.referencedPaths,
    referencedWorkflowElements: slice.referencedWorkflowElements,
    citedRefs: slice.citedRefs,
    contextSelections: slice.contextSelections,
    pendingCommandOverrides: slice.pendingCommandOverrides,
    bookmarkedIds: slice.bookmarkedIds,
    webSearchOnForNextSend: slice.webSearchOnForNextSend,
    ephemeralSkillIds: slice.ephemeralSkillIds,
  }
}

const EMPTY_PROJECTION = projectSlice(makeSessionSlice())

/** Read the slice for `id`, seeding from the active projection when the id is
 * the active session but its slice has not been materialised yet. */
/**
 * Resolve the UI bucket a permission ask belongs to. An ask arrives on the
 * session that produced it: a team sub-session id (`…::char::…`), a dispatched
 * subagent's ephemeral id, or a plain chat session. Team + subagent asks
 * re-bucket under the session the user is looking at (parent team / parent
 * chat); everything else buckets under its own id.
 */
/** Write-through to the durable approval journal — best-effort, never throws. */
function writeApprovalJournal(
  fn: (journal: ReturnType<typeof useApprovalJournalStore.getState>) => void
): void {
  try {
    fn(useApprovalJournalStore.getState())
  } catch {
    // The durable mirror is best-effort; the in-memory store is authoritative.
  }
}

/**
 * The session whose history contains `messageId`, plus that history. Checks the
 * active projection first — the focused session's slice is materialised lazily,
 * so `sessions[activeSessionId]` can still be missing while `messages` is live.
 * Returns null when no open session holds the id.
 */
function findMessageOwner(
  s: ChatState,
  messageId: string
): { sessionId: string; messages: UIMessage[] } | null {
  if (s.activeSessionId != null && s.messages.some((m) => m.id === messageId)) {
    return { sessionId: s.activeSessionId, messages: s.messages }
  }
  for (const [sessionId, slice] of Object.entries(s.sessions)) {
    if (slice.messages.some((m) => m.id === messageId)) {
      return { sessionId, messages: slice.messages }
    }
  }
  return null
}

function isBookmarked(m: UIMessage): boolean {
  return (m as { metadata?: { bookmarked?: unknown } }).metadata?.bookmarked === true
}

/**
 * Starred message ids across `msgs` plus every other open session's history.
 *
 * `bookmarkedIds` is one flat set but `messages` is per-slice, and the star is
 * rendered for whichever pane a message is in — so deriving from the freshly
 * loaded history alone would drop a split pane's bookmarks and blank its stars
 * on every active-session load. `otherSessions` is scanned to keep them.
 *
 * Only called from the history-load path, never from the streaming one: it
 * mints a new array, and the timeline subscribes to `bookmarkedIds` by
 * identity.
 */
export function deriveBookmarkedIds(
  msgs: UIMessage[],
  otherSessions: Record<string, SessionChatSlice> = {},
  excludeSessionId?: string | null
): string[] {
  const out = new Set<string>()
  for (const m of msgs) if (isBookmarked(m)) out.add(m.id)
  for (const [id, slice] of Object.entries(otherSessions)) {
    if (id === excludeSessionId) continue
    for (const m of slice.messages) if (isBookmarked(m)) out.add(m.id)
  }
  return [...out]
}

/**
 * Write-through of a bookmark flag to Dexie — best-effort, never throws.
 * Dynamically imported so the store keeps no static dependency on the db layer
 * (the same shape `lib/remote-control/query-answerer` uses).
 */
function writeBookmark(sessionId: string, messageId: string, bookmarked: boolean): void {
  void import("@/lib/db/messages")
    .then(({ updateMessageMetadata }) =>
      updateMessageMetadata(sessionId, messageId, { bookmarked })
    )
    .catch(() => {
      // Durable mirror is best-effort; the in-memory store is authoritative.
    })
}

function resolveApprovalBucket(sessionId: string): string {
  const team = decodeSubSession(sessionId)?.teamSessionId
  if (team) return team
  const route = getSubagentApprovalRoute(sessionId)
  if (route) return route.parentSessionId
  return sessionId
}

function sliceForId(state: ChatState, id: string): SessionChatSlice {
  const existing = state.sessions[id]
  if (existing) return existing
  if (id === state.activeSessionId) {
    return {
      messages: state.messages,
      status: state.status,
      errorMessage: state.errorMessage,
      errorDiagnostic: state.errorDiagnostic,
      pendingApprovals: state.pendingApprovals,
      activeBranchByGroup: state.activeBranchByGroup,
      messagesLoading: state.messagesLoading,
      messagesLoadError: state.messagesLoadError,
      messagesReloadNonce: state.messagesReloadNonce,
      permissionMode: state.permissionMode,
      referencedPaths: state.referencedPaths,
      referencedWorkflowElements: state.referencedWorkflowElements,
      citedRefs: state.citedRefs,
      contextSelections: state.contextSelections,
      pendingCommandOverrides: state.pendingCommandOverrides,
      bookmarkedIds: state.bookmarkedIds,
      webSearchOnForNextSend: state.webSearchOnForNextSend,
      ephemeralSkillIds: state.ephemeralSkillIds,
      // steerQueue / runTiming / runId / toolTimestamps are slice-only (not
      // projected onto the top-level active mirror), so seed them from defaults
      // when materialising a slice for the active session before its first write.
      steerQueue: [],
      runTiming: IDLE_TIMING,
      runId: 0,
      toolTimestamps: {},
    }
  }
  return makeSessionSlice()
}

/**
 * Status-change patch that also advances the run clock. Every status mutation
 * (setStatus / setSessionStatus / setError / pushApproval / clearApproval)
 * routes through this so the elapsed timer starts, pauses on approval, and
 * clears on settle in one place.
 */
function statusPatch(state: ChatState, id: string, next: ChatStatus): Partial<SessionChatSlice> {
  const prev = sliceForId(state, id)
  const patch: Partial<SessionChatSlice> = {
    status: next,
    runTiming: nextRunTiming(prev.runTiming, next, Date.now()),
  }
  // Fresh-turn edge: idle/error → streaming (a non-null prior startedAt means a
  // resume from an approval pause, which must NOT mint a new run). Bump the run
  // counter and reset the per-tool timing for the new turn.
  if (next === "streaming" && prev.runTiming.startedAt == null) {
    patch.runId = prev.runId + 1
    patch.toolTimestamps = {}
  }
  return patch
}

/** Write `patch` into session `id`'s slice; re-project onto the top-level
 * fields when `id` is the active session so backward-compat readers stay in
 * sync. Returns the partial state for `set(...)`. */
function patchSliceState(
  state: ChatState,
  id: string,
  patch: Partial<SessionChatSlice>
): Partial<ChatState> {
  const nextSlice = { ...sliceForId(state, id), ...patch }
  const sessions = { ...state.sessions, [id]: nextSlice }
  if (id === state.activeSessionId) {
    return { sessions, ...projectSlice(nextSlice) }
  }
  return { sessions }
}

/**
 * Write `patch` into a NAMED session's slice, or the active one when the
 * caller does not name it. `null` is not "no session" — it is "whoever has
 * focus", which is the historical behaviour every un-migrated caller relies on.
 */
function patchComposerState(
  state: ChatState,
  sessionId: string | null | undefined,
  patch: Partial<SessionChatSlice>
): Partial<ChatState> {
  return sessionId == null
    ? patchActiveState(state, patch)
    : patchSliceState(state, sessionId, patch)
}

/**
 * The slice a composer write reads from — the named session, else the active
 * one, else the bare projection (the pre-session ephemeral case, where the
 * top-level fields ARE the state).
 */
function composerSlice(state: ChatState, sessionId: string | null | undefined): SessionChatSlice {
  const id = sessionId ?? state.activeSessionId
  return id == null ? { ...makeSessionSlice(), ...projectionAsSlice(state) } : sliceForId(state, id)
}

/** The top-level projection read back as slice-shaped fields. */
function projectionAsSlice(state: ChatState): Partial<SessionChatSlice> {
  return {
    messages: state.messages,
    permissionMode: state.permissionMode,
    referencedPaths: state.referencedPaths,
    referencedWorkflowElements: state.referencedWorkflowElements,
    citedRefs: state.citedRefs,
    contextSelections: state.contextSelections,
    pendingCommandOverrides: state.pendingCommandOverrides,
    bookmarkedIds: state.bookmarkedIds,
    webSearchOnForNextSend: state.webSearchOnForNextSend,
    ephemeralSkillIds: state.ephemeralSkillIds,
  }
}

/** Write `patch` into the *active* session's slice (or just the top-level
 * projection when no session is active — the pre-session ephemeral case). */
function patchActiveState(state: ChatState, patch: Partial<SessionChatSlice>): Partial<ChatState> {
  const id = state.activeSessionId
  if (id == null) return { ...patch }
  return patchSliceState(state, id, patch)
}

interface ChatState {
  activeSessionId: string | null
  /**
   * Navigation epoch stamped each time the active session changes. Compared
   * against the UI store's `selectedGuildEpoch` so the desktop workspace knows
   * whether the active session or the guild was chosen more recently. Transient.
   */
  activeSessionEpoch: number
  /** Per-session slices for every open session (active + background panes). */
  sessions: Record<string, SessionChatSlice>
  /** Ordered list of open sessions (the tab strip). The active session is
   * always present. */
  openSessionIds: string[]
  /** Session shown in the secondary split pane, or `null` when not split. */
  splitSessionId: string | null
  messages: UIMessage[]
  status: ChatStatus
  errorMessage: string | null
  /** Active session's structured failure, mirrored from its slice. */
  errorDiagnostic: CogniaDiagnostic | null
  pendingApprovals: PendingApproval[]
  /**
   * Live mirror of the active session's permissionMode. Cycled by the
   * composer's Shift+Tab handler; persisted to IndexedDB by the caller.
   * `null` means "fall back to character / app default".
   */
  permissionMode: PermissionMode | null
  /** Files / folders the user has @-mentioned in the current draft. */
  referencedPaths: FileReference[]
  /**
   * Workflow graph elements referenced for the next copilot turn (via the `@`
   * node/edge picker or the "reference selection" action). Cleared on send
   * (by the workflow chat tab) and on focus change. Empty in non-workflow chats.
   */
  referencedWorkflowElements: WorkflowElementRef[]
  /**
   * Remote documents (Feishu / Google Workspace, ADR-0134) cited by the draft.
   *
   * Their BODIES ride as staged attachments — this array only records provenance
   * (`<providerId>:<documentId>` + title + URL) so the sent message carries an
   * auditable `metadata.mentions` entry. A remote document leaves no `@…` token
   * in the text, so unlike every other mention kind it cannot be recovered by
   * re-parsing the message. Cleared on send with the attachments.
   */
  citedRefs: ContextRef[]
  /**
   * Material the user pointed at + commented on, staged as context chips for
   * the next send. Cleared on send (like attachments) and on focus change.
   *
   * Holds four kinds (artifact / file / comment / web) in one array rather than
   * four parallel ones: they share a chip bar, a formatter and a lifetime, and
   * splitting them would mean the composer prepending two context blocks and
   * the chip bar merging two sources. Only the artifact kind can be the send's
   * edit target — see `promoteContextSelection`.
   */
  contextSelections: ContextSelectionRef[]
  /** Frontmatter overrides from a recently-picked custom command; cleared on send. */
  pendingCommandOverrides: PendingCommandOverrides | null
  /**
   * In-memory bookmark set for the current session — message IDs the user has
   * starred. Cleared when the active session changes; not persisted across
   * restarts.
   */
  bookmarkedIds: string[]
  /**
   * Per-send web-search toggle. Set true by the composer's Globe button;
   * automatically cleared after each send. Cognia behavior: web search is
   * an opt-in for *one* message, not a sticky setting.
   */
  webSearchOnForNextSend: boolean
  /**
   * Per-message ephemeral skill ids — these get unioned with the active
   * character's skillIds in `resolveSendOptions` for the next send only,
   * then cleared. The composer's SkillPicker drives this.
   */
  ephemeralSkillIds: string[]
  /**
   * Per-session snapshot of the last send so a `session_ended` with a
   * transient error can re-issue the turn through the alias's fallback
   * chain without re-running `resolveSendOptions`. Cleared on a clean
   * session_ended and on session change. See `lib/claude/routing-fallback.ts`.
   */
  lastSendBySession: Record<string, LastSendCacheEntry>
  /**
   * Per-session edit target for the in-flight turn. Set when an artifact
   * selection chip is sent; consumed (and cleared) at turn-complete to stage
   * the AI revision as a review proposal. Not reset on focus change so a
   * background session's targeted edit survives a tab switch.
   */
  pendingArtifactEditTarget: Record<string, ArtifactEditTarget | null>
  /**
   * Map from `branchGroupId` → active `messageId` for the assistant-branches
   * subsystem. When the user regenerates a reply, the previous assistant
   * message is retained and a new one is appended; both rows share a
   * `metadata.branchGroupId`. This map tracks which sibling is currently
   * shown by the chat list. Cleared on session change; persisted to Dexie
   * by the caller (so the choice survives a reload).
   */
  activeBranchByGroup: Record<string, string>
  /**
   * True while the active session's history is being hydrated from Dexie
   * (`hooks/chat/use-sessions.ts`). Lets the chat pane show a loading state
   * instead of flashing the empty/welcome layout during the switch gap.
   */
  messagesLoading: boolean
  /**
   * Set when the Dexie history load throws. The chat pane surfaces this with a
   * retry affordance instead of silently leaving the conversation blank (which
   * looks like lost history). Cleared on a successful load or session change.
   */
  messagesLoadError: string | null
  /**
   * Monotonic counter bumped by `requestMessagesReload`. `useSessions` watches
   * it so the retry button can re-trigger the hydration effect.
   */
  messagesReloadNonce: number

  setActiveSession: (id: string | null) => void
  /** Add a session to the open-tab strip (no focus change). Idempotent. */
  openSession: (id: string) => void
  /** Close a session pane: drop its slice + tab, clear split if it held it,
   * and re-focus the next open session when the active one was closed. */
  closeSession: (id: string) => void
  /** Set (or clear with `null`) the secondary split-pane session. */
  setSplitSessionId: (id: string | null) => void
  setMessages: (msgs: UIMessage[]) => void
  appendMessage: (msg: UIMessage) => void
  /**
   * Append into a NAMED session's slice.
   *
   * `appendMessage` writes to whichever session has focus, which is right for
   * the one-pane case and wrong for every surface that belongs to a specific
   * conversation. In split view the unfocused pane's composer echoed its slash
   * command results into the *other* pane's transcript, and those echoes are
   * persisted messages — the mistake outlived the session.
   */
  appendMessageToSession: (sessionId: string | null, msg: UIMessage) => void
  /**
   * Replace a NAMED session's message array. Same reason as
   * `appendMessageToSession`: a producer that knows which conversation it is
   * rewriting must not be routed through focus.
   */
  replaceMessagesForSession: (sessionId: string | null, msgs: UIMessage[]) => void
  replaceMessages: (msgs: UIMessage[]) => void
  setMessagesLoading: (v: boolean) => void
  setMessagesLoadError: (msg: string | null) => void
  /** Re-trigger the active session's history load (retry after a load error). */
  requestMessagesReload: () => void
  setStatus: (s: ChatStatus) => void
  setError: (msg: string | null) => void
  // ── Session-scoped variants (route by id regardless of focus) ────────────
  // Used by `use-claude-chat`'s event loop so a background open session keeps
  // streaming into its own slice without disturbing the focused pane.
  setSessionMessages: (id: string, msgs: UIMessage[]) => void
  appendSessionMessage: (id: string, msg: UIMessage) => void
  replaceSessionMessages: (id: string, msgs: UIMessage[]) => void
  setSessionMessagesLoading: (id: string, v: boolean) => void
  setSessionMessagesLoadError: (id: string, msg: string | null) => void
  requestSessionMessagesReload: (id: string) => void
  setSessionStatus: (id: string, s: ChatStatus) => void
  /**
   * @deprecated Emit a `CogniaDiagnostic` and call `setSessionDiagnostic`.
   * A bare string loses the code, severity, retryability and actions, forcing
   * the renderer to guess them back from English prose.
   */
  setSessionError: (id: string, msg: string | null) => void
  /** Structured failure for a session. Mirrors `message` onto `errorMessage`. */
  setSessionDiagnostic: (id: string, diagnostic: CogniaDiagnostic | null) => void
  /** Append a steer message to a session's queue (typed while it was busy). */
  enqueueSteer: (id: string, entry: SteerEntry) => void
  /** Remove a single queued steer entry by its id (no-op if absent). */
  removeSteerEntry: (id: string, entryId: string) => void
  /** Replace the text of a single queued steer entry (keeps its blocks). */
  updateSteerEntry: (id: string, entryId: string, text: string) => void
  /**
   * Move a queued steer entry by `delta` slots (-1 = earlier, +1 = later).
   * The queue drains in order into one framed turn, so its order is what the
   * model reads — this is how the user reorders that. Clamped at both ends and
   * a no-op for an unknown id.
   */
  moveSteerEntry: (id: string, entryId: string, delta: number) => void
  /** Drop all queued steer messages for a session. */
  clearSteerQueue: (id: string) => void
  /** Fold a session's latest messages into its per-tool timing map (Run Panel). */
  syncToolTimestamps: (id: string, messages: readonly UIMessage[]) => void
  setSessionActiveBranch: (id: string, branchGroupId: string, messageId: string) => void
  hydrateSessionActiveBranches: (id: string, map: Record<string, string>) => void
  /** Append an approval, routed by `approval.sessionId` (per-session queue). */
  pushApproval: (approval: PendingApproval) => void
  /** Drop the approval with `requestId`. When `sessionId` is omitted the slice
   * holding it is located by scan. */
  clearApproval: (requestId: string, sessionId?: string) => void
  /** Mark the approval `interrupted` (the sidecar waiter died; the tool was
   * already denied). The entry stays until Dismiss (`clearApproval`) so the UI
   * shows an honest notice instead of a silently vanishing dialog. Restores
   * `awaiting_approval` → `streaming` when no live approvals remain. */
  markApprovalInterrupted: (requestId: string, sessionId?: string, reason?: string) => void
  /**
   * Every composer-draft action takes an optional trailing `sessionId`. Omitted
   * it means "the focused conversation", which is what a single-pane surface
   * wants. The composer passes its OWN id through `ComposerSessionContext`, so
   * the unfocused split pane writes to its own conversation instead of the
   * one beside it.
   */
  setPermissionMode: (mode: PermissionMode | null, sessionId?: string | null) => void
  addReferencedPath: (ref: FileReference, sessionId?: string | null) => void
  removeReferencedPath: (absolute: string, sessionId?: string | null) => void
  clearReferencedPaths: (sessionId?: string | null) => void
  /** Stage a workflow element as a reference chip for the next copilot turn. */
  addCitedRef: (ref: ContextRef, sessionId?: string | null) => void
  removeCitedRef: (id: string, sessionId?: string | null) => void
  clearCitedRefs: (sessionId?: string | null) => void
  addReferencedWorkflowElement: (ref: WorkflowElementRef, sessionId?: string | null) => void
  removeReferencedWorkflowElement: (
    type: "node" | "edge",
    id: string,
    sessionId?: string | null
  ) => void
  clearReferencedWorkflowElements: (sessionId?: string | null) => void
  /** Stage a selection (of any kind) as a context chip for the next send. */
  addContextSelection: (selection: ContextSelectionRef, sessionId?: string | null) => void
  /** Remove a staged selection (by index, since snapshots can repeat). */
  removeContextSelection: (index: number, sessionId?: string | null) => void
  /**
   * Move a staged selection to the front, making it the send's edit target.
   *
   * Only the first *artifact* selection becomes `pendingArtifactEditTarget` —
   * the rest contribute context alone — so with more than one staged, which
   * artifact receives the AI's per-hunk revision proposal has to be the user's
   * choice rather than whichever chip happened to be staged first. A non-artifact
   * selection can never hold the target (there is nothing to diff a proposal
   * against), so the composer skips past those rather than reading index 0.
   */
  promoteContextSelection: (index: number, sessionId?: string | null) => void
  clearContextSelections: (sessionId?: string | null) => void
  setPendingCommandOverrides: (
    overrides: PendingCommandOverrides | null,
    sessionId?: string | null
  ) => void
  toggleBookmark: (messageId: string) => void
  setWebSearchOnForNextSend: (v: boolean, sessionId?: string | null) => void
  setEphemeralSkillIds: (ids: string[], sessionId?: string | null) => void
  toggleEphemeralSkill: (id: string, sessionId?: string | null) => void
  clearEphemeralSkillIds: (sessionId?: string | null) => void
  /** Drop ids from the ephemeral attachment list (e.g. after a skill is deleted). */
  removeEphemeralSkillIds: (ids: string[]) => void
  setLastSend: (sessionId: string, entry: LastSendCacheEntry) => void
  bumpLastSendAttempt: (sessionId: string) => void
  markLastSendCommitted: (sessionId: string) => void
  clearLastSend: (sessionId: string) => void
  /** Set (or clear with `null`) the artifact edit target for a session's turn. */
  setPendingArtifactEditTarget: (sessionId: string, target: ArtifactEditTarget | null) => void
  /** Mark `messageId` as the visible branch within `branchGroupId`. */
  setActiveBranch: (branchGroupId: string, messageId: string) => void
  /** Replace the full active-branch map (used on Dexie hydration). */
  hydrateActiveBranches: (map: Record<string, string>) => void
  clear: () => void
}

export const useChatStore = create<ChatState>((set) => ({
  activeSessionId: null,
  activeSessionEpoch: 0,
  sessions: {},
  openSessionIds: [],
  splitSessionId: null,
  messages: [],
  status: "idle",
  errorMessage: null,
  errorDiagnostic: null,
  pendingApprovals: [],
  permissionMode: null,
  referencedPaths: [],
  referencedWorkflowElements: [],
  citedRefs: [],
  contextSelections: [],
  pendingCommandOverrides: null,
  bookmarkedIds: [],
  webSearchOnForNextSend: false,
  ephemeralSkillIds: [],
  lastSendBySession: {},
  pendingArtifactEditTarget: {},
  activeBranchByGroup: {},
  messagesLoading: false,
  messagesLoadError: null,
  messagesReloadNonce: 0,

  setActiveSession: (id) =>
    set((s) => {
      // No composer-state reset here any more. These fields used to be wiped on
      // every focus change, on the theory that they belong to "the pane you're
      // typing in" — but they belong to the CONVERSATION you were composing to,
      // and throwing away a half-built @-mention set because the user glanced
      // at another conversation was never what anyone wanted. They now live in
      // the slice, so switching focus re-projects the target's own values and
      // switching back finds the draft context intact. `EMPTY_PROJECTION`
      // covers the no-session case.
      // Stamp the switch so the desktop workspace can tell whether the session
      // or the guild was the more recent navigation intent.
      const activeSessionEpoch = nextNavEpoch()
      if (id == null) {
        return { activeSessionId: null, activeSessionEpoch, ...EMPTY_PROJECTION }
      }
      const existed = Boolean(s.sessions[id])
      // A freshly-focused (never-opened) session seeds a loading slice so the
      // history hydration spinner shows; an already-open session keeps its
      // accumulated (possibly mid-stream) slice verbatim.
      const slice = s.sessions[id] ?? makeSessionSlice(true)
      const sessions = existed ? s.sessions : { ...s.sessions, [id]: slice }
      const openSessionIds = s.openSessionIds.includes(id)
        ? s.openSessionIds
        : [...s.openSessionIds, id]
      return {
        activeSessionId: id,
        activeSessionEpoch,
        sessions,
        openSessionIds,
        ...projectSlice(slice),
      }
    }),
  openSession: (id) =>
    set((s) => {
      if (s.openSessionIds.includes(id)) return s
      const sessions = s.sessions[id] ? s.sessions : { ...s.sessions, [id]: makeSessionSlice() }
      return { openSessionIds: [...s.openSessionIds, id], sessions }
    }),
  closeSession: (id) =>
    set((s) => {
      const openSessionIds = s.openSessionIds.filter((x) => x !== id)
      const sessions = { ...s.sessions }
      delete sessions[id]
      const lastSendBySession = { ...s.lastSendBySession }
      delete lastSendBySession[id]
      const splitSessionId = s.splitSessionId === id ? null : s.splitSessionId
      const base = { openSessionIds, sessions, lastSendBySession, splitSessionId }
      if (s.activeSessionId !== id) return base
      // Closed the focused pane — re-focus the rightmost remaining tab.
      const nextActive = openSessionIds[openSessionIds.length - 1] ?? null
      if (nextActive == null) {
        return { ...base, activeSessionId: null, ...EMPTY_PROJECTION }
      }
      return {
        ...base,
        activeSessionId: nextActive,
        ...projectSlice(sessions[nextActive] ?? makeSessionSlice()),
      }
    }),
  setSplitSessionId: (id) => set({ splitSessionId: id }),
  // A successful hydration / replacement clears the transient load flags.
  setMessages: (msgs) =>
    set((s) =>
      // History load is the one place bookmarks re-enter memory: only the
      // persisted flag knows which turns were starred. It goes INTO the slice
      // rather than onto the top level beside it — a top-level-only write
      // looked right until the next focus switch re-projected the stale slice
      // value over it and the stars vanished.
      patchActiveState(s, {
        messages: msgs,
        messagesLoading: false,
        messagesLoadError: null,
        bookmarkedIds: deriveBookmarkedIds(msgs, s.sessions, s.activeSessionId),
      })
    ),
  appendMessage: (msg) => set((s) => patchActiveState(s, { messages: [...s.messages, msg] })),
  appendMessageToSession: (sessionId, msg) =>
    set((s) =>
      // A null id is the pre-session ephemeral case, which only the projection
      // has — deferring to `patchActiveState` keeps that path unchanged.
      sessionId == null
        ? patchActiveState(s, { messages: [...s.messages, msg] })
        : patchSliceState(s, sessionId, { messages: [...sliceForId(s, sessionId).messages, msg] })
    ),
  replaceMessages: (msgs) => set((s) => patchActiveState(s, { messages: msgs })),
  replaceMessagesForSession: (sessionId, msgs) =>
    set((s) => patchComposerState(s, sessionId, { messages: msgs })),
  setMessagesLoading: (v) => set((s) => patchActiveState(s, { messagesLoading: v })),
  setMessagesLoadError: (msg) =>
    set((s) => patchActiveState(s, { messagesLoadError: msg, messagesLoading: false })),
  requestMessagesReload: () =>
    set((s) =>
      patchActiveState(s, {
        messagesReloadNonce: s.messagesReloadNonce + 1,
        messagesLoading: true,
        messagesLoadError: null,
      })
    ),
  setStatus: (st) =>
    set((s) => {
      const id = s.activeSessionId
      return patchActiveState(s, id ? statusPatch(s, id, st) : { status: st })
    }),
  setError: (msg) =>
    set((s) => {
      const next: ChatStatus = msg ? "error" : "idle"
      const id = s.activeSessionId
      const timing = id ? { runTiming: statusPatch(s, id, next).runTiming } : {}
      return patchActiveState(s, { errorMessage: msg, status: next, ...timing })
    }),
  setSessionMessages: (id, msgs) =>
    set((s) =>
      patchSliceState(s, id, { messages: msgs, messagesLoading: false, messagesLoadError: null })
    ),
  appendSessionMessage: (id, msg) =>
    set((s) => patchSliceState(s, id, { messages: [...sliceForId(s, id).messages, msg] })),
  replaceSessionMessages: (id, msgs) => set((s) => patchSliceState(s, id, { messages: msgs })),
  setSessionMessagesLoading: (id, v) => set((s) => patchSliceState(s, id, { messagesLoading: v })),
  setSessionMessagesLoadError: (id, msg) =>
    set((s) => patchSliceState(s, id, { messagesLoadError: msg, messagesLoading: false })),
  requestSessionMessagesReload: (id) =>
    set((s) =>
      patchSliceState(s, id, {
        messagesReloadNonce: sliceForId(s, id).messagesReloadNonce + 1,
        messagesLoading: true,
        messagesLoadError: null,
      })
    ),
  setSessionStatus: (id, st) => set((s) => patchSliceState(s, id, statusPatch(s, id, st))),
  setSessionError: (id, msg) =>
    set((s) =>
      patchSliceState(s, id, {
        errorMessage: msg,
        // Clearing the structured half too: a legacy string write must never
        // leave a stale diagnostic behind describing a different failure.
        errorDiagnostic: null,
        ...statusPatch(s, id, msg ? "error" : "idle"),
      })
    ),
  setSessionDiagnostic: (id, diagnostic) =>
    set((s) =>
      patchSliceState(s, id, {
        errorDiagnostic: diagnostic,
        // Mirror the raw text onto the legacy field so subscribers that read
        // store state directly — `use-session-notifications`, the desktop
        // workspace toast — keep working untouched during the migration.
        errorMessage: diagnostic?.message ?? null,
        ...statusPatch(s, id, diagnostic ? "error" : "idle"),
      })
    ),
  enqueueSteer: (id, entry) =>
    set((s) => patchSliceState(s, id, { steerQueue: [...sliceForId(s, id).steerQueue, entry] })),
  removeSteerEntry: (id, entryId) =>
    set((s) => {
      const queue = sliceForId(s, id).steerQueue
      const next = queue.filter((e) => e.id !== entryId)
      return next.length === queue.length ? s : patchSliceState(s, id, { steerQueue: next })
    }),
  updateSteerEntry: (id, entryId, text) =>
    set((s) => {
      const queue = sliceForId(s, id).steerQueue
      if (!queue.some((e) => e.id === entryId)) return s
      const next = queue.map((e) => (e.id === entryId ? { ...e, text } : e))
      return patchSliceState(s, id, { steerQueue: next })
    }),
  moveSteerEntry: (id, entryId, delta) =>
    set((s) => {
      const queue = sliceForId(s, id).steerQueue
      const from = queue.findIndex((e) => e.id === entryId)
      if (from < 0) return s
      const to = from + delta
      if (to < 0 || to >= queue.length || to === from) return s
      const next = [...queue]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return patchSliceState(s, id, { steerQueue: next })
    }),
  clearSteerQueue: (id) =>
    set((s) =>
      sliceForId(s, id).steerQueue.length === 0 ? s : patchSliceState(s, id, { steerQueue: [] })
    ),
  syncToolTimestamps: (id, messages) =>
    set((s) => {
      const prev = sliceForId(s, id).toolTimestamps
      const next = nextToolTimestamps(prev, messages, Date.now())
      return next === prev ? s : patchSliceState(s, id, { toolTimestamps: next })
    }),
  setSessionActiveBranch: (id, branchGroupId, messageId) =>
    set((s) => {
      const slice = sliceForId(s, id)
      if (slice.activeBranchByGroup[branchGroupId] === messageId) return s
      return patchSliceState(s, id, {
        activeBranchByGroup: { ...slice.activeBranchByGroup, [branchGroupId]: messageId },
      })
    }),
  hydrateSessionActiveBranches: (id, map) =>
    set((s) => patchSliceState(s, id, { activeBranchByGroup: { ...map } })),
  pushApproval: (approval) =>
    set((s) => {
      // Team tool approvals arrive tagged with the *sub-session* id
      // (`…::char::…`); dispatched-subagent approvals arrive on an ephemeral
      // session id. Bucket both under the session the user is looking at (the
      // parent team session / parent chat) so the active-session projection and
      // per-pane inline gates can see them; `approval.sessionId` keeps the
      // sub-session/ephemeral id for approveTool routing.
      const bucketId = resolveApprovalBucket(approval.sessionId)
      const slice = sliceForId(s, bucketId)
      const stamped: PendingApproval = { requestedAt: Date.now(), ...approval }
      // Durable mirror: persist the ask so a crash/restart surfaces it as
      // interrupted instead of dropping it silently.
      writeApprovalJournal((j) => j.record(toPersistedApproval(stamped, bucketId)))
      return patchSliceState(s, bucketId, {
        pendingApprovals: [...slice.pendingApprovals, stamped],
        ...statusPatch(s, bucketId, "awaiting_approval"),
      })
    }),
  clearApproval: (requestId, sessionId) =>
    set((s) => {
      const targetId =
        (sessionId ? resolveApprovalBucket(sessionId) : undefined) ??
        Object.keys(s.sessions).find((k) =>
          s.sessions[k].pendingApprovals.some((a) => a.requestId === requestId)
        ) ??
        // Fall back to the active session when the slice map hasn't been
        // materialised (e.g. the only approval lives in the projection).
        (s.pendingApprovals.some((a) => a.requestId === requestId) ? s.activeSessionId : undefined)
      if (targetId == null) return s
      const slice = sliceForId(s, targetId)
      const next = slice.pendingApprovals.filter((a) => a.requestId !== requestId)
      if (next.length === slice.pendingApprovals.length) return s
      writeApprovalJournal((j) => j.settle(requestId))
      const nextStatus: ChatStatus =
        next.length === 0 && slice.status === "awaiting_approval" ? "streaming" : slice.status
      return patchSliceState(s, targetId, {
        pendingApprovals: next,
        ...statusPatch(s, targetId, nextStatus),
      })
    }),
  markApprovalInterrupted: (requestId, sessionId, reason) =>
    set((s) => {
      // Same routing rules as pushApproval/clearApproval: team sub-session ids
      // and subagent ephemeral ids bucket under the parent. When the executor
      // already cleared the route (its `finally` may run before the drain's
      // `permission_interrupted`), the requestId scan below still finds the
      // parent-bucketed entry — so a cleared route never strands the marker.
      const bucketId = sessionId
        ? resolveApprovalBucket(sessionId)
        : (Object.keys(s.sessions).find((k) =>
            s.sessions[k].pendingApprovals.some((a) => a.requestId === requestId)
          ) ??
          (s.pendingApprovals.some((a) => a.requestId === requestId)
            ? s.activeSessionId
            : undefined))
      // If the route resolved to a bucket with no matching entry (route cleared
      // + entry lives elsewhere), fall back to the requestId scan.
      const resolvedBucket =
        bucketId && sliceForId(s, bucketId).pendingApprovals.some((a) => a.requestId === requestId)
          ? bucketId
          : (Object.keys(s.sessions).find((k) =>
              s.sessions[k].pendingApprovals.some((a) => a.requestId === requestId)
            ) ?? bucketId)
      if (resolvedBucket == null) return s
      const slice = sliceForId(s, resolvedBucket)
      let changed = false
      const next = slice.pendingApprovals.map((a) => {
        if (a.requestId !== requestId || a.status === "interrupted") return a
        changed = true
        return { ...a, status: "interrupted" as const, interruptReason: reason ?? "interrupted" }
      })
      if (!changed) return s
      writeApprovalJournal((j) => j.interrupt(requestId, reason))
      const liveRemain = next.some((a) => a.status !== "interrupted")
      const nextStatus: ChatStatus =
        !liveRemain && slice.status === "awaiting_approval" ? "streaming" : slice.status
      return patchSliceState(s, resolvedBucket, {
        pendingApprovals: next,
        ...statusPatch(s, resolvedBucket, nextStatus),
      })
    }),
  setPermissionMode: (mode, sessionId) =>
    set((s) => patchComposerState(s, sessionId, { permissionMode: mode })),
  addReferencedPath: (ref, sessionId) =>
    set((s) => {
      const current = composerSlice(s, sessionId).referencedPaths
      return current.some((r) => r.absolute === ref.absolute)
        ? s
        : patchComposerState(s, sessionId, { referencedPaths: [...current, ref] })
    }),
  addContextSelection: (selection, sessionId) =>
    set((s) =>
      patchComposerState(s, sessionId, {
        contextSelections: [...composerSlice(s, sessionId).contextSelections, selection],
      })
    ),
  removeContextSelection: (index, sessionId) =>
    set((s) => {
      const current = composerSlice(s, sessionId).contextSelections
      return index < 0 || index >= current.length
        ? s
        : patchComposerState(s, sessionId, {
            contextSelections: current.filter((_, i) => i !== index),
          })
    }),
  promoteContextSelection: (index, sessionId) =>
    set((s) => {
      const current = composerSlice(s, sessionId).contextSelections
      if (index <= 0 || index >= current.length) return s
      const next = [...current]
      const [promoted] = next.splice(index, 1)
      next.unshift(promoted)
      return patchComposerState(s, sessionId, { contextSelections: next })
    }),
  clearContextSelections: (sessionId) =>
    set((s) =>
      composerSlice(s, sessionId).contextSelections.length === 0
        ? s
        : patchComposerState(s, sessionId, { contextSelections: [] })
    ),
  removeReferencedPath: (absolute, sessionId) =>
    set((s) =>
      patchComposerState(s, sessionId, {
        referencedPaths: composerSlice(s, sessionId).referencedPaths.filter(
          (r) => r.absolute !== absolute
        ),
      })
    ),
  setPendingCommandOverrides: (overrides, sessionId) =>
    set((s) => patchComposerState(s, sessionId, { pendingCommandOverrides: overrides })),
  clearReferencedPaths: (sessionId) =>
    set((s) => patchComposerState(s, sessionId, { referencedPaths: [] })),
  addCitedRef: (ref, sessionId) =>
    set((s) => {
      const current = composerSlice(s, sessionId).citedRefs
      return current.some((r) => r.id === ref.id)
        ? s
        : patchComposerState(s, sessionId, { citedRefs: [...current, ref] })
    }),
  removeCitedRef: (id, sessionId) =>
    set((s) =>
      patchComposerState(s, sessionId, {
        citedRefs: composerSlice(s, sessionId).citedRefs.filter((r) => r.id !== id),
      })
    ),
  clearCitedRefs: (sessionId) =>
    set((s) =>
      composerSlice(s, sessionId).citedRefs.length === 0
        ? s
        : patchComposerState(s, sessionId, { citedRefs: [] })
    ),
  addReferencedWorkflowElement: (ref, sessionId) =>
    set((s) => {
      const current = composerSlice(s, sessionId).referencedWorkflowElements
      return current.some((r) => r.type === ref.type && r.id === ref.id)
        ? s
        : patchComposerState(s, sessionId, { referencedWorkflowElements: [...current, ref] })
    }),
  removeReferencedWorkflowElement: (type, id, sessionId) =>
    set((s) =>
      patchComposerState(s, sessionId, {
        referencedWorkflowElements: composerSlice(s, sessionId).referencedWorkflowElements.filter(
          (r) => !(r.type === type && r.id === id)
        ),
      })
    ),
  clearReferencedWorkflowElements: (sessionId) =>
    set((s) =>
      composerSlice(s, sessionId).referencedWorkflowElements.length === 0
        ? s
        : patchComposerState(s, sessionId, { referencedWorkflowElements: [] })
    ),
  toggleBookmark: (messageId) =>
    set((s) => {
      const next = !s.bookmarkedIds.includes(messageId)
      const bookmarkedIds = next
        ? [...s.bookmarkedIds, messageId]
        : s.bookmarkedIds.filter((id) => id !== messageId)

      // Route by the session that actually holds the message: split view means
      // the starred message may live in an unfocused pane, and persisting it
      // against the *active* id would write to the wrong conversation (or
      // nowhere), leaving a star that reads as saved and isn't.
      const owner = findMessageOwner(s, messageId)
      // No owner (a message not held by any open slice): the projected list is
      // all there is to update.
      if (owner == null) return patchActiveState(s, { bookmarkedIds })

      // Mirror onto the message's own metadata as well as writing it through.
      // `persistMessages` rewrites each row's metadata blob from the in-memory
      // message, and `updateMessageMetadata` invalidates the persist snapshot
      // (forcing exactly such a rewrite) — so a Dexie-only write would be
      // clobbered by the next turn. Both, or neither.
      const idx = owner.messages.findIndex((m) => m.id === messageId)
      const target = owner.messages[idx]
      const meta = (target as { metadata?: Record<string, unknown> }).metadata ?? {}
      const messages = owner.messages.slice()
      messages[idx] = { ...target, metadata: { ...meta, bookmarked: next } } as UIMessage

      writeBookmark(owner.sessionId, messageId, next)

      // Three writes into possibly-different slices, each building on the
      // previous `sessions` map or it drops the earlier update.
      //
      // The OWNER's `bookmarkedIds` matters as much as the active one now that
      // the field is projected per slice: starring a message in a background
      // pane used to update only the focused slice, so focusing the owner
      // re-projected its stale set and the star vanished — while the metadata
      // and Dexie both said starred, so the next click cleared a flag the UI
      // believed it was setting. The starred set stays a union across open
      // panes (a background pane's renderer reads the focused projection, and
      // narrowing it here would blank its stars).
      const withMessage = patchSliceState(s, owner.sessionId, { messages, bookmarkedIds })
      const afterMessage = { ...s, ...withMessage } as ChatState
      const withActive = { ...withMessage, ...patchActiveState(afterMessage, { bookmarkedIds }) }

      // …and every OTHER open pane. The starred set is a UNION across open
      // conversations, not per-conversation state, so it has to mean the same
      // thing in whichever slice a renderer happens to resolve to. Patching
      // only the owner and the active one left a third open conversation
      // stale: focusing it re-projected a set without the id and the star
      // vanished again, while Dexie and the metadata both said starred.
      const sessions = { ...(withActive.sessions ?? s.sessions) }
      for (const [id, slice] of Object.entries(sessions)) {
        if (slice.bookmarkedIds !== bookmarkedIds) sessions[id] = { ...slice, bookmarkedIds }
      }
      return { ...withActive, sessions }
    }),
  setWebSearchOnForNextSend: (v, sessionId) =>
    set((s) => patchComposerState(s, sessionId, { webSearchOnForNextSend: v })),
  setEphemeralSkillIds: (ids, sessionId) =>
    set((s) => patchComposerState(s, sessionId, { ephemeralSkillIds: ids })),
  toggleEphemeralSkill: (id, sessionId) =>
    set((s) => {
      const current = composerSlice(s, sessionId).ephemeralSkillIds
      return patchComposerState(s, sessionId, {
        ephemeralSkillIds: current.includes(id)
          ? current.filter((x) => x !== id)
          : [...current, id],
      })
    }),
  clearEphemeralSkillIds: (sessionId) =>
    set((s) => patchComposerState(s, sessionId, { ephemeralSkillIds: [] })),
  removeEphemeralSkillIds: (ids) =>
    set((s) => {
      const drop = new Set(ids)
      const next = s.ephemeralSkillIds.filter((id) => !drop.has(id))
      return next.length === s.ephemeralSkillIds.length ? s : { ephemeralSkillIds: next }
    }),
  setLastSend: (sessionId, entry) =>
    set((s) => ({
      lastSendBySession: { ...s.lastSendBySession, [sessionId]: entry },
    })),
  bumpLastSendAttempt: (sessionId) =>
    set((s) => {
      const cur = s.lastSendBySession[sessionId]
      if (!cur) return s
      return {
        lastSendBySession: {
          ...s.lastSendBySession,
          [sessionId]: { ...cur, attemptIndex: cur.attemptIndex + 1 },
        },
      }
    }),
  markLastSendCommitted: (sessionId) =>
    set((s) => {
      const cur = s.lastSendBySession[sessionId]
      if (!cur || cur.routingCommitted) return s
      return {
        lastSendBySession: {
          ...s.lastSendBySession,
          [sessionId]: { ...cur, routingCommitted: true },
        },
      }
    }),
  clearLastSend: (sessionId) =>
    set((s) => {
      if (!s.lastSendBySession[sessionId]) return s
      const next = { ...s.lastSendBySession }
      delete next[sessionId]
      return { lastSendBySession: next }
    }),
  setPendingArtifactEditTarget: (sessionId, target) =>
    set((s) => {
      if (target === null && !s.pendingArtifactEditTarget[sessionId]) return s
      const next = { ...s.pendingArtifactEditTarget }
      if (target === null) {
        delete next[sessionId]
      } else {
        next[sessionId] = target
      }
      return { pendingArtifactEditTarget: next }
    }),
  setActiveBranch: (branchGroupId, messageId) =>
    set((s) =>
      s.activeBranchByGroup[branchGroupId] === messageId
        ? s
        : patchActiveState(s, {
            activeBranchByGroup: { ...s.activeBranchByGroup, [branchGroupId]: messageId },
          })
    ),
  hydrateActiveBranches: (map) =>
    set((s) => patchActiveState(s, { activeBranchByGroup: { ...map } })),
  clear: () =>
    set({
      activeSessionId: null,
      sessions: {},
      openSessionIds: [],
      splitSessionId: null,
      messages: [],
      status: "idle",
      errorMessage: null,
      errorDiagnostic: null,
      pendingApprovals: [],
      permissionMode: null,
      referencedPaths: [],
      referencedWorkflowElements: [],
      citedRefs: [],
      contextSelections: [],
      pendingCommandOverrides: null,
      bookmarkedIds: [],
      webSearchOnForNextSend: false,
      ephemeralSkillIds: [],
      lastSendBySession: {},
      pendingArtifactEditTarget: {},
      activeBranchByGroup: {},
      messagesLoading: false,
      messagesLoadError: null,
      messagesReloadNonce: 0,
    }),
}))

/**
 * Ids of all open sessions currently in the `streaming` state. Drives the
 * concurrency cap and the tab-strip "streaming" dots.
 */
export function selectStreamingSessionIds(state: {
  sessions: Record<string, SessionChatSlice>
}): string[] {
  return Object.keys(state.sessions).filter((id) => state.sessions[id]?.status === "streaming")
}

/** Number of sessions currently streaming. */
export function selectStreamingCount(state: {
  sessions: Record<string, SessionChatSlice>
}): number {
  return selectStreamingSessionIds(state).length
}

/**
 * True when starting a *new* turn on `sessionId` would exceed the unified
 * execution ceiling. Delegates to the {@link getExecutionBroker} so the cap
 * reflects GLOBAL occupancy — every headless leg (scheduler / connector /
 * workflow / team) included — not just this renderer's streaming panels. A
 * session that already has an active leg is a continuation and never blocked
 * (the broker exempts it). The `state` arg is retained for call-site
 * compatibility but is no longer read.
 */
export function selectIsAtStreamCap(
  _state: { sessions: Record<string, SessionChatSlice> },
  sessionId: string
): boolean {
  return getExecutionBroker().isAtCapacity("ai-turn", sessionId)
}

const EMPTY_MESSAGES: UIMessage[] = []
const EMPTY_APPROVALS: PendingApproval[] = []

/** Read a single session's slice (or a stable default when absent). */
export function useSessionMessages(sessionId: string | null): UIMessage[] {
  return useChatStore((s) =>
    sessionId ? (s.sessions[sessionId]?.messages ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
}
export function useSessionStatus(sessionId: string | null): ChatStatus {
  return useChatStore((s) => (sessionId ? (s.sessions[sessionId]?.status ?? "idle") : "idle"))
}
export function useSessionErrorMessage(sessionId: string | null): string | null {
  return useChatStore((s) => (sessionId ? (s.sessions[sessionId]?.errorMessage ?? null) : null))
}
export function useSessionErrorDiagnostic(sessionId: string | null): CogniaDiagnostic | null {
  return useChatStore((s) => (sessionId ? (s.sessions[sessionId]?.errorDiagnostic ?? null) : null))
}
export function useSessionPendingApprovals(sessionId: string | null): PendingApproval[] {
  return useChatStore((s) =>
    sessionId ? (s.sessions[sessionId]?.pendingApprovals ?? EMPTY_APPROVALS) : EMPTY_APPROVALS
  )
}
export function useSessionHasMessages(sessionId: string | null): boolean {
  return useChatStore((s) => ((sessionId ? s.sessions[sessionId]?.messages.length : 0) ?? 0) > 0)
}
export function useSessionMessagesLoading(sessionId: string | null): boolean {
  return useChatStore((s) =>
    sessionId ? (s.sessions[sessionId]?.messagesLoading ?? false) : false
  )
}
export function useSessionMessagesLoadError(sessionId: string | null): string | null {
  return useChatStore((s) =>
    sessionId ? (s.sessions[sessionId]?.messagesLoadError ?? null) : null
  )
}
/**
 * Reactive cap check for a pane's composer (disable send + show notice).
 * Subscribes to the unified {@link getExecutionBroker} so the composer reacts to
 * global occupancy changes (incl. headless legs), not just this store's slices.
 */
export function useIsAtStreamCap(sessionId: string | null): boolean {
  const broker = getExecutionBroker()
  return useSyncExternalStore(
    broker.subscribe,
    () => (sessionId ? broker.isAtCapacity("ai-turn", sessionId) : false),
    () => false
  )
}

const EMPTY_STEER: SteerEntry[] = []

/** A session's pending steer messages (drives the run-status `btw` chip). */
export function useSessionSteerQueue(sessionId: string | null): SteerEntry[] {
  return useChatStore((s) =>
    sessionId ? (s.sessions[sessionId]?.steerQueue ?? EMPTY_STEER) : EMPTY_STEER
  )
}

/** A session's active-work clock (drives the run-status elapsed timer). */
export function useSessionRunTiming(sessionId: string | null): RunTiming {
  return useChatStore((s) =>
    sessionId ? (s.sessions[sessionId]?.runTiming ?? IDLE_TIMING) : IDLE_TIMING
  )
}

/** A session's monotonic run counter (the persisted RunRecord join key). */
export function useSessionRunId(sessionId: string | null): number {
  return useChatStore((s) => (sessionId ? (s.sessions[sessionId]?.runId ?? 0) : 0))
}

const EMPTY_TOOL_TIMESTAMPS: Record<string, { startedAt: number; endedAt?: number }> = {}

/** A session's per-tool timing map (drives the Run Panel's per-tool elapsed). */
export function useSessionToolTimestamps(
  sessionId: string | null
): Record<string, { startedAt: number; endedAt?: number }> {
  return useChatStore((s) =>
    sessionId
      ? (s.sessions[sessionId]?.toolTimestamps ?? EMPTY_TOOL_TIMESTAMPS)
      : EMPTY_TOOL_TIMESTAMPS
  )
}

// ── Composer draft reads ──────────────────────────────────────────────────
//
// The mirror image of `patchComposerState` / `composerSlice` on the write side.
// Every composer-draft ACTION takes an optional trailing session id so the
// unfocused split pane writes to its own conversation; without a matching read
// the pane then rendered the FOCUSED conversation's chips and toggles, so its
// own controls looked inert — clicking × on a reference chip removed it from a
// slice nobody was displaying, and Shift+Tab cycled from the other pane's mode
// and reached the model through `resolveSendOptions`.
//
// Same three-step resolution as the writer, so a control cannot read one slice
// and write another: the named session → the focused one → the bare projection
// (the pre-session ephemeral case, where the top-level fields ARE the state).

/**
 * The projected fields a composer read resolves to. Exported so the SEND path
 * — which reads through `getState()` rather than a hook — resolves the same
 * slice the chips display and the actions write.
 */
export function composerReadSlice(
  state: ChatState,
  sessionId: string | null | undefined
): Pick<ChatState, ProjectedField> {
  const id = sessionId ?? state.activeSessionId
  // `state` itself carries every projected field, so the projection case needs
  // no allocation. `EMPTY_PROJECTION` is the same stable empty the rest of the
  // store hands out for a slice that does not exist yet.
  if (id == null) return state
  return state.sessions[id] ?? (id === state.activeSessionId ? state : EMPTY_PROJECTION)
}

/** The permission mode of `sessionId`'s conversation. */
export function selectComposerPermissionMode(
  state: ChatState,
  sessionId: string | null | undefined
): PermissionMode | null {
  return composerReadSlice(state, sessionId).permissionMode
}
/** Chip-style citations recorded for `sessionId`'s next send. */
export function selectComposerCitedRefs(
  state: ChatState,
  sessionId: string | null | undefined
): ContextRef[] {
  return composerReadSlice(state, sessionId).citedRefs
}
/** Staged context selections for `sessionId`'s conversation. */
export function selectComposerContextSelections(
  state: ChatState,
  sessionId: string | null | undefined
): ContextSelectionRef[] {
  return composerReadSlice(state, sessionId).contextSelections
}
/** Per-send web-search toggle for `sessionId`'s conversation. */
export function selectComposerWebSearchOn(
  state: ChatState,
  sessionId: string | null | undefined
): boolean {
  return composerReadSlice(state, sessionId).webSearchOnForNextSend
}
/** Ephemeral skill attachments for `sessionId`'s conversation. */
export function selectComposerEphemeralSkillIds(
  state: ChatState,
  sessionId: string | null | undefined
): string[] {
  return composerReadSlice(state, sessionId).ephemeralSkillIds
}
/** Queued slash-command overrides for `sessionId`'s conversation. */
export function selectComposerPendingCommandOverrides(
  state: ChatState,
  sessionId: string | null | undefined
): PendingCommandOverrides | null {
  return composerReadSlice(state, sessionId).pendingCommandOverrides
}

/** The permission mode of the conversation this composer belongs to. */
export function useComposerPermissionMode(
  sessionId: string | null | undefined
): PermissionMode | null {
  return useChatStore((s) => selectComposerPermissionMode(s, sessionId))
}
/** Staged `@` file/dir references for this composer's conversation. */
export function useComposerReferencedPaths(sessionId: string | null | undefined): FileReference[] {
  return useChatStore((s) => composerReadSlice(s, sessionId).referencedPaths)
}
/** Staged workflow element chips for this composer's conversation. */
export function useComposerReferencedWorkflowElements(
  sessionId: string | null | undefined
): WorkflowElementRef[] {
  return useChatStore((s) => composerReadSlice(s, sessionId).referencedWorkflowElements)
}
/** Staged context selections for this composer's conversation. */
export function useComposerContextSelections(
  sessionId: string | null | undefined
): ContextSelectionRef[] {
  return useChatStore((s) => selectComposerContextSelections(s, sessionId))
}
/** Per-send web-search toggle for this composer's conversation. */
export function useComposerWebSearchOn(sessionId: string | null | undefined): boolean {
  return useChatStore((s) => selectComposerWebSearchOn(s, sessionId))
}
/** Ephemeral skill attachments for this composer's conversation. */
export function useComposerEphemeralSkillIds(sessionId: string | null | undefined): string[] {
  return useChatStore((s) => selectComposerEphemeralSkillIds(s, sessionId))
}

interface BranchMetadata {
  branchGroupId?: string
  branchIndex?: number
  /**
   * The sibling this message hangs off. See {@link selectVisibleMessages}.
   */
  branchOwnerId?: string
}

function branchMeta(m: UIMessage): BranchMetadata {
  return (m.metadata ?? {}) as BranchMetadata
}

/**
 * The sibling that should be visible for each `branchGroupId`.
 *
 * Explicit user choice wins; otherwise the highest `branchIndex` — the most
 * recently produced sibling — which is what a fresh regenerate should surface.
 */
function resolveBranchWinners(
  messages: readonly UIMessage[],
  activeBranchByGroup: Record<string, string>
): Map<string, string> {
  const winners = new Map<string, string>()
  const bestIndex = new Map<string, number>()

  for (const m of messages) {
    const { branchGroupId, branchIndex } = branchMeta(m)
    if (!branchGroupId) continue
    if (activeBranchByGroup[branchGroupId]) {
      winners.set(branchGroupId, activeBranchByGroup[branchGroupId])
      continue
    }
    const idx = branchIndex ?? 0
    if (!winners.has(branchGroupId) || idx > (bestIndex.get(branchGroupId) ?? -1)) {
      winners.set(branchGroupId, m.id)
      bestIndex.set(branchGroupId, idx)
    }
  }
  return winners
}

/**
 * Filter messages down to the currently-visible thread.
 *
 * Two rules compose here:
 *
 *  1. **Siblings** — messages sharing a `branchGroupId` are alternatives, and
 *     exactly one is shown. Produced by regenerating a reply, and by editing a
 *     user message (see `tagBranchSiblings`).
 *
 *  2. **Ownership** — a message carrying `branchOwnerId` hangs off a specific
 *     sibling and is shown only while that sibling is. Editing a user message
 *     mid-thread branches everything that followed it, and without this rule
 *     flipping back to the original would show the original question with the
 *     *other* variant's answers under it.
 *
 * Ownership is **transitive**: hiding a sibling hides what hangs off it, and
 * what hangs off that. A single forward pass suffices because a message always
 * follows the sibling it hangs off — it did not exist until that sibling did.
 *
 * The winner per group is resolved up front rather than during the walk. The
 * old single-pass form retro-actively spliced a later, higher-index sibling
 * over an earlier one, which is fine on its own but cannot work once messages
 * hang off siblings: anything owned by the displaced message has already been
 * emitted by the time it is displaced.
 *
 * Pure function — safe to call from selectors and tests.
 */
export function selectVisibleMessages(
  messages: UIMessage[],
  activeBranchByGroup: Record<string, string>
): UIMessage[] {
  const winners = resolveBranchWinners(messages, activeBranchByGroup)
  const byId = new Map<string, UIMessage>()
  for (const m of messages) byId.set(m.id, m)

  const out: UIMessage[] = []
  const emittedGroups = new Set<string>()
  const hidden = new Set<string>()

  for (const m of messages) {
    const { branchGroupId, branchOwnerId } = branchMeta(m)

    // Rule 2 first: an owner that is hidden takes its whole subtree with it,
    // whatever this message's own sibling state is.
    if (branchOwnerId !== undefined && hidden.has(branchOwnerId)) {
      hidden.add(m.id)
      continue
    }

    if (!branchGroupId) {
      out.push(m)
      continue
    }

    const winnerId = winners.get(branchGroupId)
    if (m.id !== winnerId) {
      hidden.add(m.id)
      // Emit the winner at the FIRST sibling's position, preserving where the
      // group sits in the thread regardless of which alternative is selected.
      if (!emittedGroups.has(branchGroupId)) {
        const winner = winnerId ? byId.get(winnerId) : undefined
        if (winner) {
          out.push(winner)
          emittedGroups.add(branchGroupId)
        }
      }
      continue
    }

    if (!emittedGroups.has(branchGroupId)) {
      out.push(m)
      emittedGroups.add(branchGroupId)
    }
  }
  return out
}

/**
 * Collect all messages in `messages` that belong to `branchGroupId`, sorted
 * by `branchIndex` ascending. Used by the branch navigator to enumerate
 * prev/next siblings.
 */
export function selectBranchSiblings(messages: UIMessage[], branchGroupId: string): UIMessage[] {
  const matches = messages.filter(
    (m) => (m.metadata as { branchGroupId?: string } | undefined)?.branchGroupId === branchGroupId
  )
  return [...matches].sort((a, b) => {
    const ai = (a.metadata as { branchIndex?: number } | undefined)?.branchIndex ?? 0
    const bi = (b.metadata as { branchIndex?: number } | undefined)?.branchIndex ?? 0
    return ai - bi
  })
}
