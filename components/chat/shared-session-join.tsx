"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { resolveCurrentCollabContext } from "@/lib/collab/runtime-client"
import { useSharedChatEnabled } from "@/hooks/collab/use-shared-chat-enabled"
import { openAcceptedSharedSession } from "@/lib/collab/open-shared-session"
import { useShellNav } from "@/components/shell/use-shell-nav"

/** Entry point for invitees who do not yet have a conversation to open. */
export function SharedSessionJoin({
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCloseAutoFocus?: (event: Event) => void
}) {
  const t = useTranslations("chatCollaboration")
  const { switchToDm } = useShellNav()
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const featureEnabled = useSharedChatEnabled()
  if (!featureEnabled) return null

  const join = async () => {
    if (busy || !token.trim()) return
    if (!navigator.onLine) {
      toast.error(t("offlineConversion"))
      return
    }
    setBusy(true)
    try {
      const context = await resolveCurrentCollabContext()
      if (!context) {
        toast.error(t("notConfigured"))
        return
      }
      const accepted = await context.client.acceptSessionInvite(context.orgId, token.trim())
      await openAcceptedSharedSession({
        client: context.client,
        orgId: context.orgId,
        sharedSessionId: accepted.invite.sessionId,
        switchToDm,
      })
      setToken("")
      onOpenChange(false)
      toast.success(t("inviteAccepted"))
    } catch {
      toast.error(t("inviteAcceptFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t("acceptInvite")}</DialogTitle>
          <DialogDescription>{t("joinDescription")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            void join()
          }}
        >
          <Label htmlFor="join-shared-invite">{t("inviteToken")}</Label>
          <Input
            id="join-shared-invite"
            value={token}
            disabled={busy}
            placeholder={t("inviteTokenPlaceholder")}
            onChange={(event) => setToken(event.target.value)}
          />
          <Button type="submit" disabled={busy || !token.trim()}>
            {busy ? t("loading") : t("acceptInvite")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
