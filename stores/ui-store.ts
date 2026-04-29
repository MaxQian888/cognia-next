"use client"

import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"

/**
 * Which "guild" the user is currently looking at — either the synthetic
 * direct-messages bucket or a specific team.
 */
export type SelectedGuild = { kind: "dm" } | { kind: "team"; teamId: string }

/**
 * Live status of a team member during an in-flight team turn. Drives the dot
 * color in the member list and the skeleton in the message stream.
 */
export type MemberStatus = "idle" | "thinking" | "errored"

interface UIState {
  selectedGuild: SelectedGuild
  setSelectedGuild: (g: SelectedGuild) => void

  /**
   * In-progress, unsent text per session. Lets the user tab between channels
   * without losing what they were typing — Discord parity.
   */
  composerDraft: Record<string, string>
  setComposerDraft: (sessionId: string, text: string) => void
  clearComposerDraft: (sessionId: string) => void

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
}

function memberKey(teamSessionId: string, characterId: string) {
  return `${teamSessionId}::${characterId}`
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      selectedGuild: { kind: "dm" },
      setSelectedGuild: (g) => set({ selectedGuild: g }),

      composerDraft: {},
      setComposerDraft: (sessionId, text) =>
        set((s) => ({
          composerDraft: { ...s.composerDraft, [sessionId]: text },
        })),
      clearComposerDraft: (sessionId) =>
        set((s) => {
          if (!(sessionId in s.composerDraft)) return s
          const next = { ...s.composerDraft }
          delete next[sessionId]
          return { composerDraft: next }
        }),

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
    }),
    {
      name: "cognia-ui",
      storage: createJSONStorage(() => localStorage),
      // Don't persist composer drafts (stale text after a restart is annoying),
      // member statuses (tied to in-flight requests that died), or stop
      // requests (one-shot, transient).
      partialize: (s) => ({
        selectedGuild: s.selectedGuild,
        showMemberList: s.showMemberList,
        scratchpadCollapsed: s.scratchpadCollapsed,
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
