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
   * Per-session snapshot of the last send so a `session_ended` with a
   * transient error can re-issue the turn through the alias's fallback
   * chain without re-running `resolveSendOptions`. Cleared on a clean
   * session_ended and on session change. See `lib/claude/routing-fallback.ts`.
   */
  lastSendBySession: Record<string, LastSendCacheEntry>

  setActiveSession: (id: string | null) => void
  setMessages: (msgs: UIMessage[]) => void
  appendMessage: (msg: UIMessage) => void
  replaceMessages: (msgs: UIMessage[]) => void
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
  setLastSend: (sessionId: string, entry: LastSendCacheEntry) => void
  bumpLastSendAttempt: (sessionId: string) => void
  clearLastSend: (sessionId: string) => void
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
  lastSendBySession: {},

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
      lastSendBySession: {},
    }),
  setMessages: (msgs) => set({ messages: msgs }),
  appendMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  replaceMessages: (msgs) => set({ messages: msgs }),
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
      lastSendBySession: {},
    }),
}))
