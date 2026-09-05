"use client"

/**
 * CollaborationPanel - Real-time collaborative editing UI for Canvas
 */

import { useState, useCallback } from "react"
import { useTranslations } from "next-intl"
import { buildCanvasSharePath } from "@/lib/canvas/collaboration/share-link"
import { Users, Share2, Check, Link2, UserPlus, Wifi, WifiOff, Circle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"
import { useCollaborativeSession } from "@/hooks/canvas"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"
import type { UseCollaborativeSessionReturn } from "@/hooks/canvas"
import { getConnectionStatusColor } from "@/lib/canvas/utils"
import type { Participant, CanvasCollaborationSessionState } from "@/types/canvas/collaboration"
import type { CollaborationConnectionState } from "@/types/canvas/panel"

interface CollaborationPanelProps {
  documentId: string
  documentContent: string
  trigger?: React.ReactNode
  collaboration?: UseCollaborativeSessionReturn
  collaborationState?: CanvasCollaborationSessionState | null
  onReconnect?: () => void
  onContinueLocally?: () => void
  onEndSession?: () => void
}

export function CollaborationPanel({
  documentId,
  documentContent,
  trigger,
  collaboration,
  collaborationState,
  onReconnect,
  onContinueLocally,
  onEndSession,
}: CollaborationPanelProps) {
  const t = useTranslations("canvas")
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [joinSessionId, setJoinSessionId] = useState("")
  const showAvatars = useCanvasSettingsStore((s) => s.settings.collaboration.showAvatars)

  const sessionApi = useCollaborativeSession({
    participantName: t("anonymousParticipant"),
  })
  const { session, participants, connectionState, connect, disconnect, shareTarget, joinSession } =
    collaboration || sessionApi
  const effectiveSessionId = collaborationState?.sessionId || session?.id || null
  const effectiveParticipants = collaborationState?.participants?.length
    ? collaborationState.participants
    : participants
  const effectiveConnectionState =
    (collaborationState?.connectionState as CollaborationConnectionState | undefined) ||
    (connectionState as CollaborationConnectionState)
  const recoveryState = collaborationState?.recoveryState || null
  const recoveryReason = collaborationState?.recoveryReason || null
  const canReconnect =
    Boolean(effectiveSessionId) &&
    (effectiveConnectionState === "reconnecting" ||
      effectiveConnectionState === "error" ||
      effectiveConnectionState === "degraded-local")
  const canContinueLocally =
    Boolean(effectiveSessionId) &&
    (effectiveConnectionState === "reconnecting" ||
      effectiveConnectionState === "error" ||
      effectiveConnectionState === "degraded-local" ||
      effectiveConnectionState === "ended")
  const showRecoveryActions = canReconnect || canContinueLocally
  const showLiveSessionControls =
    Boolean(effectiveSessionId) &&
    effectiveConnectionState !== "ended" &&
    recoveryState !== "snapshot-only"
  const showParticipantBadge = Boolean(effectiveSessionId) && effectiveParticipants.length > 0
  const usesLiveTransportIcon =
    effectiveConnectionState === "connected" ||
    effectiveConnectionState === "connecting" ||
    effectiveConnectionState === "reconnecting"

  const handleStartSession = useCallback(async () => {
    await connect(documentId, documentContent)
  }, [connect, documentId, documentContent])

  const handleEndSession = useCallback(() => {
    onEndSession?.()
    disconnect()
  }, [disconnect, onEndSession])

  const handleReconnectSession = useCallback(async () => {
    if (onReconnect) {
      onReconnect()
      return
    }

    if (effectiveSessionId) {
      await joinSession(effectiveSessionId)
    }
  }, [effectiveSessionId, joinSession, onReconnect])

  const handleContinueLocalEditing = useCallback(() => {
    onContinueLocally?.()
    setOpen(false)
  }, [onContinueLocally])

  /**
   * Copy a link that names the document, and nothing else.
   *
   * It used to serialise the whole session into the URL: the session id, the
   * owner, the participant list, the permission flags, the document content
   * and its operation log. Permissions in a link are permissions the recipient
   * can edit. It was also raw JSON in a parameter the join page `atob`ed, so
   * no link this app produced ever decoded.
   */
  const handleCopyShareLink = useCallback(async () => {
    const target = await shareTarget()
    if (!target) {
      setCopyError(t("shareLinkUnavailable"))
      return
    }

    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${buildCanvasSharePath(target)}`
      )
      setCopyError(null)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopyError(t("copyLinkFailed"))
    }
  }, [shareTarget, t])

  const handleJoinSession = useCallback(async () => {
    if (joinSessionId.trim()) {
      setCopyError(null)
      await joinSession(joinSessionId.trim())
      setJoinSessionId("")
    }
  }, [joinSession, joinSessionId])

  const getConnectionStatusText = (state: CollaborationConnectionState) => {
    switch (state) {
      case "connected":
        return t("connected")
      case "connecting":
        return t("connecting")
      case "reconnecting":
        return t("reconnecting")
      case "degraded-local":
        return t("degradedLocal")
      case "ended":
        return t("sessionEnded")
      case "error":
        return t("connectionError")
      default:
        return t("disconnected")
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        {trigger || (
          <Button variant="ghost" size="sm" className="gap-2" data-testid="canvas-collab-trigger">
            <Users className="h-4 w-4" />
            <span className="hidden sm:inline">{t("collaborate")}</span>
            {showParticipantBadge && (
              <Badge variant="secondary" className="ml-1 px-1.5 py-0">
                {effectiveParticipants.length}
              </Badge>
            )}
          </Button>
        )}
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:w-[350px]">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            {t("collaboration")}
            <Badge
              variant="outline"
              className="ml-1 text-[10px] px-1.5 py-0 text-warning border-warning"
            >
              {t("experimental")}
            </Badge>
          </SheetTitle>
          <SheetDescription className="sr-only">
            {t("collaborationPanelDescription")}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {/* Connection Status */}
          <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2">
              {usesLiveTransportIcon ? (
                <Wifi
                  className={cn("h-4 w-4", getConnectionStatusColor(effectiveConnectionState))}
                />
              ) : (
                <WifiOff
                  className={cn("h-4 w-4", getConnectionStatusColor(effectiveConnectionState))}
                />
              )}
              <span className="text-sm">{getConnectionStatusText(effectiveConnectionState)}</span>
            </div>
            {effectiveSessionId && (
              <Badge variant="outline" className="text-xs">
                {effectiveSessionId.slice(0, 8)}...
              </Badge>
            )}
          </div>
          {(recoveryState || recoveryReason) && (
            <div className="space-y-1 rounded-lg border border-dashed p-3">
              {recoveryState && (
                <Badge variant="secondary" className="text-[10px]">
                  {recoveryState === "snapshot-only"
                    ? t("snapshotOnly")
                    : recoveryState === "local-copy"
                      ? t("continueLocally")
                      : t("degradedLocal")}
                </Badge>
              )}
              {recoveryReason && <p className="text-xs text-muted-foreground">{recoveryReason}</p>}
            </div>
          )}

          {/* Session Controls */}
          {!effectiveSessionId ? (
            <div className="space-y-3">
              <Button
                className="w-full"
                onClick={handleStartSession}
                data-testid="canvas-collab-start-session"
              >
                <Share2 className="h-4 w-4 mr-2" />
                {t("startSession")}
              </Button>

              <Separator />

              <div className="space-y-2">
                <label className="text-sm font-medium">{t("joinExisting")}</label>
                <div className="flex gap-2">
                  <Input
                    value={joinSessionId}
                    onChange={(e) => setJoinSessionId(e.target.value)}
                    placeholder={t("sessionIdPlaceholder")}
                    className="flex-1"
                    data-testid="canvas-collab-session-input"
                  />
                  <Button
                    variant="outline"
                    onClick={handleJoinSession}
                    disabled={!joinSessionId.trim()}
                    data-testid="canvas-collab-join-button"
                  >
                    <UserPlus className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {showLiveSessionControls && (
                <div className="flex gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline" className="flex-1" onClick={handleCopyShareLink}>
                        {copied ? (
                          <Check className="h-4 w-4 mr-2 text-success" />
                        ) : (
                          <Link2 className="h-4 w-4 mr-2" />
                        )}
                        {copied ? t("copied") : t("copyLink")}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("copyShareLink")}</TooltipContent>
                  </Tooltip>
                  <Button variant="destructive" onClick={handleEndSession}>
                    {t("endSession")}
                  </Button>
                </div>
              )}

              {showRecoveryActions && (
                <div className="flex gap-2">
                  {canReconnect && (
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={() => void handleReconnectSession()}
                    >
                      {t("reconnect")}
                    </Button>
                  )}
                  {canContinueLocally && (
                    <Button
                      variant="secondary"
                      className="flex-1"
                      onClick={handleContinueLocalEditing}
                    >
                      {t("continueLocally")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          {copyError && (
            <p className="text-xs text-destructive" data-testid="canvas-collab-copy-error">
              {copyError}
            </p>
          )}

          {(effectiveConnectionState === "error" ||
            effectiveConnectionState === "disconnected" ||
            effectiveConnectionState === "degraded-local" ||
            effectiveConnectionState === "ended") && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="canvas-collab-fallback-message"
            >
              {recoveryReason || t("collabFallbackMessage")}
            </p>
          )}

          <Separator />

          {/* Participants List */}
          <div className="space-y-2">
            <h4 className="text-sm font-medium flex items-center gap-2">
              <Users className="h-4 w-4" />
              {t("participants")} ({effectiveParticipants.length})
            </h4>
            <ScrollArea className="h-[200px]">
              <div className="space-y-2">
                {effectiveParticipants.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    {t("noParticipants")}
                  </p>
                ) : (
                  effectiveParticipants.map((participant) => (
                    <ParticipantItem
                      key={participant.id}
                      participant={participant}
                      showAvatar={showAvatars}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

interface ParticipantItemProps {
  participant: Participant
  /** `collaboration.showAvatars`. The row still lists the person either way. */
  showAvatar: boolean
}

function ParticipantItem({ participant, showAvatar }: ParticipantItemProps) {
  const t = useTranslations("canvas")
  const initials = participant.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2)

  return (
    <div className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50">
      {showAvatar ? (
        <Avatar className="h-8 w-8">
          <AvatarFallback
            style={{ backgroundColor: participant.color }}
            className="text-white text-xs"
          >
            {initials}
          </AvatarFallback>
        </Avatar>
      ) : (
        // The person is still listed, and still keeps their colour: turning
        // avatars off asks for a quieter list, not for anonymous rows.
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: participant.color }}
        />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{participant.name}</p>
        <p className="text-xs text-muted-foreground">
          {participant.isOnline ? (
            <span className="flex items-center gap-1">
              <Circle className="h-2 w-2 fill-success text-success" />
              {t("online")}
            </span>
          ) : (
            t("offline")
          )}
        </p>
      </div>
    </div>
  )
}
