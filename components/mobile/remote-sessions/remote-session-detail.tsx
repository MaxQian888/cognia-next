"use client"

/**
 * Remote Session Control — mobile session detail view.
 *
 * Live view of one desktop-hosted agent session: streams assistant turns via
 * `useRemoteSessionStream`, renders a tool-use approval card when the host
 * routes one here, and (when this device holds the remote-control capability)
 * exposes a composer to send follow-ups and an interrupt control.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { SendIcon, SquareIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { useRemoteSessionStream } from "@/hooks/data/use-remote-session-stream"
import { useConnectionState } from "@/hooks/companion/use-connection-state"
import { useCommandHistory, handleHistoryArrowKey } from "@/hooks/use-command-history"
import { OfflineBanner } from "@/components/mobile/offline-banner"
import { CONNECTION_STATE_META } from "@/components/mobile/connection-state-badge"
import { cn } from "@/lib/utils"
import { ApprovalCard } from "./approval-card"
import { TranscriptMessageList } from "@/components/chat/transcript-message-list"
import { TranscriptTimelineSurface } from "@/components/chat/transcript-timeline-surface"
import { useTranscriptController } from "@/hooks/chat/use-transcript-controller"
import { SessionMediaProvider } from "@/hooks/chat/session-media-provider"
import { createRemoteTranscriptSource } from "@/lib/chat/transcript/source"
import { transport } from "@/lib/tauri"

const remoteTranscriptSource = createRemoteTranscriptSource(transport)

export interface RemoteSessionDetailProps {
  sessionId: string
}

export function RemoteSessionDetail({ sessionId }: RemoteSessionDetailProps) {
  const t = useTranslations("mobile.remoteSessions.detail")
  const tc = useTranslations("mobile.connectionState")
  const transcript = useTranscriptController(sessionId, remoteTranscriptSource)
  const {
    messages,
    status,
    pendingApproval,
    canControl,
    sessionEnded,
    notFound,
    send,
    interrupt,
    respond,
    reconcileTranscript,
  } =
    useRemoteSessionStream(sessionId, {
      seedHistory: transcript.snapshot.mode === "legacy",
    })
  const reconciledRevisionRef = useRef<number | null>(null)
  const connection = useConnectionState()
  const [draft, setDraft] = useState("")
  // Shell-style ↑/↓ recall of previously sent follow-ups, persisted per remote
  // session so the steer history survives a reload of the mobile shell.
  const history = useCommandHistory({ persistKey: `cmdhist:remote-session:${sessionId}` })

  // Sends can't reach the desktop while the transport is down — gate the
  // composer so the user gets an explicit hint instead of a silent failure.
  const offlineLike = connection === "offline" || connection === "reconnecting"
  const composable = canControl && !sessionEnded && !notFound

  useEffect(() => {
    if (transcript.snapshot.mode !== "timeline" || transcript.snapshot.revision === null) return
    if (reconciledRevisionRef.current === transcript.snapshot.revision) return
    reconciledRevisionRef.current = transcript.snapshot.revision
    reconcileTranscript()
  }, [reconcileTranscript, transcript.snapshot.mode, transcript.snapshot.revision])

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
              className={cn(
                "font-mono text-[10px] uppercase",
                CONNECTION_STATE_META[connection].tone
              )}
            >
              {tc(CONNECTION_STATE_META[connection].labelKey)}
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

      <div className="flex min-h-0 flex-1 flex-col">
        {notFound ? (
          <p
            className="flex-1 p-4 text-xs text-muted-foreground"
            data-testid="remote-session-not-found"
          >
            {t("notFound")}
          </p>
        ) : transcript.snapshot.mode === "timeline" ? (
          transcript.snapshot.items.length === 0 && messages.length === 0 && !transcript.snapshot.loading ? (
            <p className="flex-1 p-4 text-xs text-muted-foreground">{t("empty")}</p>
          ) : (
            <SessionMediaProvider sessionId={sessionId} transport={transport}>
              <TranscriptTimelineSurface
                sessionId={sessionId}
                items={transcript.snapshot.items}
                expandedTurnKeys={transcript.snapshot.expandedTurnKeys}
                getDetail={transcript.getDetail}
                onExpand={(turnKey, revision, detailRevision) => {
                  void transcript.expandTurn(turnKey, revision, detailRevision)
                }}
                onCollapse={transcript.collapseTurn}
                onLoadOlder={() => void transcript.loadOlder()}
                onRetry={() => void transcript.retry()}
                hasMore={transcript.snapshot.hasMore}
                loading={transcript.snapshot.loading}
                loadingOlder={transcript.snapshot.loadingOlder}
                error={transcript.snapshot.error}
                liveMessages={messages}
                liveStatus={status}
                labels={{
                  expand: t("expandTurn"),
                  collapse: t("collapseTurn"),
                  loadOlder: t("loadOlder"),
                  loading: t("loadingTranscript"),
                  retry: t("retryTranscript"),
                }}
              />
            </SessionMediaProvider>
          )
        ) : transcript.snapshot.mode === "unknown" ? (
          <p className="flex-1 p-4 text-xs text-muted-foreground">{t("loadingTranscript")}</p>
        ) : messages.length === 0 ? (
          <p className="flex-1 p-4 text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <TranscriptMessageList messages={messages} status={status} sessionId={sessionId} />
        )}

        {pendingApproval && composable ? (
          <div className="shrink-0 p-4 pt-0">
            <ApprovalCard approval={pendingApproval} onRespond={respond} />
          </div>
        ) : null}

        {sessionEnded ? (
          <p
            className="shrink-0 px-4 pb-4 text-xs text-muted-foreground"
            data-testid="remote-session-ended"
          >
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
