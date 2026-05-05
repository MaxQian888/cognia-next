"use client"

/**
 * Conversation header strip for the Inbox detail pane.
 *
 * Left: platform avatar (PlatformBadge) + conversation name.
 * Middle: mode chip (ModeSwitcher) + character chip placeholder.
 * Right: policy info chip (PolicyInfo).
 */

import { ModeSwitcher } from "./mode-switcher"
import { PolicyInfo } from "./policy-info"
import { PlatformBadge } from "./platform-badge"
import type { ConnectorMode, TriggerPolicy } from "@/types/connectors/policy"
import type { PlatformKind } from "@/types/connectors/platform-kind"

interface ConversationHeaderProps {
  conversationKey: string
  sessionId: string
  title: string
  platform: PlatformKind
  currentMode: ConnectorMode
  policy: TriggerPolicy
  onModeChange?: (mode: ConnectorMode) => void
}

export function ConversationHeader({
  conversationKey,
  sessionId,
  title,
  platform,
  currentMode,
  policy,
  onModeChange,
}: ConversationHeaderProps) {
  return (
    <header
      className="flex h-12 shrink-0 items-center gap-3 border-b px-4"
      data-testid="conversation-header"
    >
      {/* Left: platform + title */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <PlatformBadge platform={platform} iconOnly />
        <h2 className="text-sm font-semibold truncate">{title}</h2>
      </div>

      {/* Middle: mode switcher */}
      <ModeSwitcher
        conversationKey={conversationKey}
        sessionId={sessionId}
        currentMode={currentMode}
        onModeChange={onModeChange}
      />

      {/* Right: policy info */}
      <PolicyInfo policy={policy} />
    </header>
  )
}
