"use client"

import type { UIMessage } from "ai"
import { create } from "zustand"
import type { PendingApproval, SendContent, SendOptions } from "@/lib/claude/types"

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

interface ChatState {
  activeSessionId: string | null
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
  setMessages: (msgs: UIMessage[]) => void
  appendMessage: (msg: UIMessage) => void
  replaceMessages: (msgs: UIMessage[]) => void
  setMessagesLoading: (v: boolean) => void
  setMessagesLoadError: (msg: string | null) => void
  /** Re-trigger the active session's history load (retry after a load error). */
  requestMessagesReload: () => void
  setStatus: (s: ChatStatus) => void
  setError: (msg: string | null) => void
  pushApproval: (approval: PendingApproval) => void
  clearApproval: (requestId: string) => void
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
    set({
      activeSessionId: id,
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
      // Switching to a session begins a hydration; switching to none doesn't.
      messagesLoading: id != null,
      messagesLoadError: null,
    }),
  // A successful hydration / replacement clears the transient load flags.
  setMessages: (msgs) => set({ messages: msgs, messagesLoading: false, messagesLoadError: null }),
  appendMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  replaceMessages: (msgs) => set({ messages: msgs }),
  setMessagesLoading: (v) => set({ messagesLoading: v }),
  setMessagesLoadError: (msg) => set({ messagesLoadError: msg, messagesLoading: false }),
  requestMessagesReload: () =>
    set((s) => ({
      messagesReloadNonce: s.messagesReloadNonce + 1,
      messagesLoading: true,
      messagesLoadError: null,
    })),
  setStatus: (s) => set({ status: s }),
  setError: (msg) => set({ errorMessage: msg, status: msg ? "error" : "idle" }),
  pushApproval: (approval) =>
    set((s) => ({
      pendingApprovals: [...s.pendingApprovals, approval],
      status: "awaiting_approval",
    })),
  clearApproval: (requestId) =>
    set((s) => {
      const next = s.pendingApprovals.filter((a) => a.requestId !== requestId)
      return {
        pendingApprovals: next,
        status: next.length === 0 && s.status === "awaiting_approval" ? "streaming" : s.status,
      }
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
        : {
            activeBranchByGroup: {
              ...s.activeBranchByGroup,
              [branchGroupId]: messageId,
            },
          }
    ),
  hydrateActiveBranches: (map) => set({ activeBranchByGroup: { ...map } }),
  clear: () =>
    set({
      activeSessionId: null,
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
