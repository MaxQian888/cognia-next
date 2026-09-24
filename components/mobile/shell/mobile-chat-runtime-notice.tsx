"use client"

/**
 * The notice the phone shell shows in place of a working composer when chat
 * cannot send (`useChatRuntimeGate`). Same copy and the same recovery action
 * as the desktop workspace's notice — the `desktop.chatRuntime` vocabulary —
 * laid out for a phone: the action button spans the width at the 44px floor.
 */

import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  runtimeAvailabilityMessageKey,
  type ChatRuntimeGate,
} from "@/hooks/chat/use-chat-runtime-gate"

export interface MobileChatRuntimeNoticeProps {
  gate: ChatRuntimeGate
  /** Navigate to a route (pairing / recovery). */
  onNavigate: (href: string) => void
  /** Open a local settings section. */
  onOpenSettings: (section: string) => void
}

export function MobileChatRuntimeNotice({
  gate,
  onNavigate,
  onOpenSettings,
}: MobileChatRuntimeNoticeProps) {
  const t = useTranslations("desktop.chatRuntime")
  const { availability, recovery, connecting } = gate
  const offline = availability.state === "offline"
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/20 p-4 text-sm"
      role="status"
      data-testid="chat-runtime-notice"
    >
      <div className="min-w-0">
        <p className="font-medium">{t(offline ? "connectionTitle" : "title")}</p>
        <p className="text-muted-foreground">
          {t(
            connecting && offline
              ? "connecting"
              : `states.${runtimeAvailabilityMessageKey(availability.state)}`
          )}
        </p>
      </div>
      {recovery.kind !== "none" ? (
        <Button
          type="button"
          variant="outline"
          className="h-11 w-full"
          data-testid="chat-runtime-notice-action"
          onClick={() => {
            if (recovery.kind === "route") onNavigate(recovery.href)
            else onOpenSettings(recovery.section)
          }}
        >
          {t(availability.state === "requires-pairing" ? "actions.pair" : "actions.connectionSettings")}
        </Button>
      ) : null}
    </div>
  )
}
