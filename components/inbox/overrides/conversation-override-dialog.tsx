"use client"

/**
 * Dialog wrapper around `ConversationOverrideForm` (im-refactored-crayon).
 *
 * Mounted from both Settings (Conversations tab Edit button) and Inbox
 * (conversation header gear icon). The form is the single source of
 * truth — this file is purely a shadcn Dialog shell.
 */

import { useTranslations } from "next-intl"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ConversationOverrideForm } from "./conversation-override-form"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"

export interface ConversationOverrideDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  adapterId: string
  conversationKey: string
  sessionId: string
  initialRow?: ConversationOverrideRow | null
}

export function ConversationOverrideDialog(props: ConversationOverrideDialogProps) {
  const { open, onOpenChange, adapterId, conversationKey, sessionId, initialRow } = props
  const t = useTranslations("inbox.conversationOverride")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("dialogTitle")}</DialogTitle>
        </DialogHeader>
        {/* Remount the form when the target row identity changes so the
         * useState initializers re-seed from the new initialRow. This is
         * the React-recommended "key to reset state" pattern and replaces
         * the prior reset-via-useEffect, which tripped react-hooks/set-state-in-effect. */}
        <ConversationOverrideForm
          key={`${conversationKey}:${initialRow?.id ?? "new"}`}
          adapterId={adapterId}
          conversationKey={conversationKey}
          sessionId={sessionId}
          initialRow={initialRow ?? null}
          onDone={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
