"use client"

/**
 * Terminal Store — UI-facing state for the integrated terminal dock.
 *
 * Owns:
 *   * `sessions` — UI metadata keyed by sessionId (project, title, status,
 *     exit code). The live `TerminalSession` instance lives in
 *     `lib/terminal/session.ts` and isn't stored here — keeping the
 *     store JSON-serialisable avoids cross-render leaks and makes
 *     time-travel debugging viable.
 *   * `activeSessionIdByProject` — last-focused tab per project; when
 *     the user switches projects, the dock restores their previous tab.
 *   * `panelOpen` / `panelHeightPct` — dock visibility + size.
 *
 * Persistence (via `zustand/middleware/persist`):
 *   * `panelOpen` and `panelHeightPct` survive reloads.
 *   * Sessions do NOT — every session is killed on window close
 *     (`PtySession::Drop` on the Rust side), and replay across reload
 *     is explicitly out of v1 scope (see plan §Out of scope).
 *
 * Shape mirrors `stores/inbox/inbox-layout-store.ts` deliberately —
 * see plan §Reuse map row #6. Debounced flush, DEFAULTS + BOUNDS
 * constants, and `partialize` callback are all carried across.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"

import type { SessionInfo } from "@/lib/terminal/types"

/**
 * Status the tab badge surfaces. Driven by OSC 633 events (`command_*`)
 * and the session's exit code.
 */
export type TerminalTabStatus =
  | "idle" // shell is ready, no command running
  | "running" // OSC 633 C → command in progress
  | "exited" // exit event fired, exit code in `exitCode`

/** One past command captured from OSC 633 `C` → `D` boundaries. */
export interface TerminalCommandRecord {
  /** Best-effort command text inferred from prompt window. Empty string when capture missed. */
  cmd: string
  /** Exit code from the OSC 633 `D` event; null when shell didn't report one. */
  exitCode: number | null
  /** ms-since-epoch when the command ended. */
  endedAt: number
}

/** Prompt span captured from OSC 633 `A` (prompt_start) / `B` (prompt_end). */
export interface TerminalPromptBoundary {
  startMs: number
  /** Filled when `B` (prompt_end) arrives. */
  endMs?: number
}

export interface TerminalSessionRow {
  id: string
  projectId: string | null
  extensionId: string | null
  /** Auto-derived title from shell + extension. Use `displayTitle()` to apply `customTitle` override. */
  title: string
  /** User-supplied tab title via Rename action. `null` falls back to `title`. */
  customTitle: string | null
  shell: string
  origin: "local" | "remote"
  status: TerminalTabStatus
  exitCode: number | null
  cwd: string | null
  createdAt: number
  /** Per-(chat, tab) trust grant cache key surface. UI only; the authoritative grant lives in `PluginConsentBroker`. */
  agentTrusted: boolean
  /** Identity of the agent (chat session) that spawned this tab. `null` when user-spawned. Set by `lib/terminal/dock-tool-handler.ts` when the agent calls `terminal_dock_spawn`; reads filter the agent-only dock view. */
  agentSpawner: string | null
  /** OSC 633 prompt boundaries — newest last, capped to last 32. */
  promptBoundaries: TerminalPromptBoundary[]
  /** Recent commands ring, newest last, capped to {@link TERMINAL_HISTORY_RING_SIZE}. */
  lastCommands: TerminalCommandRecord[]
  /** Whether the history rail is shown for this tab. */
  historyOpen: boolean
}

export const TERMINAL_LAYOUT_DEFAULTS = {
  panelOpen: false,
  panelHeightPct: 32,
} as const

export const TERMINAL_LAYOUT_BOUNDS = {
  panelMinPct: 15,
  panelMaxPct: 75,
} as const

export const TERMINAL_LAYOUT_PERSIST_DEBOUNCE_MS = 150

/** Maximum entries in the per-tab command-history ring. Mirrors VS Code's terminal history default. */
export const TERMINAL_HISTORY_RING_SIZE = 50
/** Maximum entries in the prompt-boundary ring (decoration consumer only needs the last few). */
export const TERMINAL_PROMPT_RING_SIZE = 32

let pendingFlush: ReturnType<typeof setTimeout> | null = null

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

export interface TerminalStoreState {
  // Persisted UI shell
  panelOpen: boolean
  panelHeightPct: number

  // In-memory tab state
  sessions: Record<string, TerminalSessionRow>
  activeSessionIdByProject: Record<string, string | null>

  // Split panes (1A) — VS Code-style flat pane groups. A session is a tab
  // (group "anchor") unless it appears as a non-anchor member of some group
  // here. `splitPanes[anchorId]` is the ordered list of EXTRA panes beside
  // the anchor (the anchor itself is implicit at position 0). Absent key =
  // single pane (current behavior).
  splitPanes: Record<string, string[]>
  /** Focused pane per group — anchor or one of its split panes. Defaults to the anchor. */
  focusedPaneByAnchor: Record<string, string>
  /** Split orientation per group. Defaults to "row". */
  splitDirection: Record<string, "row" | "col">

  // Mutations
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
  setPanelHeight: (pct: number) => void

  registerSession: (info: SessionInfo, opts?: { title?: string; agentSpawner?: string }) => void
  removeSession: (id: string) => void
  setSessionStatus: (id: string, status: TerminalTabStatus) => void
  setSessionExit: (id: string, exitCode: number | null) => void
  setSessionCwd: (id: string, cwd: string) => void
  setSessionTitle: (id: string, title: string) => void

  /** Set or clear a user-supplied tab title. `null` reverts to the auto title. */
  renameSession: (id: string, customTitle: string | null) => void
  setAgentTrusted: (id: string, trusted: boolean) => void
  setAgentSpawner: (id: string, agentSpawner: string | null) => void
  pushPrompt: (id: string, startMs: number) => void
  closePrompt: (id: string, endMs: number) => void
  pushCommand: (id: string, record: TerminalCommandRecord) => void
  setHistoryOpen: (id: string, open: boolean) => void

  setActiveSession: (projectId: string | null, sessionId: string | null) => void
  getActiveSession: (projectId: string | null) => string | null

  /** Tab list for `projectId`, sorted by createdAt asc. */
  sessionsForProject: (projectId: string | null) => TerminalSessionRow[]

  /** Tabs spawned by `agentId` — `dock-tool-handler` uses this to scope agent-side reads/writes via `runTerminalDockAction`. */
  sessionsForAgent: (agentId: string) => TerminalSessionRow[]

  // ── Split panes (1A) ──────────────────────────────────────────────
  /** Add `paneId` as a split pane under `anchorId`'s group, focus it, keep the anchor as the active tab. */
  addPaneToGroup: (anchorId: string, paneId: string, direction?: "row" | "col") => void
  /** Set the focused pane within a group (anchor resolved from `anchorOrPaneId`). */
  setFocusedPane: (anchorOrPaneId: string, paneId: string) => void
  /** Resolve the group anchor a session belongs to (itself when standalone). */
  groupAnchorOf: (sessionId: string) => string
  /** Ordered pane ids for a group including the anchor at position 0. */
  panesForGroup: (anchorOrPaneId: string) => string[]
  /** Tab list for `projectId` — group anchors only (split members hidden), sorted by createdAt asc. */
  tabsForProject: (projectId: string | null) => TerminalSessionRow[]

  reset: () => void
}

/** Resolve the user-visible title for a row, falling back to the auto-derived one. */
export function displayTitle(row: Pick<TerminalSessionRow, "title" | "customTitle">): string {
  return row.customTitle && row.customTitle.length > 0 ? row.customTitle : row.title
}

function makeTitle(info: SessionInfo): string {
  if (info.extensionId) {
    return `${info.extensionId} · ${shortShell(info.shell)}`
  }
  return shortShell(info.shell)
}

function shortShell(path: string): string {
  // `/usr/local/bin/zsh` → `zsh`. `pwsh.exe` → `pwsh`. `bash --rcfile …` → `bash`.
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  const tail = lastSlash >= 0 ? path.slice(lastSlash + 1) : path
  return tail.replace(/\.exe$/i, "").split(" ")[0] ?? path
}

/** Resolve the group anchor for a session. Members map back to their anchor; standalone/anchor sessions map to themselves. */
function resolveAnchor(sessionId: string, splitPanes: Record<string, string[]>): string {
  for (const [anchor, members] of Object.entries(splitPanes)) {
    if (members.includes(sessionId)) return anchor
  }
  return sessionId
}

/** True when the session is a non-anchor member of some split group (so it should NOT render as its own tab). */
function isGroupMember(sessionId: string, splitPanes: Record<string, string[]>): boolean {
  for (const members of Object.values(splitPanes)) {
    if (members.includes(sessionId)) return true
  }
  return false
}

export const useTerminalStore = create<TerminalStoreState>()(
  persist(
    (set, get) => ({
      ...TERMINAL_LAYOUT_DEFAULTS,
      sessions: {},
      activeSessionIdByProject: {},
      splitPanes: {},
      focusedPaneByAnchor: {},
      splitDirection: {},

      setPanelOpen: (open) => set({ panelOpen: open }),

      togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),

      setPanelHeight: (pct) => {
        const { panelMinPct, panelMaxPct } = TERMINAL_LAYOUT_BOUNDS
        const clamped = clamp(pct, panelMinPct, panelMaxPct)
        set({ panelHeightPct: clamped })
        if (pendingFlush) clearTimeout(pendingFlush)
        pendingFlush = setTimeout(() => {
          pendingFlush = null
          set({ panelHeightPct: get().panelHeightPct })
        }, TERMINAL_LAYOUT_PERSIST_DEBOUNCE_MS)
      },

      registerSession: (info, opts = {}) => {
        const row: TerminalSessionRow = {
          id: info.id,
          projectId: info.projectId,
          extensionId: info.extensionId,
          title: opts.title ?? makeTitle(info),
          customTitle: null,
          shell: info.shell,
          origin: info.origin,
          status: "idle",
          exitCode: null,
          cwd: null,
          createdAt: Date.now(),
          agentTrusted: false,
          agentSpawner: opts.agentSpawner ?? null,
          promptBoundaries: [],
          lastCommands: [],
          historyOpen: false,
        }
        set((s) => ({
          sessions: { ...s.sessions, [info.id]: row },
          activeSessionIdByProject: {
            ...s.activeSessionIdByProject,
            [info.projectId ?? ""]: info.id,
          },
        }))
      },

      removeSession: (id) => {
        set((s) => {
          if (!s.sessions[id]) return s
          const next = { ...s.sessions }
          delete next[id]

          // ── Group cleanup (1A) ──────────────────────────────────────
          // Detach the removed session from its split group. If it was the
          // anchor, promote the next pane so the group (and its tab)
          // survives. `anchorRemap` carries the old→new anchor change so
          // the active pointer can follow it.
          const splitPanes = { ...s.splitPanes }
          const focusedPaneByAnchor = { ...s.focusedPaneByAnchor }
          const splitDirection = { ...s.splitDirection }
          const anchor = resolveAnchor(id, splitPanes)
          let anchorRemap: { from: string; to: string } | null = null
          if (anchor === id) {
            const members = splitPanes[id] ?? []
            if (members.length > 0) {
              const [newAnchor, ...rest] = members
              delete splitPanes[id]
              if (rest.length > 0) splitPanes[newAnchor] = rest
              const dir = splitDirection[id]
              delete splitDirection[id]
              if (dir && rest.length > 0) splitDirection[newAnchor] = dir
              const foc = focusedPaneByAnchor[id]
              delete focusedPaneByAnchor[id]
              focusedPaneByAnchor[newAnchor] = foc && foc !== id && next[foc] ? foc : newAnchor
              anchorRemap = { from: id, to: newAnchor }
            } else {
              delete splitPanes[id]
              delete focusedPaneByAnchor[id]
              delete splitDirection[id]
            }
          } else {
            const members = (splitPanes[anchor] ?? []).filter((m) => m !== id)
            if (members.length > 0) splitPanes[anchor] = members
            else {
              delete splitPanes[anchor]
              delete splitDirection[anchor]
            }
            if (focusedPaneByAnchor[anchor] === id) focusedPaneByAnchor[anchor] = anchor
          }

          // ── Active pointer adjust (anchors only) ────────────────────
          const nextActive = { ...s.activeSessionIdByProject }
          for (const [projectId, activeId] of Object.entries(nextActive)) {
            if (activeId === id) {
              if (anchorRemap) {
                nextActive[projectId] = anchorRemap.to
              } else {
                const remaining = Object.values(next)
                  .filter((r) => (r.projectId ?? "") === projectId)
                  .filter((r) => !isGroupMember(r.id, splitPanes))
                  .sort((a, b) => a.createdAt - b.createdAt)
                nextActive[projectId] = remaining[remaining.length - 1]?.id ?? null
              }
            } else if (anchorRemap && activeId === anchorRemap.from) {
              nextActive[projectId] = anchorRemap.to
            }
          }
          return {
            sessions: next,
            activeSessionIdByProject: nextActive,
            splitPanes,
            focusedPaneByAnchor,
            splitDirection,
          }
        })
      },

      setSessionStatus: (id, status) => {
        set((s) => {
          const row = s.sessions[id]
          if (!row) return s
          return { sessions: { ...s.sessions, [id]: { ...row, status } } }
        })
      },

      setSessionExit: (id, exitCode) => {
        set((s) => {
          const row = s.sessions[id]
          if (!row) return s
          return {
            sessions: {
              ...s.sessions,
              [id]: { ...row, status: "exited", exitCode },
            },
          }
        })
      },

      setSessionCwd: (id, cwd) => {
        set((s) => {
          const row = s.sessions[id]
          if (!row) return s
          return { sessions: { ...s.sessions, [id]: { ...row, cwd } } }
        })
      },

      setSessionTitle: (id, title) => {
        set((s) => {
          const row = s.sessions[id]
          if (!row) return s
          return { sessions: { ...s.sessions, [id]: { ...row, title } } }
        })
      },

      renameSession: (id, customTitle) => {
        set((s) => {
          const row = s.sessions[id]
          if (!row) return s
          const next = customTitle && customTitle.trim().length > 0 ? customTitle.trim() : null
          return { sessions: { ...s.sessions, [id]: { ...row, customTitle: next } } }
        })
      },

      setAgentTrusted: (id, trusted) => {
        set((s) => {
          const row = s.sessions[id]
          if (!row) return s
          return { sessions: { ...s.sessions, [id]: { ...row, agentTrusted: trusted } } }
        })
      },

      setAgentSpawner: (id, agentSpawner) => {
        set((s) => {
          const row = s.sessions[id]
          if (!row) return s
          return { sessions: { ...s.sessions, [id]: { ...row, agentSpawner } } }
        })
      },

      pushPrompt: (id, startMs) => {
        set((s) => {
          const row = s.sessions[id]
          if (!row) return s
          const next = [...row.promptBoundaries, { startMs }]
          if (next.length > TERMINAL_PROMPT_RING_SIZE)
            next.splice(0, next.length - TERMINAL_PROMPT_RING_SIZE)
          return { sessions: { ...s.sessions, [id]: { ...row, promptBoundaries: next } } }
        })
      },

      closePrompt: (id, endMs) => {
        set((s) => {
          const row = s.sessions[id]
          if (!row) return s
          if (row.promptBoundaries.length === 0) return s
          const last = row.promptBoundaries[row.promptBoundaries.length - 1]
          // Only close if the tail boundary is still open; otherwise a stray B
          // event would corrupt history.
          if (last.endMs != null) return s
          const next = row.promptBoundaries.slice(0, -1)
          next.push({ ...last, endMs })
          return { sessions: { ...s.sessions, [id]: { ...row, promptBoundaries: next } } }
        })
      },

      pushCommand: (id, record) => {
        set((s) => {
          const row = s.sessions[id]
          if (!row) return s
          const next = [...row.lastCommands, record]
          if (next.length > TERMINAL_HISTORY_RING_SIZE)
            next.splice(0, next.length - TERMINAL_HISTORY_RING_SIZE)
          return { sessions: { ...s.sessions, [id]: { ...row, lastCommands: next } } }
        })
      },

      setHistoryOpen: (id, open) => {
        set((s) => {
          const row = s.sessions[id]
          if (!row) return s
          return { sessions: { ...s.sessions, [id]: { ...row, historyOpen: open } } }
        })
      },

      setActiveSession: (projectId, sessionId) => {
        set((s) => ({
          activeSessionIdByProject: {
            ...s.activeSessionIdByProject,
            [projectId ?? ""]: sessionId,
          },
        }))
      },

      getActiveSession: (projectId) => {
        return get().activeSessionIdByProject[projectId ?? ""] ?? null
      },

      sessionsForProject: (projectId) => {
        const target = projectId ?? ""
        return Object.values(get().sessions)
          .filter((row) => (row.projectId ?? "") === target)
          .sort((a, b) => a.createdAt - b.createdAt)
      },

      sessionsForAgent: (agentId) => {
        return Object.values(get().sessions)
          .filter((row) => row.agentSpawner === agentId)
          .sort((a, b) => a.createdAt - b.createdAt)
      },

      addPaneToGroup: (anchorId, paneId, direction) => {
        set((s) => {
          if (!s.sessions[anchorId] || !s.sessions[paneId] || anchorId === paneId) return s
          const realAnchor = resolveAnchor(anchorId, s.splitPanes)
          if (realAnchor === paneId) return s
          const existing = s.splitPanes[realAnchor] ?? []
          if (existing.includes(paneId)) return s
          const splitPanes = { ...s.splitPanes, [realAnchor]: [...existing, paneId] }
          const focusedPaneByAnchor = { ...s.focusedPaneByAnchor, [realAnchor]: paneId }
          const splitDirection = { ...s.splitDirection }
          if (direction) splitDirection[realAnchor] = direction
          else if (!(realAnchor in splitDirection)) splitDirection[realAnchor] = "row"
          // The new pane was just registered as the active session by
          // `registerSession`; restore the anchor as the active tab so the
          // tab strip keeps showing the group (not the hidden split member).
          const projectKey = s.sessions[realAnchor].projectId ?? ""
          const activeSessionIdByProject = {
            ...s.activeSessionIdByProject,
            [projectKey]: realAnchor,
          }
          return { splitPanes, focusedPaneByAnchor, splitDirection, activeSessionIdByProject }
        })
      },

      setFocusedPane: (anchorOrPaneId, paneId) => {
        set((s) => {
          const realAnchor = resolveAnchor(anchorOrPaneId, s.splitPanes)
          if (s.focusedPaneByAnchor[realAnchor] === paneId) return s
          return { focusedPaneByAnchor: { ...s.focusedPaneByAnchor, [realAnchor]: paneId } }
        })
      },

      groupAnchorOf: (sessionId) => resolveAnchor(sessionId, get().splitPanes),

      panesForGroup: (anchorOrPaneId) => {
        const sp = get().splitPanes
        const realAnchor = resolveAnchor(anchorOrPaneId, sp)
        return [realAnchor, ...(sp[realAnchor] ?? [])]
      },

      tabsForProject: (projectId) => {
        const target = projectId ?? ""
        const sp = get().splitPanes
        return Object.values(get().sessions)
          .filter((row) => (row.projectId ?? "") === target)
          .filter((row) => !isGroupMember(row.id, sp))
          .sort((a, b) => a.createdAt - b.createdAt)
      },

      reset: () => {
        if (pendingFlush) clearTimeout(pendingFlush)
        pendingFlush = null
        set({
          ...TERMINAL_LAYOUT_DEFAULTS,
          sessions: {},
          activeSessionIdByProject: {},
          splitPanes: {},
          focusedPaneByAnchor: {},
          splitDirection: {},
        })
      },
    }),
    {
      name: "cognia-terminal-layout",
      version: 1,
      migrate: (_oldState: unknown, _oldVersion: number) => ({
        ...TERMINAL_LAYOUT_DEFAULTS,
        sessions: {},
        activeSessionIdByProject: {},
      }),
      // Only persist the dock shell — session state is in-memory and
      // gone after window reload (replay is out of v1 scope).
      partialize: (state) => ({
        panelOpen: state.panelOpen,
        panelHeightPct: state.panelHeightPct,
      }),
    }
  )
)

export default useTerminalStore
