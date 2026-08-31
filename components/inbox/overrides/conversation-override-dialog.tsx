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
import { useImEffectiveConfig } from "@/hooks/connectors/use-im-effective-config"

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
  // `initialRow`, not a live read: the form seeds its own state from that row,
  // so re-resolving under a concurrent write would relabel fields the operator
  // is in the middle of editing. The header chip passes a live row instead.
  const effectiveConfig = useImEffectiveConfig({ adapterId, override: initialRow ?? null })

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
          effectiveSources={{
            mode: effectiveConfig?.mode.source ?? "system-default",
            // Per-axis provenance: an axis derived from the mode mirror
            // inherits the mode's source, so these are not all the same label.
            autonomy: effectiveConfig?.autonomy.source ?? "system-default",
            engagement: effectiveConfig?.engagement.source ?? "system-default",
            authority: effectiveConfig?.authority.source ?? "system-default",
            inboundActivationPolicy:
              effectiveConfig?.behavior.inboundActivationPolicy.source ?? "system-default",
            activeRunDispatchMode:
              effectiveConfig?.behavior.activeRunDispatchMode.source ?? "system-default",
            activationTtlHours:
              effectiveConfig?.behavior.activationTtlMs.source ?? "system-default",
          }}
          effectiveTargetKind={effectiveConfig?.target.effective.kind}
          onDone={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
