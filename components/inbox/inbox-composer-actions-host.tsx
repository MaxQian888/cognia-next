"use client"

/**
 * Wrapper that mounts the `inbox.composer.actions` plugin extension slot.
 *
 * Distinct from `chat.input.actions`: that one is the generic chat composer
 * surface (used in every chat session). This one is the inbox-specific
 * extension surface — only mounted when the active chat is bound to an
 * external platform conversation. Plugin contributions targeting it can
 * assume `context.conversationKey` and `context.platform` are present.
 *
 * Caller is responsible for only rendering this when the active session
 * has a `platformBinding`. The wrapper itself does not check; doing so
 * would require pulling in chat-store deps and re-deriving the binding,
 * which the caller already has in hand.
 */

import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import type { PlatformKind } from "@/types/connectors/platform-kind"

export interface InboxComposerActionsHostProps {
  conversationKey: string
  adapterId: string
  platform: PlatformKind
  sessionId: string
  className?: string
}

export function InboxComposerActionsHost({
  conversationKey,
  adapterId,
  platform,
  sessionId,
  className,
}: InboxComposerActionsHostProps) {
  return (
    <PluginExtensionSlot
      point="inbox.composer.actions"
      className={className ?? "flex items-center gap-1 empty:hidden"}
      context={{ conversationKey, adapterId, platform, sessionId }}
    />
  )
}
