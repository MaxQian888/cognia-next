"use client"

/**
 * Mobile counterpart to the island's `IslandReply` — inject a prompt into an
 * OpenCode fleet session over the companion transport. Collapsed to a button;
 * revealing shows a one-line input. Sends via `fleetRemoteSendMessage`; a
 * failure (incl. a revoked control grant) surfaces as a toast.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { SendHorizontalIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { fleetRemoteSendMessage } from "@/lib/fleet/fleet-remote-actions"

export function MobileFleetReply({ sessionId }: { sessionId: string }) {
  const t = useTranslations("mobile.fleet.reply")
  const [open, setOpen] = useState(false)
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)

  const send = async () => {
    const trimmed = text.trim()
    if (!trimmed || sending) return
    setSending(true)
    try {
      await fleetRemoteSendMessage(sessionId, trimmed)
      setText("")
      setOpen(false)
    } catch {
      toast.error(t("failed"))
    } finally {
      setSending(false)
    }
  }

  if (!open) {
    return (
      <Button
        size="sm"
        variant="outline"
        data-testid="mobile-fleet-reply-open"
        onClick={() => setOpen(true)}
      >
        {t("open")}
      </Button>
    )
  }

  return (
    <div className="flex items-center gap-1.5" data-testid="mobile-fleet-reply">
      <Input
        autoFocus
        data-testid="mobile-fleet-reply-input"
        value={text}
        placeholder={t("placeholder")}
        disabled={sending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            void send()
          } else if (e.key === "Escape") {
            setOpen(false)
          }
        }}
        className="h-8 text-xs"
      />
      <Button
        size="sm"
        data-testid="mobile-fleet-reply-send"
        disabled={sending || !text.trim()}
        onClick={() => void send()}
        aria-label={t("send")}
      >
        <SendHorizontalIcon className="size-3.5" aria-hidden />
      </Button>
    </div>
  )
}

export default MobileFleetReply
