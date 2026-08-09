"use client"

import { useTranslations } from "next-intl"
import { ShieldAlertIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { sessionPeerMetadataOf } from "@/lib/chat/session-peer-delivery"

export function SessionPeerOriginBadge({ metadata }: { metadata: unknown }) {
  const t = useTranslations("chat.sessionCommunication")
  const peer = sessionPeerMetadataOf(metadata)
  if (!peer) return null
  return (
    <Badge
      variant="outline"
      className="mt-1 gap-1 border-amber-500/40 text-amber-700 dark:text-amber-300"
    >
      <ShieldAlertIcon className="size-3" />
      {peer.origin === "agent"
        ? t("agentOrigin", { name: peer.senderTitle })
        : t("userOrigin", { name: peer.senderTitle })}
    </Badge>
  )
}
