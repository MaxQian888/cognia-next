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
 *   * `panelHeightPct` and reload-safe layout metadata survive — the dock always starts
 *     closed (`panelOpen` is deliberately NOT persisted, so a dock left
 *     open by the user or an agent tool doesn't reappear on next launch).
 *   * Session rows do NOT persist. Instead, split groups, focus, active tabs,
 *     and custom titles are held as a pending snapshot until Rust reports which
 *     PTYs survived a webview reload; stale ids are then discarded.
 *
 * Shape mirrors `stores/inbox/inbox-layout-store.ts` deliberately —
 * see plan §Reuse map row #6. Debounced flush, DEFAULTS + BOUNDS
 * constants, and `partialize` callback are all carried across.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"

import type { SessionInfo } from "@/lib/terminal/types"
import type { TerminalHostState } from "@/lib/terminal/host-state"
import type { TabColorPreset, TabIconPreset } from "@/lib/terminal/tab-appearance"

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
  /** Stable durable-host identity used to reject cross-host layout collisions. */
  hostId: string | null
  /** Last host snapshot controller; live control events remain authoritative. */
  controllerId: string | null
  projectId: string | null
  extensionId: string | null
  /** Auto-derived title from shell + extension. Use `displayTitle()` to apply `customTitle` override. */
  title: string
  /** User-supplied tab title via Rename action. `null` falls back to `title`. */
  customTitle: string | null
  shell: string
  /**
   * Which transport owns this session. `origin` cannot answer this — it means
   * "local process vs. LAN/WS client", so an SSH tab and a local shell both
   * read `"local"` there. Optional: rows persisted before this field existed
   * simply lack it and are treated as `"localPty"`.
   */
  kind?: "localPty" | "ssh"
  /**
   * The saved profile this session was launched from — a `TerminalProfile` id
   * for a local shell, an `SshHostProfile` id for SSH. Reattaching after a
   * reload needs it to rebuild the right session class.
   */
  profileId?: string
  origin: "local" | "remote"
  status: TerminalTabStatus
  exitCode: number | null
  cwd: string | null
  createdAt: number
  /** Per-(chat, tab) trust grant cache key surface. UI only; the authoritative grant lives in `PluginConsentBroker`. */
  agentTrusted: boolean
  /** User-assigned color accent for the tab. `"none"` means default (no override). */
  tabColor: TabColorPreset
  /** User-assigned icon for the tab. `"none"` means no custom icon. */
  tabIcon: TabIconPreset
  /** Identity of the agent (chat session) that spawned this tab. `null` when user-spawned. Set by `lib/terminal/dock-tool-handler.ts` when the agent calls `terminal_dock_spawn`; reads filter the agent-only dock view. */
  agentSpawner: string | null
  /**
   * The assistant message the spawning tool call was streaming into, so
   * "Locate in conversation" can land on the exact turn rather than merely
   * opening the session at its end. ADR-0033 deferred this for want of a
   * scroll-to-message seam; that seam now exists (`chatViewportStore`).
   *
   * Inferred renderer-side at spawn time — the plugin-tool wire carries only a
   * session id — so it can be a message out in pathological cases (a replay, or
   * a second turn racing the first). That degrades to landing near the right
   * place, never to failing. Optional: rows persisted before this field existed
   * simply lack it.
   */
  agentSpawnerMessageId?: string | null
  /** OSC 633 prompt boundaries — newest last, capped to last 32. */
  promptBoundaries: TerminalPromptBoundary[]
  /** Recent commands ring, newest last, capped to {@link TERMINAL_HISTORY_RING_SIZE}. */
  lastCommands: TerminalCommandRecord[]
  /** Whether the history rail is shown for this tab. */
  historyOpen: boolean
}

/**
 * Which edge the dock occupies. `"bottom"` is the classic panel; `"right"`
 * turns it into a side column, which is what a wide display wants when the
 * terminal is a companion to the editor rather than the focus.
 */
export type TerminalPanelPosition = "bottom" | "right"

/** UI metadata that can be safely reapplied after Rust PTYs reattach. */
export interface TerminalReloadLayout {
  splitPanes: Record<string, string[]>
  focusedPaneByAnchor: Record<string, string>
  splitDirection: Record<string, "row" | "col">
  activeSessionIdByProject: Record<string, string | null>
  customTitles: Record<string, string>
  stableHostSessionIds: string[]
  controllerBySession: Record<string, string>
  /**
   * User tab order per project key. Rides the reload channel rather than
   * `partialize` because it is keyed by session ids that die with the PTY —
   * persisting it directly would accumulate garbage forever.
   */
  tabOrder: Record<string, string[]>
}

interface TerminalPersistedState {
  panelHeightPct: number
  panelWidthPct: number
  panelPosition: TerminalPanelPosition
  pendingReloadLayout: TerminalReloadLayout | null
}

export const TERMINAL_LAYOUT_DEFAULTS = {
  panelOpen: false,
  panelHeightPct: 32,
  panelPosition: "bottom" as TerminalPanelPosition,
  panelWidthPct: 36,
} as const

export const TERMINAL_LAYOUT_BOUNDS = {
  panelMinPct: 15,
  panelMaxPct: 85,
  /** A right-docked terminal wider than this leaves no usable editor column. */
  panelMinWidthPct: 15,
  panelMaxWidthPct: 70,
} as const

/** Sizes a drag settles onto when it lands within {@link TERMINAL_SNAP_TOLERANCE_PCT}. */
export const TERMINAL_LAYOUT_SNAP_PCTS: readonly number[] = [25, 33, 50, 66, 75]
export const TERMINAL_SNAP_TOLERANCE_PCT = 1.5

/**
 * Settle `value` onto a nearby snap point. Applied inside `setPanelSize` so a
 * pointer drag and an arrow-key nudge land on the same halves and thirds.
 */
export function snapPanelPct(
  value: number,
  snaps: readonly number[] = TERMINAL_LAYOUT_SNAP_PCTS,
  tolerance: number = TERMINAL_SNAP_TOLERANCE_PCT
): number {
  if (!Number.isFinite(value)) return value
  let best: number | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const snap of snaps) {
    const distance = Math.abs(snap - value)
    if (distance <= tolerance && distance < bestDistance) {
      best = snap
      bestDistance = distance
    }
  }
  return best ?? value
}

/**
 * Apply a user-defined tab order, appending anything the order doesn't mention
 * (a tab spawned after the last drag) in creation order.
 *
 * Exported so the dock's memo and `tabsForProject()` cannot disagree about the
 * order shown versus the order acted on.
 */
export function orderTabRows(
  rows: TerminalSessionRow[],
  order: string[] | undefined
): TerminalSessionRow[] {
  const byCreation = [...rows].sort((a, b) => a.createdAt - b.createdAt)
  if (!order || order.length === 0) return byCreation
  const rank = new Map(order.map((id, index) => [id, index]))
  return byCreation.sort((a, b) => {
    const ra = rank.get(a.id)
    const rb = rank.get(b.id)
    // Unranked rows keep their creation order and sit after every ranked one.
    if (ra === undefined && rb === undefined) return a.createdAt - b.createdAt
    if (ra === undefined) return 1
    if (rb === undefined) return -1
    return ra - rb
  })
}

export const TERMINAL_LAYOUT_PERSIST_DEBOUNCE_MS = 150

/** Maximum entries in the per-tab command-history ring. Mirrors VS Code's terminal history default. */
export const TERMINAL_HISTORY_RING_SIZE = 50
/** Maximum entries in the prompt-boundary ring (decoration consumer only needs the last few). */
export const TERMINAL_PROMPT_RING_SIZE = 32

let pendingFlush: ReturnType<typeof setTimeout> | null = null

/** Min/max for the axis the dock currently resizes along. */
function axisBounds(position: TerminalPanelPosition): { min: number; max: number } {
  return position === "right"
    ? {
        min: TERMINAL_LAYOUT_BOUNDS.panelMinWidthPct,
        max: TERMINAL_LAYOUT_BOUNDS.panelMaxWidthPct,
      }
    : { min: TERMINAL_LAYOUT_BOUNDS.panelMinPct, max: TERMINAL_LAYOUT_BOUNDS.panelMaxPct }
}

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
  /** Which edge the dock occupies. Persisted — a chosen layout should stick. */
  panelPosition: TerminalPanelPosition
  /** Dock width as a % of the shell row, used when `panelPosition === "right"`. */
  panelWidthPct: number

  // Transient durable-host health. The authoritative value comes from the
  // live connection and must not survive an app restart.
  hostState: TerminalHostState
  hostStateMessage: string | null

  // Maximize toggle (in-memory only). When `maximized` the dock snaps to
  // `panelMaxPct`; toggling off restores `preMaxHeightPct` (the height the
  // user last dragged to). A manual drag-resize exits maximize.
  maximized: boolean
  preMaxHeightPct: number
  /** Right-dock twin of `preMaxHeightPct`. */
  preMaxWidthPct: number

  // In-memory tab state
  sessions: Record<string, TerminalSessionRow>
  activeSessionIdByProject: Record<string, string | null>

  /**
   * User tab order per project key (`""` for "no project"). Absent or partial
   * entries fall back to creation order — see {@link orderTabRows}.
   */
  tabOrder: Record<string, string[]>

  /**
   * Sessions that received data while not the active tab for their project.
   * Cleared when the user switches to that tab. The tab component reads this
   * to render a pulsing activity indicator.
   */
  tabActivity: Record<string, boolean>

  /**
   * Sessions whose output the renderer is currently holding back (xterm
   * backpressure). Surfaced on the tab and the session chip so a throttled
   * background tab is legible without switching to it.
   */
  outputThrottled: Record<string, boolean>

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

  /**
   * Snapshot hydrated from storage but not yet applied. Keeping it separate
   * prevents incremental PTY registration from overwriting the complete saved
   * layout before reattachment finishes.
   */
  pendingReloadLayout: TerminalReloadLayout | null

  // Mutations
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
  /** Bottom-dock alias for {@link TerminalStoreState.setPanelSize}. */
  setPanelHeight: (pct: number) => void
  /**
   * Resize along the dock's own axis — height when docked bottom, width when
   * docked right. Clamps to the axis bounds, applies {@link snapPanelPct}, and
   * exits `maximized` (a manual resize means the user wants that size).
   */
  setPanelSize: (pct: number) => void
  /** Current size along the dock's own axis. */
  panelSizePct: () => number
  /** Move the dock to another edge. */
  setPanelPosition: (position: TerminalPanelPosition) => void
  setHostState: (state: TerminalHostState, message?: string | null) => void
  /** Snap to full size (or restore the pre-maximize size). No-op semantics live in the impl. */
  toggleMaximized: () => void
  /** Record a user-defined tab order for a project. Foreign/unknown ids are dropped. */
  setTabOrder: (projectId: string | null, orderedIds: string[]) => void
  /** Flag/clear renderer backpressure for a session. */
  setOutputThrottled: (sessionId: string, throttled: boolean) => void
  /** Mark a session as having new output while in background. */
  markTabActivity: (sessionId: string) => void
  /** Clear the activity badge for a session (called when tab becomes active). */
  clearTabActivity: (sessionId: string) => void

  registerSession: (
    info: SessionInfo,
    opts?: { title?: string; agentSpawner?: string; agentSpawnerMessageId?: string }
  ) => void
  removeSession: (id: string) => void
  setSessionStatus: (id: string, status: TerminalTabStatus) => void
  setSessionExit: (id: string, exitCode: number | null) => void
  setSessionCwd: (id: string, cwd: string) => void
  setSessionTitle: (id: string, title: string) => void

  /** Set or clear a user-supplied tab title. `null` reverts to the auto title. */
  renameSession: (id: string, customTitle: string | null) => void
  setAgentTrusted: (id: string, trusted: boolean) => void
  setAgentSpawner: (id: string, agentSpawner: string | null) => void
  /** Set the tab color/icon appearance. Partial — omit a field to leave it unchanged. */
  setTabAppearance: (
    id: string,
    appearance: { color?: TabColorPreset; icon?: TabIconPreset }
  ) => void
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

  /** Apply the pending reload snapshot to currently registered PTYs and discard stale ids. */
  restorePersistedLayout: () => void

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
  // The host reports an SSH session's shell as `ssh <user>@<host>`, so the
  // generic first-word collapse would label every remote tab just "ssh".
  // Callers that know the profile name (the settings editor, the dock picker)
  // pass an explicit title and never reach this.
  if (info.kind === "ssh") return sshTarget(info.shell) ?? shortShell(info.shell)
  return shortShell(info.shell)
}

/** `ssh deploy@prod.example.com` → `deploy@prod.example.com`. */
function sshTarget(shell: string): string | null {
  const match = /^ssh\s+(\S+)$/.exec(shell.trim())
  return match?.[1] ?? null
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

function captureReloadLayout(
  state: Pick<
    TerminalStoreState,
    | "sessions"
    | "splitPanes"
    | "focusedPaneByAnchor"
    | "splitDirection"
    | "activeSessionIdByProject"
    | "tabOrder"
  >
): TerminalReloadLayout {
  const customTitles: Record<string, string> = {}
  const controllerBySession: Record<string, string> = {}
  for (const row of Object.values(state.sessions)) {
    if (row.customTitle) customTitles[row.id] = row.customTitle
    if (row.controllerId) controllerBySession[row.id] = row.controllerId
  }
  return {
    splitPanes: Object.fromEntries(
      Object.entries(state.splitPanes).map(([anchor, members]) => [anchor, [...members]])
    ),
    focusedPaneByAnchor: { ...state.focusedPaneByAnchor },
    splitDirection: { ...state.splitDirection },
    activeSessionIdByProject: { ...state.activeSessionIdByProject },
    customTitles,
    stableHostSessionIds: Object.values(state.sessions)
      .filter((row) => !!row.hostId)
      .map((row) => row.id),
    controllerBySession,
    tabOrder: Object.fromEntries(
      Object.entries(state.tabOrder).map(([projectKey, ids]) => [projectKey, [...ids]])
    ),
  }
}

/** Shared shape validator for `Record<string, string[]>` off the storage boundary. */
function normalizeStringArrayMap(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const result: Record<string, string[]> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry)) {
      result[key] = entry.filter((item): item is string => typeof item === "string")
    }
  }
  return result
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry
  }
  return result
}

/** Treat localStorage as an untrusted boundary: malformed entries degrade to an empty snapshot. */
function normalizeReloadLayout(value: unknown): TerminalReloadLayout | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const splitPanes = normalizeStringArrayMap(raw.splitPanes)

  const rawDirections = normalizeStringMap(raw.splitDirection)
  const splitDirection: Record<string, "row" | "col"> = {}
  for (const [anchor, direction] of Object.entries(rawDirections)) {
    if (direction === "row" || direction === "col") splitDirection[anchor] = direction
  }

  const rawActive = raw.activeSessionIdByProject
  const activeSessionIdByProject: Record<string, string | null> = {}
  if (rawActive && typeof rawActive === "object" && !Array.isArray(rawActive)) {
    for (const [projectId, sessionId] of Object.entries(rawActive)) {
      if (typeof sessionId === "string" || sessionId === null) {
        activeSessionIdByProject[projectId] = sessionId
      }
    }
  }

  return {
    splitPanes,
    focusedPaneByAnchor: normalizeStringMap(raw.focusedPaneByAnchor),
    splitDirection,
    activeSessionIdByProject,
    customTitles: normalizeStringMap(raw.customTitles),
    stableHostSessionIds: Array.isArray(raw.stableHostSessionIds)
      ? raw.stableHostSessionIds.filter((id): id is string => typeof id === "string")
      : [],
    controllerBySession: normalizeStringMap(raw.controllerBySession),
    tabOrder: normalizeStringArrayMap(raw.tabOrder),
  }
}

export const useTerminalStore = create<TerminalStoreState>()(
  persist<TerminalStoreState, [], [], TerminalPersistedState>(
    (set, get) => ({
      ...TERMINAL_LAYOUT_DEFAULTS,
      hostState: "online",
      hostStateMessage: null,
      maximized: false,
      preMaxHeightPct: TERMINAL_LAYOUT_DEFAULTS.panelHeightPct,
      preMaxWidthPct: TERMINAL_LAYOUT_DEFAULTS.panelWidthPct,
      sessions: {},
      activeSessionIdByProject: {},
      splitPanes: {},
      focusedPaneByAnchor: {},
      splitDirection: {},
      tabOrder: {},
      outputThrottled: {},
      tabActivity: {},
      pendingReloadLayout: null,

      setPanelOpen: (open) => set({ panelOpen: open }),

      togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),

      setHostState: (hostState, hostStateMessage = null) => set({ hostState, hostStateMessage }),

      setPanelPosition: (panelPosition) => {
        // Leaving `maximized` set across a move would apply the *other* axis's
        // max, so the dock would jump to a size the user never chose.
        set((s) => (s.panelPosition === panelPosition ? s : { panelPosition, maximized: false }))
      },

      panelSizePct: () => {
        const s = get()
        return s.panelPosition === "right" ? s.panelWidthPct : s.panelHeightPct
      },

      setPanelSize: (pct) => {
        const bounds = axisBounds(get().panelPosition)
        const clamped = clamp(snapPanelPct(pct), bounds.min, bounds.max)
        const key = get().panelPosition === "right" ? "panelWidthPct" : "panelHeightPct"
        // A manual resize (drag / arrow keys) exits the maximized state so the
        // toggle button reads "maximize" again and won't clobber the new size.
        set({ [key]: clamped, maximized: false } as Partial<TerminalStoreState>)
        if (pendingFlush) clearTimeout(pendingFlush)
        pendingFlush = setTimeout(() => {
          pendingFlush = null
          // Touch the value again so `persist` sees a write after the drag
          // settles rather than once per pointermove.
          set({ [key]: get()[key] } as Partial<TerminalStoreState>)
        }, TERMINAL_LAYOUT_PERSIST_DEBOUNCE_MS)
      },

      setPanelHeight: (pct) => {
        // Kept as the bottom-dock alias so existing callers (and the menu
        // actions) keep working; the axis routing lives in `setPanelSize`.
        if (get().panelPosition === "bottom") {
          get().setPanelSize(pct)
          return
        }
        const { panelMinPct, panelMaxPct } = TERMINAL_LAYOUT_BOUNDS
        set({ panelHeightPct: clamp(snapPanelPct(pct), panelMinPct, panelMaxPct) })
      },

      toggleMaximized: () => {
        const s = get()
        const bounds = axisBounds(s.panelPosition)
        const right = s.panelPosition === "right"
        if (s.maximized) {
          // Restore the size the user last dragged to (clamped defensively).
          const previous = right ? s.preMaxWidthPct : s.preMaxHeightPct
          const restore = clamp(previous, bounds.min, bounds.max)
          set(
            (right
              ? { panelWidthPct: restore, maximized: false }
              : { panelHeightPct: restore, maximized: false }) as Partial<TerminalStoreState>
          )
        } else {
          set(
            (right
              ? { preMaxWidthPct: s.panelWidthPct, panelWidthPct: bounds.max, maximized: true }
              : {
                  preMaxHeightPct: s.panelHeightPct,
                  panelHeightPct: bounds.max,
                  maximized: true,
                }) as Partial<TerminalStoreState>
          )
        }
      },

      setTabOrder: (projectId, orderedIds) => {
        set((s) => {
          const key = projectId ?? ""
          // The order arrives from a drag interaction — treat it as untrusted:
          // keep only ids that exist and belong to this project, de-duplicated.
          const seen = new Set<string>()
          const filtered: string[] = []
          for (const id of orderedIds) {
            const row = s.sessions[id]
            if (!row || (row.projectId ?? "") !== key || seen.has(id)) continue
            seen.add(id)
            filtered.push(id)
          }
          // Anything in this project the drag didn't mention keeps its place at
          // the end rather than silently vanishing from the order.
          for (const row of Object.values(s.sessions)) {
            if ((row.projectId ?? "") === key && !seen.has(row.id)) filtered.push(row.id)
          }
          return { tabOrder: { ...s.tabOrder, [key]: filtered } }
        })
      },

      setOutputThrottled: (sessionId, throttled) => {
        set((s) => {
          if ((s.outputThrottled[sessionId] ?? false) === throttled) return s
          const next = { ...s.outputThrottled }
          if (throttled) next[sessionId] = true
          else delete next[sessionId]
          return { outputThrottled: next }
        })
      },

      markTabActivity: (sessionId) => {
        set((s) => {
          if (s.tabActivity[sessionId]) return s
          // Only mark if the session is NOT the currently-active tab for its
          // project — data on the visible tab is already seen by the user.
          const row = s.sessions[sessionId]
          if (!row) return s
          const active = s.activeSessionIdByProject[row.projectId ?? ""]
          if (active === sessionId) return s
          return { tabActivity: { ...s.tabActivity, [sessionId]: true } }
        })
      },

      clearTabActivity: (sessionId) => {
        set((s) => {
          if (!s.tabActivity[sessionId]) return s
          const next = { ...s.tabActivity }
          delete next[sessionId]
          return { tabActivity: next }
        })
      },

      registerSession: (info, opts = {}) => {
        const row: TerminalSessionRow = {
          id: info.id,
          hostId: info.hostId ?? null,
          controllerId: info.currentController ?? null,
          projectId: info.projectId,
          extensionId: info.extensionId,
          title: opts.title ?? makeTitle(info),
          customTitle: null,
          shell: info.shell,
          kind: info.kind,
          profileId: info.profileId,
          origin: info.origin,
          status: "idle",
          exitCode: null,
          cwd: null,
          createdAt: Date.now(),
          agentTrusted: false,
          tabColor: "none",
          tabIcon: "none",
          agentSpawner: opts.agentSpawner ?? null,
          agentSpawnerMessageId: opts.agentSpawnerMessageId ?? null,
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
                const remaining = orderTabRows(
                  Object.values(next)
                    .filter((r) => (r.projectId ?? "") === projectId)
                    .filter((r) => !isGroupMember(r.id, splitPanes)),
                  s.tabOrder[projectId]
                )
                nextActive[projectId] = remaining[remaining.length - 1]?.id ?? null
              }
            } else if (anchorRemap && activeId === anchorRemap.from) {
              nextActive[projectId] = anchorRemap.to
            }
          }
          // Drop the dead id from the order + throttle maps so neither grows
          // without bound across a long session.
          const tabOrder: Record<string, string[]> = {}
          for (const [projectKey, ids] of Object.entries(s.tabOrder)) {
            tabOrder[projectKey] = ids.filter((entry) => entry !== id)
          }
          const outputThrottled = { ...s.outputThrottled }
          delete outputThrottled[id]

          return {
            sessions: next,
            activeSessionIdByProject: nextActive,
            splitPanes,
            focusedPaneByAnchor,
            splitDirection,
            tabOrder,
            outputThrottled,
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

      setTabAppearance: (id, appearance) => {
        set((s) => {
          const row = s.sessions[id]
          if (!row) return s
          const updated = { ...row }
          if (appearance.color !== undefined) updated.tabColor = appearance.color
          if (appearance.icon !== undefined) updated.tabIcon = appearance.icon
          return { sessions: { ...s.sessions, [id]: updated } }
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
        set((s) => {
          const tabActivity = sessionId ? { ...s.tabActivity } : s.tabActivity
          if (sessionId && tabActivity[sessionId]) delete tabActivity[sessionId]
          return {
            activeSessionIdByProject: {
              ...s.activeSessionIdByProject,
              [projectId ?? ""]: sessionId,
            },
            tabActivity,
          }
        })
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
        const s = get()
        return orderTabRows(
          Object.values(s.sessions)
            .filter((row) => (row.projectId ?? "") === target)
            .filter((row) => !isGroupMember(row.id, s.splitPanes)),
          s.tabOrder[target]
        )
      },

      restorePersistedLayout: () => {
        set((s) => {
          const saved = normalizeReloadLayout(s.pendingReloadLayout)
          if (!saved) return { pendingReloadLayout: null }

          const splitPanes: Record<string, string[]> = {}
          const focusedPaneByAnchor: Record<string, string> = {}
          const splitDirection: Record<string, "row" | "col"> = {}
          const claimed = new Set<string>()

          for (const [anchor, candidates] of Object.entries(saved.splitPanes)) {
            const anchorRow = s.sessions[anchor]
            if (!anchorRow || claimed.has(anchor)) continue
            const members: string[] = []
            for (const paneId of candidates) {
              const pane = s.sessions[paneId]
              if (
                paneId !== anchor &&
                pane &&
                pane.projectId === anchorRow.projectId &&
                !claimed.has(paneId) &&
                !members.includes(paneId)
              ) {
                members.push(paneId)
              }
            }
            if (members.length === 0) continue

            claimed.add(anchor)
            for (const paneId of members) claimed.add(paneId)
            splitPanes[anchor] = members
            splitDirection[anchor] = saved.splitDirection[anchor] ?? "row"
            const savedFocus = saved.focusedPaneByAnchor[anchor]
            focusedPaneByAnchor[anchor] =
              savedFocus === anchor || members.includes(savedFocus) ? savedFocus : anchor
          }

          const sessions = { ...s.sessions }
          for (const [id, row] of Object.entries(sessions)) {
            const title = saved.customTitles[id]?.trim()
            const savedController = saved.controllerBySession[id]
            sessions[id] = {
              ...row,
              customTitle: title ? title : null,
              controllerId:
                row.controllerId ??
                (row.hostId && saved.stableHostSessionIds.includes(id)
                  ? (savedController ?? null)
                  : null),
            }
          }

          const activeSessionIdByProject: Record<string, string | null> = {}
          const projectIds = new Set(Object.values(sessions).map((row) => row.projectId ?? ""))
          for (const projectId of projectIds) {
            const savedActive = saved.activeSessionIdByProject[projectId]
            const savedRow = savedActive ? sessions[savedActive] : undefined
            if (
              savedActive &&
              savedRow &&
              (savedRow.projectId ?? "") === projectId &&
              !isGroupMember(savedActive, splitPanes)
            ) {
              activeSessionIdByProject[projectId] = savedActive
              continue
            }

            const current = s.activeSessionIdByProject[projectId]
            const currentAnchor = current ? resolveAnchor(current, splitPanes) : null
            const currentRow = currentAnchor ? sessions[currentAnchor] : undefined
            if (currentAnchor && currentRow && (currentRow.projectId ?? "") === projectId) {
              activeSessionIdByProject[projectId] = currentAnchor
              continue
            }

            const fallback = Object.values(sessions)
              .filter((row) => (row.projectId ?? "") === projectId)
              .filter((row) => !isGroupMember(row.id, splitPanes))
              .sort((a, b) => a.createdAt - b.createdAt)
              .at(-1)
            activeSessionIdByProject[projectId] = fallback?.id ?? null
          }

          // Reapply the saved tab order, keeping only ids that re-registered
          // under the same project. A stale id would otherwise pin a phantom
          // slot at the front of the strip forever.
          const tabOrder: Record<string, string[]> = {}
          for (const [projectKey, ids] of Object.entries(saved.tabOrder)) {
            const kept = ids.filter((id) => {
              const row = sessions[id]
              return !!row && (row.projectId ?? "") === projectKey
            })
            if (kept.length > 0) tabOrder[projectKey] = kept
          }

          return {
            sessions,
            splitPanes,
            focusedPaneByAnchor,
            splitDirection,
            activeSessionIdByProject,
            tabOrder,
            pendingReloadLayout: null,
          }
        })
      },

      reset: () => {
        if (pendingFlush) clearTimeout(pendingFlush)
        pendingFlush = null
        set({
          ...TERMINAL_LAYOUT_DEFAULTS,
          hostState: "online",
          hostStateMessage: null,
          maximized: false,
          preMaxHeightPct: TERMINAL_LAYOUT_DEFAULTS.panelHeightPct,
          preMaxWidthPct: TERMINAL_LAYOUT_DEFAULTS.panelWidthPct,
          sessions: {},
          activeSessionIdByProject: {},
          splitPanes: {},
          focusedPaneByAnchor: {},
          splitDirection: {},
          tabOrder: {},
          outputThrottled: {},
          tabActivity: {},
          pendingReloadLayout: null,
        })
      },
    }),
    {
      name: "cognia-terminal-layout",
      // v5 adds the dock edge + its width. v4 recorded stable
      // host-session/controller layout metadata. Live host snapshots remain
      // authoritative; this only bridges the reload window.
      version: 5,
      migrate: (oldState: unknown, oldVersion: number) => {
        const prev = oldState as
          | {
              panelHeightPct?: unknown
              panelWidthPct?: unknown
              panelPosition?: unknown
              pendingReloadLayout?: unknown
            }
          | null
          | undefined
        return {
          panelHeightPct:
            typeof prev?.panelHeightPct === "number"
              ? clamp(
                  prev.panelHeightPct,
                  TERMINAL_LAYOUT_BOUNDS.panelMinPct,
                  TERMINAL_LAYOUT_BOUNDS.panelMaxPct
                )
              : TERMINAL_LAYOUT_DEFAULTS.panelHeightPct,
          // Absent on v4 and below; anything else on disk is untrusted.
          panelWidthPct:
            typeof prev?.panelWidthPct === "number"
              ? clamp(
                  prev.panelWidthPct,
                  TERMINAL_LAYOUT_BOUNDS.panelMinWidthPct,
                  TERMINAL_LAYOUT_BOUNDS.panelMaxWidthPct
                )
              : TERMINAL_LAYOUT_DEFAULTS.panelWidthPct,
          panelPosition:
            prev?.panelPosition === "right" || prev?.panelPosition === "bottom"
              ? prev.panelPosition
              : TERMINAL_LAYOUT_DEFAULTS.panelPosition,
          pendingReloadLayout:
            oldVersion >= 3 ? normalizeReloadLayout(prev?.pendingReloadLayout) : null,
        }
      },
      // `panelOpen` intentionally resets to closed. While reattaching, retain
      // the complete pending snapshot; otherwise capture the current live layout.
      // `tabOrder` rides `pendingReloadLayout`, not this — it is keyed by
      // session ids that die with the PTY.
      partialize: (state) => ({
        panelHeightPct: state.panelHeightPct,
        panelWidthPct: state.panelWidthPct,
        panelPosition: state.panelPosition,
        pendingReloadLayout: state.pendingReloadLayout ?? captureReloadLayout(state),
      }),
    }
  )
)

export default useTerminalStore
