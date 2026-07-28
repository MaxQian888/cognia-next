"use client"

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import { getPluginEventHooks } from "@/lib/plugin"
import { nextNavEpoch } from "@/lib/ui/nav-epoch"

/** Conversation-sidebar (ChannelList) width bounds, in px. Shared by the
 *  edge-resize handle and the "reset width" settings action. */
export const SIDEBAR_WIDTH_DEFAULT = 256
export const SIDEBAR_WIDTH_MIN = 220
export const SIDEBAR_WIDTH_MAX = 420

/** Clamp a candidate ChannelList width into the allowed range. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH_DEFAULT
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)))
}

/** Which slice of conversations the ChannelList shows. */
export type ChannelListView = "active" | "archived"

/**
 * Which "guild" the user is currently looking at — either the synthetic
 * direct-messages bucket, a specific team, or the Canvas workspace.
 */
export type SelectedGuild =
  | { kind: "dm" }
  | { kind: "team"; teamId: string }
  | { kind: "canvas" }
  // A plugin-contributed view container (B1) is active: the middle column
  // renders that container's panel instead of the chat session list.
  | { kind: "plugin-view"; containerId: string }

/**
 * Live status of a team member during an in-flight team turn. Drives the dot
 * color in the member list and the skeleton in the message stream.
 */
export type MemberStatus = "idle" | "thinking" | "errored"

/**
 * **Legacy.** The individually-toggleable title/status-bar segments, from
 * before either bar was orderable. Both bars now persist a full
 * `{ order, hidden }` layout on `AppSettings.titleBarLayout` /
 * `.statusBarLayout` (see `@/types/shell/bars`), edited from the same place as
 * the nav rail (`/settings?section=sidebar`).
 *
 * This map is kept for exactly one reason: it is the only record of what an
 * existing install had turned off, and it lives in localStorage rather than in
 * settings, so it cannot be folded in by a settings migration.
 * `components/shell/use-bar-layout.ts` reads it once — when settings hold no
 * layout for a bar yet — via `migrateLegacyBarItems`, and the first write
 * through that hook supersedes it permanently. Nothing else may read it, and
 * there is deliberately no setter: the customizer writes settings, not this.
 *
 * The ids are identical to the corresponding ids in the new catalogs, which is
 * what makes that migration an identity mapping.
 */
export type BarItemId =
  | "connectivity"
  | "sync"
  | "perf"
  | "accountStatus"
  | "usage"
  | "workspace"
  | "quickActions"
  | "accountTop"

/**
 * Legacy default visibility per segment — the state a pre-customization
 * install carries when it has never touched a toggle. Mirrors the
 * `defaultHidden` flags in `@/types/shell/bars`, so migrating a fresh install
 * is a no-op that lands exactly on the shipped bar layouts.
 *
 * `perf` is **off** because mounting its component begins native CPU/mem
 * sampling — it is strictly opt-in. `accountTop` is off because
 * `accountStatus` is on: the account button used to render in the title bar
 * AND the status bar at once, the same control twice on one screen.
 * `quickActions` (pet / OCR / clipboard) is off because none of the three is
 * touched per conversation.
 */
export const DEFAULT_BAR_ITEMS: Record<BarItemId, boolean> = {
  connectivity: true,
  sync: true,
  perf: false,
  accountStatus: true,
  usage: true,
  workspace: true,
  quickActions: false,
  accountTop: false,
}

interface UIState {
  selectedGuild: SelectedGuild
  setSelectedGuild: (g: SelectedGuild) => void
  /**
   * Navigation epoch stamped each time the guild is set. Compared against the
   * chat store's `activeSessionEpoch` so the desktop workspace knows whether
   * the guild or the active session was chosen more recently (and thus which
   * should win when they disagree). Transient — never persisted.
   */
  selectedGuildEpoch: number

  /**
   * Member-status map keyed by `${teamSessionId}::${characterId}`. Transient
   * (not persisted) — resets on reload, since any in-flight team turn is gone
   * by then anyway.
   */
  memberStatus: Record<string, MemberStatus>
  setMemberStatus: (teamSessionId: string, characterId: string, status: MemberStatus) => void
  clearMemberStatusFor: (teamSessionId: string) => void

  /**
   * User toggle for the team member list. Defaults visible; persisted so the
   * choice sticks across reloads.
   */
  showMemberList: boolean
  setShowMemberList: (visible: boolean) => void

  /**
   * VSCode-style sidebar collapse. Drives the ChannelList visibility and the
   * status-bar toggle. Persisted across reloads.
   */
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void

  /**
   * Draggable width (px) of the conversation sidebar (ChannelList). Clamped to
   * [{@link SIDEBAR_WIDTH_MIN}, {@link SIDEBAR_WIDTH_MAX}]. Persisted so the
   * choice sticks across reloads.
   */
  sidebarWidth: number
  setSidebarWidth: (width: number) => void

  /**
   * Active ⇄ Archived slice shown in the ChannelList. Persisted so the choice
   * survives reloads (previously an ephemeral component `useState`).
   */
  channelListView: ChannelListView
  setChannelListView: (view: ChannelListView) => void

  /**
   * Ids of conversation folders the user has collapsed in the ChannelList.
   * Stored as an array (Sets don't survive JSON) and persisted so folder
   * collapse state sticks across reloads (previously ephemeral).
   */
  collapsedFolderIds: string[]
  toggleCollapsedFolder: (id: string) => void
  setCollapsedFolders: (ids: string[]) => void

  /**
   * Explicit collapse choices for the ChannelList's grouping sections
   * (`workspace:<id>` / `agent:<id>`, keyed by `conversationSectionKey`).
   *
   * A map rather than the id array folders use, because a group's default is
   * not uniform: every workspace except the active one starts collapsed, so
   * "the user expanded this one" has to be representable. Absent key = default.
   */
  groupCollapseOverrides: Record<string, boolean>
  setGroupCollapsed: (key: string, collapsed: boolean) => void

  /**
   * Desktop left guild rail (feature switcher) collapse. Persisted across
   * reloads. Driven by the View menu and exposed for plugins that need to
   * reserve the leftmost column on demand.
   */
  guildRailCollapsed: boolean
  toggleGuildRail: () => void
  setGuildRailCollapsed: (collapsed: boolean) => void

  /**
   * Desktop bottom status bar collapse. Persisted across reloads. The
   * status bar carries permission-mode, zoom and locale controls — hiding it
   * recovers ~28px of vertical space without losing them (theme/zoom/locale
   * are also reachable from the title-bar View menu).
   */
  statusBarCollapsed: boolean
  toggleStatusBar: () => void
  setStatusBarCollapsed: (collapsed: boolean) => void

  /**
   * **Legacy, read-only.** Pre-customization per-segment visibility for the
   * title/status bars — see {@link DEFAULT_BAR_ITEMS}. Its sole consumer is
   * `components/shell/use-bar-layout.ts`, which folds it into the
   * settings-backed `BarLayout` the first time a bar resolves without one.
   * There is deliberately no setter: the customizer writes settings, not this.
   */
  barItems: Record<BarItemId, boolean>

  /**
   * True for exactly one boot: the one where the v3 migration reset this
   * install's chrome layout. Transient by design — it is not in `partialize`,
   * so the next launch reads a v3 snapshot and the flag is false again. That
   * makes "notify once" a property of the data rather than a second persisted
   * "seen" key someone has to remember to write.
   *
   * Consumed by `ShellLayoutNotice`, which explains where the moved controls
   * went. Fresh installs never see it (they had no v2 snapshot to migrate).
   */
  chromeLayoutMigrated: boolean
  acknowledgeChromeLayout: () => void

  /**
   * Transient (never persisted) open state for the in-app Find bar. Set by the
   * title bar's Edit → Find / Ctrl+F handler; read by the shell-mounted
   * `FindBar`. Reset on reload — a stale find query has no meaning after that.
   */
  findOpen: boolean
  openFind: () => void
  closeFind: () => void

  /**
   * Per-team-session collapsed state for the Shared notes (scratchpad) panel
   * in the right rail. Default expanded; persisted so the choice sticks.
   */
  scratchpadCollapsed: Record<string, boolean>
  setScratchpadCollapsed: (sessionId: string, collapsed: boolean) => void

  /**
   * One-shot stop requests from the user against a single member. The
   * orchestrator clears the entry once it has acted on it. Transient.
   */
  stopRequestedFor: Record<string, string[]>
  requestStopMember: (teamSessionId: string, characterId: string) => void
  clearStopRequest: (teamSessionId: string, characterId: string) => void
  clearStopRequestsFor: (teamSessionId: string) => void
  isStopRequested: (teamSessionId: string, characterId: string) => boolean

  /**
   * Request the shell to open the settings dialog at a given tab. Bumped on
   * each request so that repeated requests still trigger the shell's effect.
   * Consumers (the desktop shell) read it via `pendingSettingsRequest` and
   * call `clearPendingSettings()` after handling.
   */
  pendingSettingsRequest: { tab?: string; nonce: number } | null
  requestOpenSettings: (tab?: string) => void
  clearPendingSettings: () => void

  /**
   * One-shot "open the create-X dialog" signal. Same nonce-bump pattern as
   * `pendingSettingsRequest` — consumers (workflow library, agent-teams
   * page, settings characters tab) observe `kind` matching their domain and
   * call `clearPendingCreate()` after opening their dialog.
   *
   * Drives the File menu's "New Workflow / Agent Team / Character" items.
   * Without this, those items only navigate — the destination page can't
   * tell the navigation was initiated to create something.
   */
  pendingCreateRequest: {
    kind: "workflow" | "agentTeam" | "character"
    nonce: number
  } | null
  requestCreate: (kind: "workflow" | "agentTeam" | "character") => void
  clearPendingCreate: () => void
}

function memberKey(teamSessionId: string, characterId: string) {
  return `${teamSessionId}::${characterId}`
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      selectedGuild: { kind: "dm" },
      selectedGuildEpoch: 0,
      setSelectedGuild: (g) => set({ selectedGuild: g, selectedGuildEpoch: nextNavEpoch() }),

      memberStatus: {},
      setMemberStatus: (teamSessionId, characterId, status) =>
        set((s) => ({
          memberStatus: {
            ...s.memberStatus,
            [memberKey(teamSessionId, characterId)]: status,
          },
        })),
      clearMemberStatusFor: (teamSessionId) =>
        set((s) => {
          const prefix = `${teamSessionId}::`
          const next: Record<string, MemberStatus> = {}
          for (const [k, v] of Object.entries(s.memberStatus)) {
            if (!k.startsWith(prefix)) next[k] = v
          }
          return { memberStatus: next }
        }),

      showMemberList: true,
      setShowMemberList: (visible) => set({ showMemberList: visible }),

      sidebarCollapsed: false,
      toggleSidebar: () =>
        set((s) => {
          const next = !s.sidebarCollapsed
          // Plugin host: dispatch sidebar visibility change. Visible === !collapsed.
          getPluginEventHooks().dispatchSidebarToggle(!next)
          return { sidebarCollapsed: next }
        }),
      setSidebarCollapsed: (collapsed) => {
        set({ sidebarCollapsed: collapsed })
        getPluginEventHooks().dispatchSidebarToggle(!collapsed)
      },

      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
      setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),

      channelListView: "active",
      setChannelListView: (view) => set({ channelListView: view }),

      collapsedFolderIds: [],
      toggleCollapsedFolder: (id) =>
        set((s) => ({
          collapsedFolderIds: s.collapsedFolderIds.includes(id)
            ? s.collapsedFolderIds.filter((f) => f !== id)
            : [...s.collapsedFolderIds, id],
        })),
      setCollapsedFolders: (ids) => set({ collapsedFolderIds: ids }),

      groupCollapseOverrides: {},
      setGroupCollapsed: (key, collapsed) =>
        set((s) =>
          s.groupCollapseOverrides[key] === collapsed
            ? s
            : { groupCollapseOverrides: { ...s.groupCollapseOverrides, [key]: collapsed } }
        ),

      guildRailCollapsed: false,
      toggleGuildRail: () => set((s) => ({ guildRailCollapsed: !s.guildRailCollapsed })),
      setGuildRailCollapsed: (collapsed) => set({ guildRailCollapsed: collapsed }),

      statusBarCollapsed: false,
      toggleStatusBar: () => set((s) => ({ statusBarCollapsed: !s.statusBarCollapsed })),
      setStatusBarCollapsed: (collapsed) => set({ statusBarCollapsed: collapsed }),

      chromeLayoutMigrated: false,
      acknowledgeChromeLayout: () => set({ chromeLayoutMigrated: false }),

      barItems: { ...DEFAULT_BAR_ITEMS },

      findOpen: false,
      openFind: () => set({ findOpen: true }),
      closeFind: () => set({ findOpen: false }),

      scratchpadCollapsed: {},
      setScratchpadCollapsed: (sessionId, collapsed) =>
        set((s) => ({
          scratchpadCollapsed: {
            ...s.scratchpadCollapsed,
            [sessionId]: collapsed,
          },
        })),

      stopRequestedFor: {},
      requestStopMember: (teamSessionId, characterId) =>
        set((s) => {
          const cur = s.stopRequestedFor[teamSessionId] ?? []
          if (cur.includes(characterId)) return s
          return {
            stopRequestedFor: {
              ...s.stopRequestedFor,
              [teamSessionId]: [...cur, characterId],
            },
          }
        }),
      clearStopRequest: (teamSessionId, characterId) =>
        set((s) => {
          const cur = s.stopRequestedFor[teamSessionId]
          if (!cur || !cur.includes(characterId)) return s
          const next = cur.filter((id) => id !== characterId)
          const map = { ...s.stopRequestedFor }
          if (next.length === 0) delete map[teamSessionId]
          else map[teamSessionId] = next
          return { stopRequestedFor: map }
        }),
      clearStopRequestsFor: (teamSessionId) =>
        set((s) => {
          if (!(teamSessionId in s.stopRequestedFor)) return s
          const map = { ...s.stopRequestedFor }
          delete map[teamSessionId]
          return { stopRequestedFor: map }
        }),
      isStopRequested: (teamSessionId, characterId) => {
        const cur = get().stopRequestedFor[teamSessionId]
        return Boolean(cur?.includes(characterId))
      },

      pendingSettingsRequest: null,
      requestOpenSettings: (tab) =>
        set((s) => ({
          pendingSettingsRequest: {
            tab,
            nonce: (s.pendingSettingsRequest?.nonce ?? 0) + 1,
          },
        })),
      clearPendingSettings: () => set({ pendingSettingsRequest: null }),

      pendingCreateRequest: null,
      requestCreate: (kind) =>
        set((s) => ({
          pendingCreateRequest: {
            kind,
            nonce: (s.pendingCreateRequest?.nonce ?? 0) + 1,
          },
        })),
      clearPendingCreate: () => set({ pendingCreateRequest: null }),
    }),
    {
      name: "cognia-ui",
      storage: persistLocalStorage(),
      // Bumped 0 → 1 when the conversation-sidebar layout fields were added,
      // 1 → 2 when per-segment `barItems` visibility was added, and 2 → 3 for
      // the shell de-crowding pass.
      //
      // 3 is the first migration that actually drops data, and it has to. Every
      // one of these keys is written unconditionally by `partialize`, and
      // `merge` lets the persisted value win — so a user who has ever opened the
      // app carries a snapshot that pins the OLD defaults forever. Changing
      // `DEFAULT_BAR_ITEMS` alone would have shipped a no-op to every existing
      // install (the author's included). Dropping the three keys hands them back
      // to the new defaults; everything the user actually chose (window layout,
      // sidebar width, folder collapse state, selected guild) is preserved.
      version: 3,
      migrate: (persisted, from) => {
        const p = (persisted ?? {}) as Partial<UIState>
        if (from >= 3) return p as UIState
        const {
          barItems: _barItems,
          statusBarCollapsed: _statusBarCollapsed,
          guildRailCollapsed: _guildRailCollapsed,
          ...kept
        } = p
        // Flag this boot so `ShellLayoutNotice` can say what moved. Not
        // persisted, so it is true exactly once — on the launch that migrated.
        return { ...kept, chromeLayoutMigrated: true } as UIState
      },
      // Deep-merge `barItems` so a snapshot written before a new segment
      // existed still gains that segment's default (shallow merge would drop
      // any key the persisted map lacks). Everything else merges shallowly.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<UIState>
        return {
          ...current,
          ...p,
          barItems: { ...DEFAULT_BAR_ITEMS, ...(p.barItems ?? {}) },
        }
      },
      // Don't persist member statuses (tied to in-flight requests that died)
      // or stop requests (one-shot, transient). `findOpen` is transient too.
      partialize: (s) => ({
        selectedGuild: s.selectedGuild,
        showMemberList: s.showMemberList,
        scratchpadCollapsed: s.scratchpadCollapsed,
        sidebarCollapsed: s.sidebarCollapsed,
        sidebarWidth: s.sidebarWidth,
        channelListView: s.channelListView,
        collapsedFolderIds: s.collapsedFolderIds,
        groupCollapseOverrides: s.groupCollapseOverrides,
        guildRailCollapsed: s.guildRailCollapsed,
        statusBarCollapsed: s.statusBarCollapsed,
        barItems: s.barItems,
      }),
    }
  )
)

/** Selector helper: read the live status of a team member. */
export function useMemberStatus(teamSessionId: string | null, characterId: string): MemberStatus {
  return useUIStore((s) =>
    teamSessionId ? (s.memberStatus[memberKey(teamSessionId, characterId)] ?? "idle") : "idle"
  )
}
