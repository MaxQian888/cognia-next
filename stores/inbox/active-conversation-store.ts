// Active connector conversation (ADR-0042). A tiny module-level store so the
// (non-React) ConnectorBus inbound observer can know which conversation the
// user is currently viewing — the focus-aware predicate that suppresses an OS
// notification (and, via `lib/connectors/inbox-relay/host-events.ts`, the
// phone push relay) for the conversation already on screen, and that stops the
// runtime from counting its inbound messages as unread.
//
// Who writes it: `PlatformConversationContext`, which every shared ChatPane
// showing an IM session mounts, registers one `visiblePanes` entry per visible
// pane and marks the session read while it is visible. The old `/inbox/c`
// conversation page that used `setActiveConversation` on mount is gone (it
// redirects into the chat workspace now); the setter stays for callers that
// own a single active conversation outright.
//
// What must NOT write it: the Inbox triage preview pane. A preview is a glance,
// not a read — registering it here would silence notifications and the phone
// relay for a conversation the user has not opened, and quietly zero its
// unread count. Marking read from the preview is an explicit action only.

import { create } from "zustand"

/** Mutable read-operation state shared by panes during one visible visit. */
export interface VisibleConversationVisit {
  markerCaptured: boolean
  reading: boolean
}

export interface ActiveConversationState {
  activeConversationKey: string | null
  activeSessionId: string | null
  visiblePanes: Record<
    string,
    { conversationKey: string; sessionId: string; visit: VisibleConversationVisit }
  >
  retainVisiblePane: (
    ownerId: string,
    conversationKey: string,
    sessionId: string
  ) => VisibleConversationVisit
  releaseVisiblePane: (ownerId: string) => void
  setActiveConversation: (key: string | null, sessionId?: string) => void
  clearIf: (key: string, sessionId?: string) => void
}

export const useActiveConversationStore = create<ActiveConversationState>()((set, get) => ({
  activeConversationKey: null,
  activeSessionId: null,
  visiblePanes: {},
  retainVisiblePane: (ownerId, conversationKey, sessionId) => {
    const visit = Object.values(get().visiblePanes).find(
      (pane) => pane.conversationKey === conversationKey && pane.sessionId === sessionId
    )?.visit ?? { markerCaptured: false, reading: false }
    set((state) => ({
      visiblePanes: { ...state.visiblePanes, [ownerId]: { conversationKey, sessionId, visit } },
    }))
    return visit
  },
  releaseVisiblePane: (ownerId) =>
    set((state) => {
      const visiblePanes = { ...state.visiblePanes }
      delete visiblePanes[ownerId]
      return { visiblePanes }
    }),
  setActiveConversation: (key, sessionId) =>
    set({ activeConversationKey: key, activeSessionId: key ? (sessionId ?? null) : null }),
  // Clear only if still the active one (avoids a late unmount clobbering a
  // newly-mounted conversation).
  clearIf: (key, sessionId) => {
    if (get().activeConversationKey === key && (!sessionId || get().activeSessionId === sessionId))
      set({ activeConversationKey: null, activeSessionId: null })
  },
}))

/** Non-React read for the bus observer. */
export function isViewingConversation(conversationKey: string, sessionId?: string): boolean {
  if (
    typeof document !== "undefined" &&
    (!document.hasFocus() || document.visibilityState === "hidden")
  )
    return false
  const state = useActiveConversationStore.getState()
  return (
    (state.activeConversationKey === conversationKey &&
      (!sessionId || state.activeSessionId === sessionId)) ||
    Object.values(state.visiblePanes).some(
      (pane) =>
        pane.conversationKey === conversationKey && (!sessionId || pane.sessionId === sessionId)
    )
  )
}

export default useActiveConversationStore
