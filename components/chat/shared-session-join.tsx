"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { LinkIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { resolveCurrentCollabContext } from "@/lib/collab/runtime-client"
import { useSharedChatEnabled } from "@/hooks/collab/use-shared-chat-enabled"
import { syncSharedSession } from "@/lib/collab/shared-chat-sync"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { useShellNav } from "@/components/shell/use-shell-nav"
import { cn } from "@/lib/utils"

/** Entry point for invitees who do not yet have a conversation to open. */
export function SharedSessionJoin({ className }: { className?: string } = {}) {
  const t = useTranslations("chatCollaboration")
  const { switchToDm } = useShellNav()
  const [open, setOpen] = useState(false)
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
      const synced = await syncSharedSession(
        context.client,
        context.orgId,
        accepted.invite.sessionId
      )
      useProjectStore.getState().setActiveProject(synced.session.workspaceId)
      useChatStore.getState().setActiveSession(synced.localSessionId)
      switchToDm()
      setToken("")
      setOpen(false)
      toast.success(t("inviteAccepted"))
    } catch {
      toast.error(t("inviteAcceptFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* A secondary row, not a centred text button: bare, it read as a
            stray banner at the top of the phone drawer and under the
            desktop account card. */}
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "w-full justify-start gap-2 font-normal text-muted-foreground hover:text-foreground",
            className
          )}
          data-testid="shared-session-join-trigger"
        >
          <LinkIcon className="size-4" aria-hidden="true" />
          {t("acceptInvite")}
        </Button>
      </DialogTrigger>
      <DialogContent>
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
