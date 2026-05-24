"use client"

/**
 * Remote Session Control — mobile session detail view.
 *
 * Live view of one desktop-hosted agent session: streams assistant turns via
 * `useRemoteSessionStream`, renders a tool-use approval card when the host
 * routes one here, and (when this device holds the remote-control capability)
 * exposes a composer to send follow-ups and an interrupt control.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { SendIcon, SquareIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { useRemoteSessionStream } from "@/hooks/data/use-remote-session-stream"
import { ApprovalCard } from "./approval-card"
import type { UIMessage } from "ai"

function messageText(message: UIMessage): string {
  return message.parts
    .map((p) => {
      const part = p as { type?: string; text?: string }
      return part.type === "text" && typeof part.text === "string" ? part.text : ""
    })
    .filter(Boolean)
    .join("\n")
}

export interface RemoteSessionDetailProps {
  sessionId: string
}

export function RemoteSessionDetail({ sessionId }: RemoteSessionDetailProps) {
  const t = useTranslations("mobile.remoteSessions.detail")
  const { messages, status, pendingApproval, canControl, send, interrupt, respond } =
    useRemoteSessionStream(sessionId)
  const [draft, setDraft] = useState("")

  const onSend = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft("")
    await send(text)
  }

  return (
    <div className="flex h-full flex-col" data-testid="remote-session-detail">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="text-sm font-medium">{t("title")}</span>
        {status === "streaming" ? (
          <Badge variant="secondary" data-testid="remote-streaming-badge">
            {t("streaming")}
          </Badge>
        ) : null}
        {!canControl ? (
          <Badge variant="outline" data-testid="remote-observe-only">
            {t("observeOnly")}
          </Badge>
        ) : null}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          messages.map((m) => (
            <div key={m.id} data-testid={`remote-msg-${m.role}`} className="text-sm">
              <span className="mr-2 text-[10px] uppercase text-muted-foreground">{m.role}</span>
              <span className="whitespace-pre-wrap">{messageText(m)}</span>
            </div>
          ))
        )}

        {pendingApproval && canControl ? (
          <ApprovalCard approval={pendingApproval} onRespond={respond} />
        ) : null}
      </div>

      {canControl ? (
        <div className="flex items-center gap-2 border-t p-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                void onSend()
              }
            }}
            placeholder={t("composerPlaceholder")}
            aria-label={t("composerAria")}
            data-testid="remote-composer-input"
          />
          {status === "streaming" ? (
            <Button
              size="icon"
              variant="outline"
              onClick={() => void interrupt()}
              aria-label={t("interruptAria")}
              data-testid="remote-interrupt"
            >
              <SquareIcon className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={() => void onSend()}
              aria-label={t("sendAria")}
              data-testid="remote-send"
            >
              <SendIcon className="h-4 w-4" />
            </Button>
          )}
        </div>
      ) : null}
    </div>
  )
}
