"use client"

/**
 * Remote Session Control — mobile session detail view.
 *
 * Live view of one desktop-hosted agent session: streams assistant turns via
 * `useRemoteSessionStream`, renders a tool-use approval card when the host
 * routes one here, and (when this device holds the remote-control capability)
 * mounts `RemoteSessionComposer` to send follow-ups, attach files, and
 * interrupt.
 *
 * Three tabs, because a transcript answers "what was said" and not "what
 * happened to the code". Changes reads the host's task-workspace patch set;
 * Tests reads verification counts off the synced run snapshot. Both are
 * read-only, and the approval card and composer stay mounted across all three
 * — an approval blocks the session, not the tab.
 */

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useRemoteSessionStream } from "@/hooks/data/use-remote-session-stream"
import { useConnectionState } from "@/hooks/companion/use-connection-state"
import { RemoteSessionComposer } from "./remote-session-composer"
import { OfflineBanner } from "@/components/mobile/offline-banner"
import { CONNECTION_STATE_META } from "@/components/mobile/connection-state-badge"
import { cn } from "@/lib/utils"
import { ApprovalCard } from "./approval-card"
import { SessionChangesPanel } from "./session-changes-panel"
import { SessionTestsPanel } from "./session-tests-panel"
import { TranscriptMessageList } from "@/components/chat/transcript-message-list"
import { TranscriptTimelineSurface } from "@/components/chat/transcript-timeline-surface"
import { useTranscriptController } from "@/hooks/chat/use-transcript-controller"
import { SessionMediaProvider } from "@/hooks/chat/session-media-provider"
import { createRemoteTranscriptSource } from "@/lib/chat/transcript/source"
import { transport } from "@/lib/tauri"
import { useMessageDisplay } from "@/hooks/chat/use-message-display"
import { getSession } from "@/lib/db/sessions"

const remoteTranscriptSource = createRemoteTranscriptSource(transport)

export interface RemoteSessionDetailProps {
  sessionId: string
}

export function RemoteSessionDetail({ sessionId }: RemoteSessionDetailProps) {
  const t = useTranslations("mobile.remoteSessions.detail")
  const tc = useTranslations("mobile.connectionState")
  const session = useLiveQuery(() => getSession(sessionId), [sessionId])
  const messageDisplay = useMessageDisplay(session?.messageDisplayOverride)
  const transcript = useTranscriptController(sessionId, remoteTranscriptSource)
  const {
    messages,
    status,
    pendingApproval,
    canControl,
    attachDowngrade,
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
            // Say *why* it is read-only. The two reasons need different actions
            // from the user: a missing grant stays until someone turns remote
            // control on for this device, while a stream that has not caught up
            // clears itself on reconnect.
            <Badge variant="outline" data-testid="remote-observe-only">
              {attachDowngrade === "missing-capability"
                ? t("observeOnlyMissingGrant")
                : attachDowngrade === "event-plane-not-ready"
                  ? t("observeOnlyReconnecting")
                  : t("observeOnly")}
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
        ) : (
          <Tabs defaultValue="transcript" className="flex min-h-0 flex-1 flex-col gap-0">
            <TabsList className="mx-3 mt-2 shrink-0" data-testid="remote-session-tabs">
              <TabsTrigger value="transcript">{t("tabs.transcript")}</TabsTrigger>
              <TabsTrigger value="changes">{t("tabs.changes")}</TabsTrigger>
              <TabsTrigger value="tests">{t("tabs.tests")}</TabsTrigger>
            </TabsList>

            {/* Radix unmounts an inactive tab, so neither panel below issues a
                single RPC or Dexie read until someone actually opens it. */}
            <TabsContent value="transcript" className="flex min-h-0 flex-1 flex-col">
              {transcript.snapshot.mode === "timeline" ? (
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
                renderAdapters={{ messageDisplay }}
              />
            </SessionMediaProvider>
          )
              ) : transcript.snapshot.mode === "unknown" ? (
                <p className="flex-1 p-4 text-xs text-muted-foreground">{t("loadingTranscript")}</p>
              ) : messages.length === 0 ? (
                <p className="flex-1 p-4 text-xs text-muted-foreground">{t("empty")}</p>
              ) : (
                <TranscriptMessageList
                  messages={messages}
                  status={status}
                  sessionId={sessionId}
                  messageDisplay={messageDisplay}
                />
              )}
            </TabsContent>

            <TabsContent value="changes" className="min-h-0 flex-1">
              <SessionChangesPanel sessionId={sessionId} />
            </TabsContent>

            <TabsContent value="tests" className="min-h-0 flex-1">
              <SessionTestsPanel sessionId={sessionId} />
            </TabsContent>
          </Tabs>
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
        <RemoteSessionComposer
          sessionId={sessionId}
          streaming={status === "streaming"}
          offline={offlineLike}
          onSend={send}
          onInterrupt={() => void interrupt()}
        />
      ) : null}
    </div>
  )
}
