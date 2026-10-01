"use client"

/**
 * Confirm-then-accept for a shared-chat invite addressed to the signed-in
 * person, reached from its `chat.invited` notification (ADR-0207).
 *
 * The notification links to `/?acceptInvite=<inviteId>&org=<orgId>`
 * (`lib/collab/targeted-invite-link.ts`); the root page reads the link and
 * mounts this dialog. Nothing is accepted on arrival: following a link must
 * not add somebody to a conversation they have not agreed to join, so the
 * dialog asks first and "Not now" leaves the invite pending.
 *
 * After an accept it does exactly what a token accept does
 * (`openAcceptedSharedSession`), so the two entry points cannot drift.
 * Whatever the outcome, the dialog closes and `onSettled` lets the page drop
 * the link's params, with one exception: offline keeps it open, because the
 * person can reconnect and press Accept again.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { UsersIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useShellNav } from "@/components/shell/use-shell-nav"
import { useSharedChatEnabled } from "@/hooks/collab/use-shared-chat-enabled"
import { openAcceptedSharedSession } from "@/lib/collab/open-shared-session"
import { resolveCurrentCollabContext } from "@/lib/collab/runtime-client"
import type { TargetedInviteLink } from "@/lib/collab/targeted-invite-link"

export interface TargetedInviteAcceptProps extends TargetedInviteLink {
  /** Called once the link is spent: accepted, refused, or dismissed. */
  onSettled: () => void
}

export function TargetedInviteAccept({ inviteId, orgId, onSettled }: TargetedInviteAcceptProps) {
  const t = useTranslations("chatCollaboration")
  const { switchToDm } = useShellNav()
  const featureEnabled = useSharedChatEnabled()
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(false)

  const settle = () => {
    setOpen(false)
    onSettled()
  }

  const accept = async () => {
    if (busy) return
    if (!featureEnabled) {
      toast.error(t("featureDisabled"))
      settle()
      return
    }
    if (!navigator.onLine) {
      // Kept open: the accept is never queued silently, and reconnecting then
      // pressing Accept again is the obvious next step.
      toast.error(t("targetedInvite.offline"))
      return
    }
    setBusy(true)
    try {
      const context = await resolveCurrentCollabContext()
      if (!context) {
        toast.error(t("notConfigured"))
        return
      }
      if (context.orgId !== orgId) {
        // An invite id is only meaningful in the org that issued it; sending
        // it under another org's grant would be refused anyway.
        toast.error(t("inviteAcceptFailed"), { description: t("targetedInvite.wrongOrg") })
        return
      }
      const accepted = await context.client.acceptTargetedSessionInvite(orgId, inviteId)
      await openAcceptedSharedSession({
        client: context.client,
        orgId,
        sharedSessionId: accepted.invite.sessionId,
        switchToDm,
      })
      toast.success(t("inviteAccepted"))
    } catch {
      toast.error(t("inviteAcceptFailed"))
    } finally {
      // Every outcome past this point spends the link, including the early
      // returns above.
      setBusy(false)
      settle()
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Escape, the overlay and the close button all mean "Not now", but
        // not halfway through an accept that is already on the wire.
        if (!next && !busy) settle()
      }}
    >
      <DialogContent data-testid="targeted-invite-accept">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UsersIcon className="size-4" aria-hidden="true" />
            {t("targetedInvite.title")}
          </DialogTitle>
          <DialogDescription>{t("targetedInvite.description")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={settle}>
            {t("targetedInvite.dismiss")}
          </Button>
          <Button disabled={busy} onClick={() => void accept()}>
            {busy ? t("targetedInvite.accepting") : t("targetedInvite.accept")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
