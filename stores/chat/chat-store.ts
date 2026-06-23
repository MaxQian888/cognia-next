"use client"

import type { UIMessage } from "ai"
import { create } from "zustand"
import type { PendingApproval, SendContent, SendOptions } from "@/lib/claude/types"
import { nextNavEpoch } from "@/lib/ui/nav-epoch"

export type ChatStatus = "idle" | "streaming" | "awaiting_approval" | "error"

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

export interface FileReference {
  /** Absolute path on disk; what the SDK needs in `additionalDirectories`. */
  absolute: string
  /** Path relative to the workspace root, with forward slashes. */
  relative: string
  isDir: boolean
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
  }
}

/** Maximum number of sessions allowed to stream concurrently. Over-cap sends
 * are blocked (never silently queued / dropped) — the composer disables send
 * and surfaces an inline notice; `send()` defends as a backstop. */
export const MAX_CONCURRENT_STREAMS = 3

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
    }
  }
  return makeSessionSlice()
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
  setPendingCommandOverrides: (overrides: PendingCommandOverrides | null) => void
  toggleBookmark: (messageId: string) => void
  setWebSearchOnForNextSend: (v: boolean) => void
  setEphemeralSkillIds: (ids: string[]) => void
  toggleEphemeralSkill: (id: string) => void
  clearEphemeralSkillIds: () => void
  setLastSend: (sessionId: string, entry: LastSendCacheEntry) => void
  bumpLastSendAttempt: (sessionId: string) => void
  clearLastSend: (sessionId: string) => void
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
  pendingCommandOverrides: null,
  bookmarkedIds: [],
  webSearchOnForNextSend: false,
  ephemeralSkillIds: [],
  lastSendBySession: {},
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
  setStatus: (st) => set((s) => patchActiveState(s, { status: st })),
  setError: (msg) =>
    set((s) => patchActiveState(s, { errorMessage: msg, status: msg ? "error" : "idle" })),
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
  setSessionStatus: (id, st) => set((s) => patchSliceState(s, id, { status: st })),
  setSessionError: (id, msg) =>
    set((s) => patchSliceState(s, id, { errorMessage: msg, status: msg ? "error" : "idle" })),
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
        status: "awaiting_approval",
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
      return patchSliceState(s, targetId, {
        pendingApprovals: next,
        status:
          next.length === 0 && slice.status === "awaiting_approval" ? "streaming" : slice.status,
      })
    }),
  setPermissionMode: (mode) => set({ permissionMode: mode }),
  addReferencedPath: (ref) =>
    set((s) =>
      s.referencedPaths.some((r) => r.absolute === ref.absolute)
        ? s
        : { referencedPaths: [...s.referencedPaths, ref] }
    ),
  removeReferencedPath: (absolute) =>
    set((s) => ({
      referencedPaths: s.referencedPaths.filter((r) => r.absolute !== absolute),
    })),
  setPendingCommandOverrides: (overrides) => set({ pendingCommandOverrides: overrides }),
  clearReferencedPaths: () => set({ referencedPaths: [] }),
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
      pendingCommandOverrides: null,
      bookmarkedIds: [],
      webSearchOnForNextSend: false,
      ephemeralSkillIds: [],
      lastSendBySession: {},
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
 * True when starting a *new* stream on `sessionId` would exceed
 * `MAX_CONCURRENT_STREAMS`. A session that is already streaming is never
 * blocked from continuing (it is excluded from the count comparison).
 */
export function selectIsAtStreamCap(
  state: { sessions: Record<string, SessionChatSlice> },
  sessionId: string
): boolean {
  const streaming = selectStreamingSessionIds(state)
  if (streaming.includes(sessionId)) return false
  return streaming.length >= MAX_CONCURRENT_STREAMS
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
/** Reactive cap check for a pane's composer (disable send + show notice). */
export function useIsAtStreamCap(sessionId: string | null): boolean {
  return useChatStore((s) => (sessionId ? selectIsAtStreamCap(s, sessionId) : false))
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
