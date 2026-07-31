"use client"

/**
 * IslandReply — a compact inline "send a prompt" affordance for OpenCode
 * sessions (the only agent whose plugin can inject a message into the running
 * session). Collapsed to a small button; clicking reveals a one-line input
 * that expands the island. Enter sends; Escape/blur collapses.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { SendHorizontalIcon } from "lucide-react"
import { fleetOpencodeSendMessage } from "@/lib/tauri/fleet"

export function IslandReply({ sessionId }: { sessionId: string }) {
  const t = useTranslations("fleet.reply")
  const [open, setOpen] = useState(false)
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)

  const send = async () => {
    const trimmed = text.trim()
    if (!trimmed || sending) return
    setSending(true)
    try {
      const id = await fleetOpencodeSendMessage(sessionId, trimmed)
      if (id) {
        setText("")
        setOpen(false)
      }
    } finally {
      setSending(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        data-testid="island-reply-open"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        className="shrink-0 rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] text-white/70 hover:bg-white/20"
      >
        {t("open")}
      </button>
    )
  }

  return (
    <div
      className="flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
      role="presentation"
    >
      <input
        autoFocus
        data-testid="island-reply-input"
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
        onBlur={() => {
          if (!text.trim()) setOpen(false)
        }}
        className="min-w-0 flex-1 rounded-md bg-white/10 px-2 py-0.5 text-[11px] text-white placeholder:text-white/30 focus:outline-none"
      />
      <button
        type="button"
        data-testid="island-reply-send"
        disabled={sending || !text.trim()}
        onClick={() => void send()}
        aria-label={t("send")}
        className="shrink-0 rounded-md bg-emerald-500/90 p-1 text-white hover:bg-emerald-400 disabled:opacity-50"
      >
        <SendHorizontalIcon className="size-3" aria-hidden />
      </button>
    </div>
  )
}

export default IslandReply
