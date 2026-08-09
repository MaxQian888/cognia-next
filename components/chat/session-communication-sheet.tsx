"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import type {
  AttachedSessionStatus,
  AttachedSessionContextMode,
  ChatSession,
  CrossSessionInboundPolicy,
} from "@cognia/agent-config-types"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  closeAttachedSession,
  createAttachedSession,
  interruptAttachedSession,
  listAttachedSessions,
} from "@/lib/chat/attached-session"
import {
  decideHeldSessionPeerMessage,
  drainSessionPeerMessages,
  listReachableSessions,
  sendSessionPeerMessage,
} from "@/lib/chat/session-peer-messaging"
import {
  expireSessionPeerMessages,
  listSessionInbox,
  listSessionOutbox,
  type SessionPeerMessageIntent,
  type SessionPeerMessageStatus,
} from "@/lib/db/session-peer-messages"
import { listSessions, updateSession } from "@/lib/db/sessions"
import { closeSession, interruptSession } from "@/lib/claude/ipc"
import { revealSpawnedTask } from "@/lib/tasks/spawn-task-dispatch"
import { useChatStore } from "@/stores/chat"

interface Props {
  session: ChatSession
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SessionCommunicationSheet({ session, open, onOpenChange }: Props) {
  const t = useTranslations("chat.sessionCommunication")
  const openSessionIds = useChatStore((state) => state.openSessionIds)
  const liveKey = openSessionIds.join(":")
  const attached = useLiveQuery(() => listAttachedSessions(session.id), [session.id]) ?? []
  const reachableRows = useLiveQuery(() => listReachableSessions(session.id), [session.id, liveKey])
  const reachable = useMemo(() => reachableRows ?? [], [reachableRows])
  const inbox = useLiveQuery(() => listSessionInbox(session.id), [session.id]) ?? []
  const outbox = useLiveQuery(() => listSessionOutbox(session.id), [session.id]) ?? []
  const allSessionRows = useLiveQuery(() => listSessions(), [])
  const allSessions = useMemo(() => allSessionRows ?? [], [allSessionRows])
  const sessionNames = useMemo(
    () => new Map(allSessions.map((candidate) => [candidate.id, candidate.title])),
    [allSessions]
  )

  const [title, setTitle] = useState("")
  const [prompt, setPrompt] = useState("")
  const [contextMode, setContextMode] = useState<AttachedSessionContextMode["mode"]>("none")
  const [turns, setTurns] = useState(8)
  const [workspace, setWorkspace] = useState<"shared" | "independent">("shared")
  const [creating, setCreating] = useState(false)
  const [policy, setPolicy] = useState<CrossSessionInboundPolicy>(
    session.crossSessionInboundPolicy ?? "hold"
  )
  const [targetId, setTargetId] = useState("")
  const [peerText, setPeerText] = useState("")
  const [intent, setIntent] = useState<SessionPeerMessageIntent>("trigger_turn")
  const [sending, setSending] = useState(false)
  const validTargetId = reachable.some((candidate) => candidate.id === targetId) ? targetId : ""

  const attachedStatusLabel = (status: AttachedSessionStatus) => {
    switch (status) {
      case "staged":
        return t("attachedStatus.staged")
      case "running":
        return t("attachedStatus.running")
      case "completed":
        return t("attachedStatus.completed")
      case "interrupted":
        return t("attachedStatus.interrupted")
      case "closed":
        return t("attachedStatus.closed")
    }
  }

  const messageStatusLabel = (status: SessionPeerMessageStatus) => {
    switch (status) {
      case "queued":
        return t("messageStatus.queued")
      case "held":
        return t("messageStatus.held")
      case "delivered":
        return t("messageStatus.delivered")
      case "refused":
        return t("messageStatus.refused")
      case "expired":
        return t("messageStatus.expired")
      case "target_unavailable":
        return t("messageStatus.targetUnavailable")
    }
  }

  useEffect(() => {
    if (!open) return
    void expireSessionPeerMessages().catch(() => undefined)
  }, [open])

  const createChild = async () => {
    const nextTitle = title.trim()
    const nextPrompt = prompt.trim()
    if (!nextTitle || !nextPrompt) return
    setCreating(true)
    try {
      const context: AttachedSessionContextMode =
        contextMode === "last-n" ? { mode: "last-n", turns } : { mode: contextMode }
      const child = await createAttachedSession({
        parentSessionId: session.id,
        title: nextTitle,
        prompt: nextPrompt,
        context,
        workspace,
      })
      revealSpawnedTask(session.id, child.id)
      setTitle("")
      setPrompt("")
      toast.success(t("attachedCreated"))
    } catch {
      toast.error(t("attachedCreateError"))
    } finally {
      setCreating(false)
    }
  }

  const changePolicy = async (next: CrossSessionInboundPolicy) => {
    setPolicy(next)
    try {
      await updateSession(session.id, { crossSessionInboundPolicy: next })
      if (next === "accept") await drainSessionPeerMessages(session.id)
    } catch {
      setPolicy(session.crossSessionInboundPolicy ?? "hold")
      toast.error(t("policyUpdateError"))
    }
  }

  const sendPeer = async () => {
    const content = peerText.trim()
    if (!validTargetId || !content) return
    setSending(true)
    try {
      const receipt = await sendSessionPeerMessage({
        senderSessionId: session.id,
        receiverSessionId: validTargetId,
        content,
        intent,
        origin: "user",
      })
      setPeerText("")
      toast.success(t("sent", { status: messageStatusLabel(receipt.status) }))
    } catch {
      toast.error(t("sendError"))
    } finally {
      setSending(false)
    }
  }

  const stopChild = async (childId: string) => {
    await interruptSession(childId).catch(() => undefined)
    await interruptAttachedSession(childId, session.id).catch(() => undefined)
  }

  const closeChild = async (childId: string) => {
    await closeSession(childId).catch(() => undefined)
    await closeAttachedSession(childId, session.id).catch(() => undefined)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>
        <Tabs defaultValue="attached" className="min-h-0 flex-1 px-4 pb-4">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="attached">{t("attachedTab")}</TabsTrigger>
            <TabsTrigger value="peer">{t("peerTab")}</TabsTrigger>
          </TabsList>

          <TabsContent value="attached" className="min-h-0 space-y-4 pt-2">
            <div className="grid gap-3 rounded-lg border p-3">
              <div className="grid gap-1.5">
                <Label htmlFor="attached-title">{t("attachedTitleLabel")}</Label>
                <Input
                  id="attached-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="attached-prompt">{t("attachedPromptLabel")}</Label>
                <Textarea
                  id="attached-prompt"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="attached-context">{t("contextLabel")}</Label>
                  <NativeSelect
                    id="attached-context"
                    className="w-full"
                    value={contextMode}
                    onChange={(event) =>
                      setContextMode(event.target.value as AttachedSessionContextMode["mode"])
                    }
                  >
                    <NativeSelectOption value="none">{t("contextNone")}</NativeSelectOption>
                    <NativeSelectOption value="last-n">{t("contextLastN")}</NativeSelectOption>
                    <NativeSelectOption value="full">{t("contextFull")}</NativeSelectOption>
                  </NativeSelect>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="attached-workspace">{t("workspaceLabel")}</Label>
                  <NativeSelect
                    id="attached-workspace"
                    className="w-full"
                    value={workspace}
                    onChange={(event) =>
                      setWorkspace(event.target.value as "shared" | "independent")
                    }
                  >
                    <NativeSelectOption value="shared">{t("workspaceShared")}</NativeSelectOption>
                    <NativeSelectOption value="independent">
                      {t("workspaceIndependent")}
                    </NativeSelectOption>
                  </NativeSelect>
                </div>
              </div>
              {contextMode === "last-n" ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="attached-turns">{t("turnsLabel")}</Label>
                  <Input
                    id="attached-turns"
                    type="number"
                    min={1}
                    max={100}
                    value={turns}
                    onChange={(event) =>
                      setTurns(Math.min(100, Math.max(1, Number(event.target.value) || 1)))
                    }
                  />
                </div>
              ) : null}
              <Button
                type="button"
                disabled={creating || !title.trim() || !prompt.trim()}
                onClick={() => void createChild()}
              >
                {t("createAttached")}
              </Button>
            </div>

            <ScrollArea className="h-[calc(100vh-28rem)] min-h-48">
              <div className="space-y-2 pr-3">
                {attached.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("noAttached")}</p>
                ) : (
                  attached.map((child) => (
                    <div key={child.id} className="space-y-2 rounded-lg border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{child.title}</span>
                        {child.attachedChild ? (
                          <Badge variant="outline">
                            {attachedStatusLabel(child.attachedChild.status)}
                          </Badge>
                        ) : null}
                      </div>
                      {child.attachedChild?.result ? (
                        <p className="line-clamp-3 text-xs text-muted-foreground">
                          {t("resultLabel")}: {child.attachedChild.result.summary}
                        </p>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => revealSpawnedTask(session.id, child.id)}
                        >
                          {t("openAttached")}
                        </Button>
                        {child.attachedChild?.status === "running" ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void stopChild(child.id)}
                          >
                            {t("interruptAttached")}
                          </Button>
                        ) : null}
                        {child.attachedChild?.status !== "closed" ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => void closeChild(child.id)}
                          >
                            {t("closeAttached")}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="peer" className="min-h-0 space-y-4 pt-2">
            <div className="grid gap-3 rounded-lg border p-3">
              <div className="grid gap-1.5">
                <Label htmlFor="peer-policy">{t("policyLabel")}</Label>
                <NativeSelect
                  id="peer-policy"
                  className="w-full"
                  value={policy}
                  onChange={(event) =>
                    void changePolicy(event.target.value as CrossSessionInboundPolicy)
                  }
                >
                  <NativeSelectOption value="accept">{t("policyAccept")}</NativeSelectOption>
                  <NativeSelectOption value="hold">{t("policyHold")}</NativeSelectOption>
                  <NativeSelectOption value="refuse">{t("policyRefuse")}</NativeSelectOption>
                </NativeSelect>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="peer-target">{t("targetLabel")}</Label>
                  <NativeSelect
                    id="peer-target"
                    className="w-full"
                    value={validTargetId}
                    onChange={(event) => setTargetId(event.target.value)}
                  >
                    <NativeSelectOption value="">{t("targetPlaceholder")}</NativeSelectOption>
                    {reachable.map((candidate) => (
                      <NativeSelectOption key={candidate.id} value={candidate.id}>
                        {candidate.title}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="peer-intent">{t("intentLabel")}</Label>
                  <NativeSelect
                    id="peer-intent"
                    className="w-full"
                    value={intent}
                    onChange={(event) => setIntent(event.target.value as SessionPeerMessageIntent)}
                  >
                    <NativeSelectOption value="note">{t("intentNote")}</NativeSelectOption>
                    <NativeSelectOption value="trigger_turn">
                      {t("intentTrigger")}
                    </NativeSelectOption>
                  </NativeSelect>
                </div>
              </div>
              {reachable.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("noReachable")}</p>
              ) : null}
              <div className="grid gap-1.5">
                <Label htmlFor="peer-message">{t("messageLabel")}</Label>
                <Textarea
                  id="peer-message"
                  value={peerText}
                  onChange={(event) => setPeerText(event.target.value)}
                />
              </div>
              <Button
                type="button"
                disabled={sending || !validTargetId || !peerText.trim()}
                onClick={() => void sendPeer()}
              >
                {t("send")}
              </Button>
            </div>

            <ScrollArea className="h-[calc(100vh-30rem)] min-h-44">
              <div className="space-y-4 pr-3">
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">{t("inboxTitle")}</h3>
                  {inbox.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("noInbox")}</p>
                  ) : (
                    inbox.map((row) => (
                      <div key={row.id} className="space-y-2 rounded-md border p-2 text-xs">
                        <div className="flex justify-between gap-2 text-muted-foreground">
                          <span>
                            {t("from", {
                              name: sessionNames.get(row.senderSessionId) ?? row.senderSessionId,
                            })}
                          </span>
                          <Badge variant="outline">{messageStatusLabel(row.status)}</Badge>
                        </div>
                        <p className="whitespace-pre-wrap">{row.content}</p>
                        {row.status === "held" ? (
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              size="sm"
                              onClick={() =>
                                void decideHeldSessionPeerMessage(row.id, "accept", session.id)
                              }
                            >
                              {t("acceptHeld")}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                void decideHeldSessionPeerMessage(row.id, "refuse", session.id)
                              }
                            >
                              {t("refuseHeld")}
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    ))
                  )}
                </section>
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">{t("outboxTitle")}</h3>
                  {outbox.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("noOutbox")}</p>
                  ) : (
                    outbox.map((row) => (
                      <div
                        key={row.id}
                        className="flex justify-between gap-2 rounded-md border p-2 text-xs"
                      >
                        <span className="line-clamp-2">{row.content}</span>
                        <Badge variant="outline">{messageStatusLabel(row.status)}</Badge>
                      </div>
                    ))
                  )}
                </section>
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}
