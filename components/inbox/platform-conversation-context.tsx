"use client"

import { useEffect, useId } from "react"
import type { ChatSession } from "@cognia/agent-config-types"
import { useAdapterInstance } from "@/hooks/connectors/use-adapter-instance"
import { useResolvedBinding } from "@/hooks/connectors/use-resolved-binding"
import {
  useActiveConversationStore,
  isViewingConversation,
} from "@/stores/inbox/active-conversation-store"
import { captureUnreadMarker } from "@/lib/chat/unread-marker"
import { markSessionRead } from "@/lib/db/session-state"
import { capabilityAvailability } from "@/lib/connectors/capability-availability"
import {
  effectiveCapabilities,
  effectiveCapabilitiesForRow,
} from "@/lib/connectors/effective-capabilities"
import { ConversationHeader } from "./conversation-header"
import { HistoryLoadEarlier } from "./history-load-earlier"
import { InboxNoticeArea } from "./notices/notice-area"
import { PlatformBadge } from "./platform-badge"
import { ThreadMembershipChip } from "./thread-membership-chip"

type Props = { session: ChatSession }

/** Account identity belongs beside the conversation title, outside its actions. */
export function PlatformConversationIdentity({ session }: Props) {
  const binding = session.platformBinding
  const adapter = useAdapterInstance(binding?.adapterId)
  if (!binding) return null
  const name = adapter?.displayName ?? binding.adapterId
  return (
    <span
      className="hidden min-w-0 max-w-48 truncate text-xs text-muted-foreground sm:inline"
      title={name}
    >
      {name}
    </span>
  )
}

/** Platform-specific controls shared by desktop and compact chat headers. */
export function PlatformConversationHeader({
  session,
  showIdentity = true,
}: Props & { showIdentity?: boolean }) {
  const binding = session.platformBinding
  const policy = useResolvedBinding(
    binding ? { adapterId: binding.adapterId, conversationKey: binding.conversationKey } : null
  )
  if (!binding) return null
  return (
    <>
      {showIdentity && <PlatformConversationIdentity session={session} />}
      <ThreadMembershipChip conversationKey={binding.conversationKey} className="shrink-0" />
      <ConversationHeader
        controlsOnly
        conversationKey={binding.conversationKey}
        sessionId={session.id}
        title={session.title}
        platform={binding.platform}
        policy={policy?.trigger}
        characterId={session.characterId}
      />
    </>
  )
}

/** Conversation services that must follow the shared ChatPane on every host. */
export function PlatformConversationContext({
  session,
  showHeader = false,
  activityInComposer = false,
}: Props & { showHeader?: boolean; activityInComposer?: boolean }) {
  const binding = session.platformBinding
  const adapter = useAdapterInstance(binding?.adapterId)
  const ownerId = useId()
  const key = binding?.conversationKey
  useEffect(() => {
    if (!key) return
    const store = useActiveConversationStore.getState()
    // Activity removes effects for hidden retained panels. Each visible owner
    // registers separately, so closing a duplicate does not hide its sibling.
    const visit = store.retainVisiblePane(ownerId, key, session.id)
    const reconcileRead = () => {
      if (!isViewingConversation(key, session.id)) return
      const firstOwner = Object.entries(useActiveConversationStore.getState().visiblePanes).find(
        ([, pane]) => pane.conversationKey === key && pane.sessionId === session.id
      )?.[0]
      // Capture the unread divider once when duplicate surfaces show a session.
      if (firstOwner !== ownerId || visit.reading) return
      visit.reading = true
      const read = async () => {
        // Refocus and duplicate-owner takeover continue the same visible visit.
        // Keep its divider while acknowledging newly arrived unread messages.
        if (!visit.markerCaptured) {
          await captureUnreadMarker(session.id)
          visit.markerCaptured = true
        }
        await markSessionRead(session.id)
      }
      void read()
        .catch((error) => {
          console.warn("Failed to mark visible platform session read", error)
        })
        .finally(() => {
          visit.reading = false
        })
    }
    reconcileRead()
    window.addEventListener("focus", reconcileRead)
    document.addEventListener("visibilitychange", reconcileRead)
    return () => {
      store.releaseVisiblePane(ownerId)
      window.removeEventListener("focus", reconcileRead)
      document.removeEventListener("visibilitychange", reconcileRead)
    }
  }, [key, session.id, ownerId])
  if (!binding) return null
  const history = capabilityAvailability(
    adapter
      ? effectiveCapabilitiesForRow(adapter)
      : effectiveCapabilities({ platform: binding.platform }),
    "history.fetch"
  )
  return (
    <>
      {showHeader && (
        <div className="flex min-w-0 shrink-0 items-center gap-1 border-b px-2 py-1">
          <PlatformBadge platform={binding.platform} fullName />
          <div className="min-w-0 flex-1" />
          <PlatformConversationHeader session={session} />
        </div>
      )}
      <InboxNoticeArea
        conversationKey={binding.conversationKey}
        suppressKinds={activityInComposer ? ["activity"] : undefined}
      />
      <HistoryLoadEarlier
        conversationKey={binding.conversationKey}
        adapterId={binding.adapterId}
        sessionId={session.id}
        unavailable={history.available ? undefined : history}
      />
    </>
  )
}
