// Active connector conversation (ADR-0042). A tiny module-level store so the
// (non-React) ConnectorBus inbound observer can know which conversation the
// user is currently viewing — the focus-aware predicate that suppresses an OS
// notification for the conversation already on screen. The inbox conversation
// page sets/clears it on mount/unmount.

import { create } from "zustand"

export interface ActiveConversationState {
  activeConversationKey: string | null
  setActiveConversation: (key: string | null) => void
  clearIf: (key: string) => void
}

export const useActiveConversationStore = create<ActiveConversationState>()((set, get) => ({
  activeConversationKey: null,
  setActiveConversation: (key) => set({ activeConversationKey: key }),
  // Clear only if still the active one (avoids a late unmount clobbering a
  // newly-mounted conversation).
  clearIf: (key) => {
    if (get().activeConversationKey === key) set({ activeConversationKey: null })
  },
}))

/** Non-React read for the bus observer. */
export function isViewingConversation(conversationKey: string): boolean {
  if (typeof document !== "undefined" && !document.hasFocus()) return false
  return useActiveConversationStore.getState().activeConversationKey === conversationKey
}

export default useActiveConversationStore
