"use client"

import type { UIMessage } from "ai"
import { create } from "zustand"
import type {
  PendingApproval,
  SendContent,
  SendContentBlock,
  SendOptions,
} from "@/lib/claude/types"
import type { ArtifactSelectionRef } from "@/types/artifact/artifact"
import { nextNavEpoch } from "@/lib/ui/nav-epoch"
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
  errorMessage: string | null
  pendingApprovals: PendingApproval[]
  /** Per-session assistant-branch selection (see `selectVisibleMessages`). */
  activeBranchByGroup: Record<string, string>
  messagesLoading: boolean
  messagesLoadError: string | null
  messagesReloadNonce: number
  /**
   * Steer queue — follow-up messages the user typed while this session's turn
   * was still running. Held client-side (true mid-turn injection isn't
   * available; see `lib/claude/steer.ts`) and replayed as a fresh turn when the
   * running turn settles. The run-status bar shows the depth + a preview.
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
}

/** Default-initialised slice. `loading` seeds the hydration spinner for a
 * freshly-focused (not-yet-hydrated) session. */
export function makeSessionSlice(loading = false): SessionChatSlice {
  return {
    messages: [],
    status: "idle",
    errorMessage: null,
    pendingApprovals: [],
    activeBranchByGroup: {},
    messagesLoading: loading,
    messagesLoadError: null,
    messagesReloadNonce: 0,
    steerQueue: [],
    runTiming: IDLE_TIMING,
    runId: 0,
    toolTimestamps: {},
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
  | "pendingApprovals"
  | "activeBranchByGroup"
  | "messagesLoading"
  | "messagesLoadError"
  | "messagesReloadNonce"

/** Project a slice onto the store's top-level (active-session) fields. */
function projectSlice(slice: SessionChatSlice): Pick<ChatState, ProjectedField> {
  return {
    messages: slice.messages,
    status: slice.status,
    errorMessage: slice.errorMessage,
    pendingApprovals: slice.pendingApprovals,
    activeBranchByGroup: slice.activeBranchByGroup,
    messagesLoading: slice.messagesLoading,
    messagesLoadError: slice.messagesLoadError,
    messagesReloadNonce: slice.messagesReloadNonce,
  }
}

const EMPTY_PROJECTION = projectSlice(makeSessionSlice())

/** Read the slice for `id`, seeding from the active projection when the id is
 * the active session but its slice has not been materialised yet. */
function sliceForId(state: ChatState, id: string): SessionChatSlice {
  const existing = state.sessions[id]
  if (existing) return existing
  if (id === state.activeSessionId) {
    return {
      messages: state.messages,
      status: state.status,
      errorMessage: state.errorMessage,
      pendingApprovals: state.pendingApprovals,
      activeBranchByGroup: state.activeBranchByGroup,
      messagesLoading: state.messagesLoading,
      messagesLoadError: state.messagesLoadError,
      messagesReloadNonce: state.messagesReloadNonce,
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
   * Artifact snippets the user selected + commented on, staged as context chips
   * for the next send. Cleared on send (like attachments) and on focus change.
   */
  artifactSelections: ArtifactSelectionRef[]
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
  setSessionError: (id: string, msg: string | null) => void
  /** Append a steer message to a session's queue (typed while it was busy). */
  enqueueSteer: (id: string, entry: SteerEntry) => void
  /** Remove a single queued steer entry by its id (no-op if absent). */
  removeSteerEntry: (id: string, entryId: string) => void
  /** Replace the text of a single queued steer entry (keeps its blocks). */
  updateSteerEntry: (id: string, entryId: string, text: string) => void
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
  setPermissionMode: (mode: PermissionMode | null) => void
  addReferencedPath: (ref: FileReference) => void
  removeReferencedPath: (absolute: string) => void
  clearReferencedPaths: () => void
  /** Stage a workflow element as a reference chip for the next copilot turn. */
  addReferencedWorkflowElement: (ref: WorkflowElementRef) => void
  removeReferencedWorkflowElement: (type: "node" | "edge", id: string) => void
  clearReferencedWorkflowElements: () => void
  /** Stage an artifact selection as a context chip for the next send. */
  addArtifactSelection: (selection: ArtifactSelectionRef) => void
  /** Remove a staged artifact selection (by index, since snapshots can repeat). */
  removeArtifactSelection: (index: number) => void
  clearArtifactSelections: () => void
  setPendingCommandOverrides: (overrides: PendingCommandOverrides | null) => void
  toggleBookmark: (messageId: string) => void
  setWebSearchOnForNextSend: (v: boolean) => void
  setEphemeralSkillIds: (ids: string[]) => void
  toggleEphemeralSkill: (id: string) => void
  clearEphemeralSkillIds: () => void
  /** Drop ids from the ephemeral attachment list (e.g. after a skill is deleted). */
  removeEphemeralSkillIds: (ids: string[]) => void
  setLastSend: (sessionId: string, entry: LastSendCacheEntry) => void
  bumpLastSendAttempt: (sessionId: string) => void
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
  pendingApprovals: [],
  permissionMode: null,
  referencedPaths: [],
  referencedWorkflowElements: [],
  artifactSelections: [],
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
      // Composer-scoped UI toggles always reset on a focus change — they belong
      // to "the pane you're typing in", not the conversation. The per-session
      // slices (messages/status/error/approvals/branches) are NOT touched, so a
      // background session's in-flight stream survives the switch untouched.
      const uiReset: Partial<ChatState> = {
        permissionMode: null,
        referencedPaths: [],
        referencedWorkflowElements: [],
        artifactSelections: [],
        pendingCommandOverrides: null,
        bookmarkedIds: [],
        webSearchOnForNextSend: false,
        ephemeralSkillIds: [],
      }
      // Stamp the switch so the desktop workspace can tell whether the session
      // or the guild was the more recent navigation intent.
      const activeSessionEpoch = nextNavEpoch()
      if (id == null) {
        return { activeSessionId: null, activeSessionEpoch, ...uiReset, ...EMPTY_PROJECTION }
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
        ...uiReset,
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
      patchActiveState(s, { messages: msgs, messagesLoading: false, messagesLoadError: null })
    ),
  appendMessage: (msg) => set((s) => patchActiveState(s, { messages: [...s.messages, msg] })),
  replaceMessages: (msgs) => set((s) => patchActiveState(s, { messages: msgs })),
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
        ...statusPatch(s, id, msg ? "error" : "idle"),
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
      const slice = sliceForId(s, approval.sessionId)
      return patchSliceState(s, approval.sessionId, {
        pendingApprovals: [...slice.pendingApprovals, approval],
        ...statusPatch(s, approval.sessionId, "awaiting_approval"),
      })
    }),
  clearApproval: (requestId, sessionId) =>
    set((s) => {
      const targetId =
        sessionId ??
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
      const nextStatus: ChatStatus =
        next.length === 0 && slice.status === "awaiting_approval" ? "streaming" : slice.status
      return patchSliceState(s, targetId, {
        pendingApprovals: next,
        ...statusPatch(s, targetId, nextStatus),
      })
    }),
  setPermissionMode: (mode) => set({ permissionMode: mode }),
  addReferencedPath: (ref) =>
    set((s) =>
      s.referencedPaths.some((r) => r.absolute === ref.absolute)
        ? s
        : { referencedPaths: [...s.referencedPaths, ref] }
    ),
  addArtifactSelection: (selection) =>
    set((s) => ({ artifactSelections: [...s.artifactSelections, selection] })),
  removeArtifactSelection: (index) =>
    set((s) =>
      index < 0 || index >= s.artifactSelections.length
        ? s
        : { artifactSelections: s.artifactSelections.filter((_, i) => i !== index) }
    ),
  clearArtifactSelections: () =>
    set((s) => (s.artifactSelections.length === 0 ? s : { artifactSelections: [] })),
  removeReferencedPath: (absolute) =>
    set((s) => ({
      referencedPaths: s.referencedPaths.filter((r) => r.absolute !== absolute),
    })),
  setPendingCommandOverrides: (overrides) => set({ pendingCommandOverrides: overrides }),
  clearReferencedPaths: () => set({ referencedPaths: [] }),
  addReferencedWorkflowElement: (ref) =>
    set((s) =>
      s.referencedWorkflowElements.some((r) => r.type === ref.type && r.id === ref.id)
        ? s
        : { referencedWorkflowElements: [...s.referencedWorkflowElements, ref] }
    ),
  removeReferencedWorkflowElement: (type, id) =>
    set((s) => ({
      referencedWorkflowElements: s.referencedWorkflowElements.filter(
        (r) => !(r.type === type && r.id === id)
      ),
    })),
  clearReferencedWorkflowElements: () =>
    set((s) =>
      s.referencedWorkflowElements.length === 0 ? s : { referencedWorkflowElements: [] }
    ),
  toggleBookmark: (messageId) =>
    set((s) => {
      const exists = s.bookmarkedIds.includes(messageId)
      return {
        bookmarkedIds: exists
          ? s.bookmarkedIds.filter((id) => id !== messageId)
          : [...s.bookmarkedIds, messageId],
      }
    }),
  setWebSearchOnForNextSend: (v) => set({ webSearchOnForNextSend: v }),
  setEphemeralSkillIds: (ids) => set({ ephemeralSkillIds: ids }),
  toggleEphemeralSkill: (id) =>
    set((s) => ({
      ephemeralSkillIds: s.ephemeralSkillIds.includes(id)
        ? s.ephemeralSkillIds.filter((x) => x !== id)
        : [...s.ephemeralSkillIds, id],
    })),
  clearEphemeralSkillIds: () => set({ ephemeralSkillIds: [] }),
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
      pendingApprovals: [],
      permissionMode: null,
      referencedPaths: [],
      referencedWorkflowElements: [],
      artifactSelections: [],
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

/**
 * Filter messages so only the active branch within each `branchGroupId`
 * survives. Messages without a `branchGroupId` are passed through unchanged.
 * Pure function — safe to call from selectors and tests.
 */
export function selectVisibleMessages(
  messages: UIMessage[],
  activeBranchByGroup: Record<string, string>
): UIMessage[] {
  const out: UIMessage[] = []
  const lastSeenByGroup = new Map<string, UIMessage>()

  for (const m of messages) {
    const groupId = (m.metadata as { branchGroupId?: string } | undefined)?.branchGroupId
    if (!groupId) {
      out.push(m)
      continue
    }
    const activeId = activeBranchByGroup[groupId]
    if (activeId) {
      if (m.id === activeId) out.push(m)
      // Drop the non-active siblings.
      continue
    }
    // No explicit choice yet — show the highest branchIndex (or last seen).
    const prev = lastSeenByGroup.get(groupId)
    const prevIdx = (prev?.metadata as { branchIndex?: number } | undefined)?.branchIndex ?? -1
    const curIdx = (m.metadata as { branchIndex?: number } | undefined)?.branchIndex ?? 0
    if (!prev || curIdx > prevIdx) {
      // Replace the placeholder for this group.
      if (prev) {
        const idx = out.indexOf(prev)
        if (idx >= 0) out.splice(idx, 1, m)
      } else {
        out.push(m)
      }
      lastSeenByGroup.set(groupId, m)
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
