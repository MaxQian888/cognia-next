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
import { useConnectionState } from "@/hooks/companion/use-connection-state"
import { useCommandHistory, handleHistoryArrowKey } from "@/hooks/use-command-history"
import { OfflineBanner } from "@/components/mobile/offline-banner"
import type { ConnectionState } from "@/lib/tauri/transport-companion"
import { cn } from "@/lib/utils"
import { ApprovalCard } from "./approval-card"
import type { UIMessage } from "ai"

// Connection-state → (label key in `mobile.connectionState`, pill tone).
// Mirrors the tone map in `connection-state-badge.tsx` so the in-session pill
// reads consistently with the app-shell badge.
const CONNECTION_META: Record<ConnectionState, { labelKey: string; tone: string }> = {
  connected: { labelKey: "live", tone: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300" },
  reconnecting: { labelKey: "reconnecting", tone: "border-amber-500/40 text-amber-700 dark:text-amber-300" },
  offline: { labelKey: "offline", tone: "border-zinc-500/40 text-zinc-600 dark:text-zinc-400" },
  unauthenticated: { labelKey: "repairNeeded", tone: "border-red-500/40 text-red-700 dark:text-red-300" },
}

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
  const tc = useTranslations("mobile.connectionState")
  const { messages, status, pendingApproval, canControl, sessionEnded, notFound, send, interrupt, respond } =
    useRemoteSessionStream(sessionId)
  const connection = useConnectionState()
  const [draft, setDraft] = useState("")
  // Shell-style ↑/↓ recall of previously sent follow-ups, persisted per remote
  // session so the steer history survives a reload of the mobile shell.
  const history = useCommandHistory({ persistKey: `cmdhist:remote-session:${sessionId}` })

  // Sends can't reach the desktop while the transport is down — gate the
  // composer so the user gets an explicit hint instead of a silent failure.
  const offlineLike = connection === "offline" || connection === "reconnecting"
  const composable = canControl && !sessionEnded && !notFound

  const onSend = async () => {
    const text = draft.trim()
    if (!text) return
    history.record(text)
    setDraft("")
    await send(text)
  }

  return (
    <div className="flex h-full flex-col" data-testid="remote-session-detail">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <span className="text-sm font-medium">{t("title")}</span>
        <div className="flex items-center gap-2">
          {connection ? (
            <Badge
              variant="outline"
              data-testid="remote-connection-pill"
              data-state={connection}
              className={cn("font-mono text-[10px] uppercase", CONNECTION_META[connection].tone)}
            >
              {tc(CONNECTION_META[connection].labelKey)}
            </Badge>
          ) : null}
          {sessionEnded ? (
            <Badge variant="outline" data-testid="remote-ended-badge">
              {t("endedBadge")}
            </Badge>
          ) : status === "streaming" ? (
            <Badge variant="secondary" data-testid="remote-streaming-badge">
              {t("streaming")}
            </Badge>
          ) : null}
          {!canControl && !notFound ? (
            <Badge variant="outline" data-testid="remote-observe-only">
              {t("observeOnly")}
            </Badge>
          ) : null}
        </div>
      </div>

      <OfflineBanner />

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {notFound ? (
          <p className="text-xs text-muted-foreground" data-testid="remote-session-not-found">
            {t("notFound")}
          </p>
        ) : messages.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          messages.map((m) => (
            <div key={m.id} data-testid={`remote-msg-${m.role}`} className="text-sm">
              <span className="mr-2 text-[10px] uppercase text-muted-foreground">{m.role}</span>
              <span className="whitespace-pre-wrap">{messageText(m)}</span>
            </div>
          ))
        )}

        {pendingApproval && composable ? (
          <ApprovalCard approval={pendingApproval} onRespond={respond} />
        ) : null}

        {sessionEnded ? (
          <p className="text-xs text-muted-foreground" data-testid="remote-session-ended">
            {t("ended")}
          </p>
        ) : null}
      </div>

      {composable ? (
        <div className="border-t p-2">
          {offlineLike ? (
            <p className="px-1 pb-1 text-[11px] text-muted-foreground" data-testid="remote-offline-hint">
              {t("offlineHint")}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                history.noteEdit()
              }}
              onKeyDown={(e) => {
                if (handleHistoryArrowKey(e, history, setDraft)) return
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  if (!offlineLike) void onSend()
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
                disabled={offlineLike}
                onClick={() => void onSend()}
                aria-label={t("sendAria")}
                data-testid="remote-send"
              >
                <SendIcon className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
