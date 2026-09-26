"use client"

/**
 * The single-conversation export / share-link dialog, as a conversation list
 * hosts it: once per list (not once per row), opened for whichever row asked
 * (`useConversationRowActions().exportSessionId`).
 *
 * The dialog itself is loaded on first use — it pulls in the HTML exporters
 * and the theme gallery, which neither list needs until someone exports.
 */

import dynamic from "next/dynamic"
import type { ChatSession } from "@cognia/agent-config-types"

const SingleExportDialog = dynamic(
  () =>
    import("@/components/data/export/single-export-dialog").then(
      (module) => module.SingleExportDialog
    ),
  { ssr: false }
)

export interface ConversationExportDialogProps {
  /** The row being exported; `null` renders nothing. */
  session: ChatSession | null
  onClose: () => void
}

export function ConversationExportDialog({ session, onClose }: ConversationExportDialogProps) {
  if (!session) return null
  return (
    <SingleExportDialog
      session={session}
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    />
  )
}
