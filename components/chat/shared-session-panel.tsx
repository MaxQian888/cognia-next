"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { liveQuery } from "dexie"
import { useLiveQuery } from "dexie-react-hooks"
import { CheckIcon, CopyIcon, LockIcon, Share2Icon, UsersIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type {
  ApprovalRequest,
  AuthorizationAuditEvent,
  ChatSession,
  RunLease,
  RunQueueItem,
  SessionInvite,
  SessionEvent,
  SessionMembership,
  SessionRole,
  SharedSession,
} from "@cognia/agent-config-types"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Surface } from "@/components/surface/surface"
import { authorizeSessionAction } from "@/lib/collab/session-permissions"
import { convertLocalSessionToShared } from "@/lib/collab/shared-chat-conversion"
import { isSharedChatClientEnabled } from "@/lib/collab/shared-chat-feature"
import { resolveCurrentCollabContext, type CurrentCollabContext } from "@/lib/collab/runtime-client"
import { syncSharedSession, sharedChatCacheKey } from "@/lib/collab/shared-chat-sync"
import { getDb } from "@/lib/db/schema"
import { deleteSession } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat"

const ROLES: SessionRole[] = ["viewer", "member", "maintainer", "owner"]

interface Props {
  session: ChatSession
}

interface HistorySummary {
  messages: number
  attachments: number
}

export function SharedSessionPanel({ session }: Props) {
  const t = useTranslations("chatCollaboration")
  const [loadedAt, setLoadedAt] = useState(0)
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [context, setContext] = useState<CurrentCollabContext | null>(null)
  const [remote, setRemote] = useState<SharedSession | null>(null)
  const [members, setMembers] = useState<SessionMembership[]>([])
  const [invites, setInvites] = useState<SessionInvite[]>([])
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [activeLease, setActiveLease] = useState<RunLease | null>(null)
  const [queue, setQueue] = useState<RunQueueItem[]>([])
  const [audit, setAudit] = useState<AuthorizationAuditEvent[]>([])
  const [isOrgAdmin, setIsOrgAdmin] = useState(false)
  const [breakGlassReason, setBreakGlassReason] = useState("")
  const [breakGlassEvents, setBreakGlassEvents] = useState<SessionEvent[]>([])
  const [summary, setSummary] = useState<HistorySummary>({ messages: 0, attachments: 0 })
  const [inviteUserId, setInviteUserId] = useState("")
  const [inviteRole, setInviteRole] = useState<Exclude<SessionRole, "owner">>("member")
  const [inviteGuest, setInviteGuest] = useState(false)
  const [lastInviteToken, setLastInviteToken] = useState<string | null>(null)
  const [receivedInviteToken, setReceivedInviteToken] = useState("")
  const syncKey = session.collaboration
    ? sharedChatCacheKey(
        session.collaboration.orgId,
        session.collaboration.sessionId,
        session.collaboration.endpoint
      )
    : null
  const syncState = useLiveQuery(
    () => (syncKey ? getDb().collabChatSyncStates.get(syncKey) : undefined),
    [syncKey]
  )
  const latestUserMessage = useLiveQuery(async () => {
    if (!session.collaboration) return undefined
    const messages = await getDb().messages.where("sessionId").equals(session.id).toArray()
    return messages
      .filter(
        (message) =>
          message.role === "user" && message.collaboration && !message.collaboration.redactedAt
      )
      .sort(
        (a, b) =>
          (b.collaboration?.eventSequence ?? 0) - (a.collaboration?.eventSequence ?? 0) ||
          b.createdAt - a.createdAt
      )[0]
  }, [session.id, Boolean(session.collaboration)])

  const requestAI = (takeover = false) => {
    if (!latestUserMessage || !navigator.onLine) return
    window.dispatchEvent(
      new CustomEvent("cognia:shared-request-ai", {
        detail: { sessionId: session.id, messageId: latestUserMessage.id, takeover },
      })
    )
  }

  const myMembership = useMemo(
    () => members.find((member) => member.userId === context?.userId) ?? null,
    [context?.userId, members]
  )
  const canManage = authorizeSessionAction(
    myMembership,
    "session.manageMembers",
    remote?.policyRevision ?? 0
  ).allowed
  const canDelete = authorizeSessionAction(
    myMembership,
    "session.delete",
    remote?.policyRevision ?? 0
  ).allowed

  const load = useCallback(
    async (background = false) => {
      if (!background) setLoading(true)
      try {
        const resolved = await resolveCurrentCollabContext()
        setLoadedAt(Date.now())
        if (
          !resolved ||
          (session.collaboration &&
            (resolved.orgId !== session.collaboration.orgId ||
              (session.collaboration.endpoint &&
                resolved.client.baseUrl !== session.collaboration.endpoint)))
        ) {
          setContext(null)
          return
        }
        setContext(resolved)
        if (!session.collaboration) {
          const rows = await getDb().messages.where("sessionId").equals(session.id).toArray()
          setSummary({
            messages: rows.length,
            attachments: rows.reduce(
              (count, message) =>
                count + message.parts.filter((part) => part.type === "file").length,
              0
            ),
          })
          return
        }
        const { orgId, sessionId } = session.collaboration
        const [nextRemote, nextMembers, nextApprovals, nextLease, nextQueue, standing] =
          await Promise.all([
            resolved.client.getSharedSession(orgId, sessionId),
            resolved.client.listSessionMembers(orgId, sessionId),
            resolved.client.listSessionApprovals(orgId, sessionId),
            resolved.client.getActiveSessionRunLease(orgId, sessionId),
            resolved.client.listSessionRunQueue(orgId, sessionId),
            resolved.client.myMemberships(orgId),
          ])
        setRemote(nextRemote)
        setMembers(nextMembers)
        const mine = nextMembers.find((member) => member.userId === resolved.userId) ?? null
        const mayManage = authorizeSessionAction(
          mine,
          "session.manageMembers",
          nextRemote.policyRevision
        ).allowed
        const mayAudit = authorizeSessionAction(
          mine,
          "session.auditMetadata",
          nextRemote.policyRevision
        ).allowed
        setInvites(mayManage ? await resolved.client.listSessionInvites(orgId, sessionId) : [])
        setApprovals(nextApprovals)
        setActiveLease(nextLease)
        setQueue(nextQueue)
        setAudit(
          mayAudit ? await resolved.client.listSessionAuthorizationAudit(orgId, sessionId) : []
        )
        setIsOrgAdmin(standing.orgRole === "owner" || standing.orgRole === "admin")
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("loadFailed"))
      } finally {
        if (!background) setLoading(false)
      }
    },
    [session, t]
  )
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  const cacheKey =
    session.collaboration && context
      ? sharedChatCacheKey(
          session.collaboration.orgId,
          session.collaboration.sessionId,
          context.client.baseUrl
        )
      : null
  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine)
    window.addEventListener("online", updateOnline)
    window.addEventListener("offline", updateOnline)
    return () => {
      window.removeEventListener("online", updateOnline)
      window.removeEventListener("offline", updateOnline)
    }
  }, [])

  useEffect(() => {
    if (!open || !cacheKey) return
    const sessionId = cacheKey
    const subscription = liveQuery(() => getDb().collabChatSyncStates.get(sessionId)).subscribe({
      next: () => {
        void loadRef.current(true)
      },
      error: (error) => console.warn("shared controls refresh unavailable", error),
    })
    return () => subscription.unsubscribe()
  }, [open, cacheKey])

  const revokeInvite = async (inviteId: string) => {
    if (!context || !session.collaboration) return
    try {
      await context.client.revokeSessionInvite(
        session.collaboration.orgId,
        session.collaboration.sessionId,
        inviteId
      )
      await load()
    } catch {
      toast.error(t("inviteFailed"))
    }
  }

  const leaveConversation = async () => {
    if (!context || !session.collaboration) return
    try {
      await context.client.removeSessionMember(
        session.collaboration.orgId,
        session.collaboration.sessionId,
        context.userId
      )
      await deleteSession(session.id)
      useChatStore.getState().closeSession(session.id)
      setOpen(false)
      toast.success(t("leftConversation"))
    } catch {
      toast.error(t("leaveFailed"))
    }
  }

  const shareHistory = async () => {
    if (!context || !session.projectId || !navigator.onLine) return
    setLoading(true)
    try {
      await convertLocalSessionToShared(context.client, {
        localSessionId: session.id,
        orgId: context.orgId,
        workspaceId: session.projectId,
      })
      toast.success(t("conversionComplete"))
      setOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("conversionFailed"))
    } finally {
      setLoading(false)
    }
  }

  const updateMember = async (
    member: SessionMembership,
    patch: { role?: SessionRole; approver?: boolean }
  ) => {
    if (!context || !session.collaboration) return
    try {
      await context.client.updateSessionMember(
        session.collaboration.orgId,
        session.collaboration.sessionId,
        member.userId,
        {
          role: patch.role ?? member.role,
          approver: patch.approver ?? member.approver,
          guest: member.guest,
        }
      )
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("updateFailed"))
    }
  }

  const removeMember = async (userId: string) => {
    if (!context || !session.collaboration) return
    try {
      await context.client.removeSessionMember(
        session.collaboration.orgId,
        session.collaboration.sessionId,
        userId
      )
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("updateFailed"))
    }
  }

  const createInvite = async () => {
    if (!context || !session.collaboration) return
    try {
      const created = await context.client.createSessionInvite(
        session.collaboration.orgId,
        session.collaboration.sessionId,
        {
          ...(inviteUserId.trim() ? { targetUserId: inviteUserId.trim() } : {}),
          role: inviteRole,
          guest: inviteGuest,
          expiresAt: Date.now() + 7 * 24 * 60 * 60_000,
        }
      )
      setLastInviteToken(created.token)
      setInviteUserId("")
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("inviteFailed"))
    }
  }

  const acceptInvite = async () => {
    const token = receivedInviteToken.trim()
    if (!context || !token || !navigator.onLine) return
    setLoading(true)
    try {
      const accepted = await context.client.acceptSessionInvite(context.orgId, token)
      const synced = await syncSharedSession(
        context.client,
        context.orgId,
        accepted.invite.sessionId
      )
      setReceivedInviteToken("")
      useChatStore.getState().setActiveSession(synced.localSessionId)
      toast.success(t("inviteAccepted"))
      setOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("inviteAcceptFailed"))
    } finally {
      setLoading(false)
    }
  }

  const resolveApproval = async (approval: ApprovalRequest, status: "approved" | "denied") => {
    if (!context || !session.collaboration) return
    try {
      await context.client.resolveSessionApproval(
        session.collaboration.orgId,
        session.collaboration.sessionId,
        approval.id,
        { status, baseRevision: approval.revision }
      )
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("approvalFailed"))
    }
  }

  const cancelQueueItem = async (itemId: string) => {
    if (!context || !session.collaboration) return
    try {
      await context.client.cancelSessionRunQueueItem(
        session.collaboration.orgId,
        session.collaboration.sessionId,
        itemId
      )
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("queueUpdateFailed"))
    }
  }

  const handleBreakGlass = async () => {
    if (!context || !session.collaboration || breakGlassReason.trim().length < 8) return
    try {
      const { orgId, sessionId } = session.collaboration
      const grant = await context.client.createSessionBreakGlassGrant(orgId, sessionId, {
        reason: breakGlassReason.trim(),
        durationMs: 15 * 60_000,
        operationId: `break-glass:${crypto.randomUUID()}`,
      })
      setBreakGlassEvents(
        await context.client.listSessionBreakGlassEvents(orgId, sessionId, grant.id)
      )
      setBreakGlassReason("")
      toast.success(t("breakGlassGranted"))
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("breakGlassFailed"))
    }
  }

  const deleteSharedConversation = async () => {
    if (!context || !session.collaboration || !remote) return
    try {
      await context.client.deleteSharedSession(
        session.collaboration.orgId,
        session.collaboration.sessionId,
        {
          operationId: `delete-session:${crypto.randomUUID()}`,
          baseRevision: remote.revision,
        }
      )
      await deleteSession(session.id)
      useChatStore.getState().closeSession(session.id)
      toast.success(t("deleteAccepted"))
      setOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("deleteFailed"))
    }
  }

  const isShared = Boolean(session.collaboration)
  const featureEnabled = isSharedChatClientEnabled()
  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!featureEnabled) return
        setOpen(nextOpen)
        if (nextOpen) void load()
      }}
    >
      {isShared && featureEnabled ? (
        <>
          <Badge variant={online && syncState?.connected ? "secondary" : "outline"} role="status">
            {online && syncState?.connected ? t("connected") : t("connectionStale")}
          </Badge>
          <Button
            variant="outline"
            size="sm"
            disabled={!online || !latestUserMessage}
            onClick={() => requestAI()}
          >
            {t("requestAI")}
          </Button>
        </>
      ) : null}
      <SheetTrigger asChild>
        {/* Icon-only. This trigger sits in the conversation header, which on
            desktop is projected into the title bar next to the workspace pill
            and the route history — and it was the one control there carrying a
            permanent text label. In the default state that label is the word
            for "nothing is shared", and with the collaboration client switched
            off it grew to a whole disabled sentence, so the bar's widest chunk
            of chrome was also its least informative. The lock / users icon
            already carries the state; the words moved to `title`, which is
            where every other control in that row keeps them. */}
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground"
          disabled={!featureEnabled}
          title={featureEnabled ? (isShared ? t("shared") : t("private")) : t("featureDisabled")}
          aria-label={
            featureEnabled
              ? isShared
                ? t("openSharedSession")
                : t("openPrivateSession")
              : t("featureDisabled")
          }
        >
          {isShared ? <UsersIcon className="size-3.5" /> : <LockIcon className="size-3.5" />}
        </Button>
      </SheetTrigger>
      <SheetContent className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{isShared ? t("sharedTitle") : t("privateTitle")}</SheetTitle>
          <SheetDescription>
            {isShared ? t("sharedDescription") : t("privateDescription")}
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1 px-4 pb-6">
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Spinner className="size-4" /> {t("loading")}
            </div>
          ) : !context ? (
            <p className="py-6 text-sm text-muted-foreground">{t("notConfigured")}</p>
          ) : !isShared ? (
            <div className="space-y-4 py-4">
              <Surface layer="raised" className="rounded-lg border p-3 text-sm">
                <p className="font-medium">{t("historyWarningTitle")}</p>
                <p className="mt-1 text-muted-foreground">
                  {t("historyWarning", {
                    messages: summary.messages,
                    attachments: summary.attachments,
                  })}
                </p>
              </Surface>
              <div className="space-y-2 rounded-lg border p-3">
                <Label htmlFor="shared-invite-token">{t("inviteToken")}</Label>
                <Input
                  id="shared-invite-token"
                  value={receivedInviteToken}
                  placeholder={t("inviteTokenPlaceholder")}
                  onChange={(event) => setReceivedInviteToken(event.target.value)}
                />
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={!online || !receivedInviteToken.trim()}
                  onClick={() => void acceptInvite()}
                >
                  {t("acceptInvite")}
                </Button>
              </div>
              {!online ? (
                <p className="text-sm text-destructive">{t("offlineConversion")}</p>
              ) : null}
              <Button className="w-full gap-2" disabled={loading || !online} onClick={shareHistory}>
                <Share2Icon className="size-4" /> {t("convertAndShare")}
              </Button>
            </div>
          ) : (
            <div className="space-y-6 py-4">
              <section className="space-y-3" aria-labelledby="shared-run-heading">
                <h3 id="shared-run-heading" className="text-sm font-semibold">
                  {t("runCoordination")}
                </h3>
                {activeLease ? (
                  <div className="rounded-lg border p-3 text-sm">
                    <div className="flex items-center gap-2">
                      <Badge>{t("running")}</Badge>
                      <span className="truncate">
                        {t("runHost", { user: activeLease.holderUserId })}
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("noActiveRun")}</p>
                )}
                {queue.length ? (
                  <div className="space-y-2">
                    {queue.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center gap-2 rounded-lg border p-2 text-sm"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {t("queuedBy", {
                            position: item.position,
                            user: item.requestedByUserId,
                          })}
                        </span>
                        {(item.requestedByUserId === context.userId || canManage) &&
                        item.status === "queued" ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void cancelQueueItem(item.id)}
                          >
                            {t("cancelQueued")}
                          </Button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                {myMembership &&
                myMembership.role !== "viewer" &&
                queue.some((item) => item.status === "queued") ? (
                  <Button
                    variant="outline"
                    disabled={!online || !latestUserMessage}
                    onClick={() => requestAI(true)}
                  >
                    {t("takeoverExecution")}
                  </Button>
                ) : null}
              </section>

              <section className="space-y-3" aria-labelledby="shared-members-heading">
                <h3 id="shared-members-heading" className="text-sm font-semibold">
                  {t("members", { count: members.length })}
                </h3>
                {members.map((member) => (
                  <div
                    key={member.userId}
                    className="flex items-center gap-2 rounded-lg border p-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        <span className="truncate">{member.displayName || member.userId}</span>
                        {member.guest ? <Badge variant="outline">{t("guest")}</Badge> : null}
                        {member.approver ? (
                          <Badge variant="secondary">{t("approver")}</Badge>
                        ) : null}
                      </div>
                    </div>
                    {canManage ? (
                      <>
                        <Select
                          value={member.role}
                          disabled={member.role === "owner" && myMembership?.role !== "owner"}
                          onValueChange={(value) =>
                            void updateMember(member, { role: value as SessionRole })
                          }
                        >
                          <SelectTrigger
                            size="sm"
                            aria-label={t("roleFor", { user: member.userId })}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ROLES.filter(
                              (role) =>
                                (myMembership?.role === "owner" || role !== "owner") &&
                                (!member.guest || role === "viewer" || role === "member")
                            ).map((role) => (
                              <SelectItem key={role} value={role}>
                                {t(`roles.${role}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Checkbox
                          checked={member.approver}
                          disabled={
                            member.guest || member.role === "owner" || member.role === "maintainer"
                          }
                          aria-label={t("toggleApprover", { user: member.userId })}
                          onCheckedChange={(checked) =>
                            void updateMember(member, { approver: checked === true })
                          }
                        />
                        {member.userId !== context.userId &&
                        (member.role !== "owner" || myMembership?.role === "owner") ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void removeMember(member.userId)}
                          >
                            {t("remove")}
                          </Button>
                        ) : null}
                      </>
                    ) : (
                      <Badge variant="outline">{t(`roles.${member.role}`)}</Badge>
                    )}
                  </div>
                ))}
              </section>

              {canManage ? (
                <section className="space-y-3" aria-labelledby="shared-invite-heading">
                  <h3 id="shared-invite-heading" className="text-sm font-semibold">
                    {t("invite")}
                  </h3>
                  <div className="space-y-2 rounded-lg border p-3">
                    <Label htmlFor="shared-invite-user">{t("userId")}</Label>
                    <Input
                      id="shared-invite-user"
                      value={inviteUserId}
                      placeholder={inviteGuest ? t("guestLinkPlaceholder") : t("userIdPlaceholder")}
                      onChange={(event) => setInviteUserId(event.target.value)}
                    />
                    <div className="flex items-center gap-2">
                      <Select
                        value={inviteRole}
                        onValueChange={(value) => setInviteRole(value as typeof inviteRole)}
                      >
                        <SelectTrigger className="flex-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(["viewer", "member", "maintainer"] as const)
                            .filter((role) => !inviteGuest || role !== "maintainer")
                            .map((role) => (
                              <SelectItem key={role} value={role}>
                                {t(`roles.${role}`)}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <Label className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={inviteGuest}
                          onCheckedChange={(value) => {
                            setInviteGuest(value === true)
                            if (value === true && inviteRole === "maintainer")
                              setInviteRole("member")
                          }}
                        />
                        {t("guest")}
                      </Label>
                    </div>
                    <Button
                      className="w-full"
                      disabled={!inviteGuest && !inviteUserId.trim()}
                      onClick={() => void createInvite()}
                    >
                      {t("createInvite")}
                    </Button>
                    {lastInviteToken ? (
                      <Button
                        variant="outline"
                        className="w-full gap-2"
                        onClick={() => {
                          void navigator.clipboard.writeText(lastInviteToken)
                          toast.success(t("inviteCopied"))
                        }}
                      >
                        <CopyIcon className="size-4" /> {t("copyInvite")}
                      </Button>
                    ) : null}
                    {invites
                      .filter((invite) => invite.status === "pending")
                      .map((invite) => (
                        <div key={invite.id} className="flex items-center gap-2 text-xs">
                          <span className="flex-1">{invite.targetUserId || t("guest")}</span>
                          <span>
                            {invite.expiresAt <= loadedAt
                              ? t("inviteExpired")
                              : t("inviteExpires", {
                                  date: new Date(invite.expiresAt).toLocaleString(),
                                })}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void revokeInvite(invite.id)}
                          >
                            {t("revokeInvite")}
                          </Button>
                        </div>
                      ))}
                    {invites.length ? (
                      <p className="text-xs text-muted-foreground">
                        {t("pendingInvites", {
                          count: invites.filter((invite) => invite.status === "pending").length,
                        })}
                      </p>
                    ) : null}
                  </div>
                </section>
              ) : null}

              <section className="space-y-3" aria-labelledby="shared-approvals-heading">
                <h3 id="shared-approvals-heading" className="text-sm font-semibold">
                  {t("approvals")}
                </h3>
                {approvals.filter((approval) => approval.status === "pending").length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("noPendingApprovals")}</p>
                ) : (
                  approvals
                    .filter((approval) => approval.status === "pending")
                    .map((approval) => {
                      const allowed = authorizeSessionAction(
                        myMembership,
                        approval.risk === "high" ? "run.approveHighRisk" : "run.approveOrdinary",
                        remote?.policyRevision ?? 0
                      ).allowed
                      return (
                        <div key={approval.id} className="rounded-lg border p-3 text-sm">
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate font-medium">
                              {approval.action}
                            </span>
                            <Badge variant={approval.risk === "high" ? "destructive" : "secondary"}>
                              {t(`risk.${approval.risk}`)}
                            </Badge>
                          </div>
                          {allowed ? (
                            <div className="mt-3 flex gap-2">
                              <Button
                                size="sm"
                                className="gap-1"
                                onClick={() => void resolveApproval(approval, "approved")}
                              >
                                <CheckIcon className="size-3.5" /> {t("approve")}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void resolveApproval(approval, "denied")}
                              >
                                {t("deny")}
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      )
                    })
                )}
              </section>

              {audit.length ? (
                <section className="space-y-3" aria-labelledby="shared-audit-heading">
                  <h3 id="shared-audit-heading" className="text-sm font-semibold">
                    {t("audit")}
                  </h3>
                  <div className="space-y-2">
                    {audit.slice(0, 20).map((event) => (
                      <div key={event.id} className="rounded-lg border p-2 text-xs">
                        <div className="flex items-center gap-2">
                          <Badge variant={event.allowed ? "secondary" : "destructive"}>
                            {event.allowed ? t("allowed") : t("denied")}
                          </Badge>
                          <span className="truncate font-medium">{event.action}</span>
                        </div>
                        <p className="mt-1 text-muted-foreground">
                          {t("auditActor", { user: event.actorUserId, reason: event.reason })}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {isOrgAdmin ? (
                <section className="space-y-3" aria-labelledby="shared-break-glass-heading">
                  <h3 id="shared-break-glass-heading" className="text-sm font-semibold">
                    {t("breakGlass")}
                  </h3>
                  <div className="space-y-2 rounded-lg border border-destructive/40 p-3">
                    <p className="text-xs text-muted-foreground">{t("breakGlassWarning")}</p>
                    <Label htmlFor="break-glass-reason">{t("breakGlassReason")}</Label>
                    <Input
                      id="break-glass-reason"
                      value={breakGlassReason}
                      onChange={(event) => setBreakGlassReason(event.target.value)}
                    />
                    <Button
                      variant="destructive"
                      className="w-full"
                      disabled={breakGlassReason.trim().length < 8}
                      onClick={() => void handleBreakGlass()}
                    >
                      {t("breakGlassAction")}
                    </Button>
                    {breakGlassEvents.length ? (
                      <div className="max-h-64 space-y-2 overflow-auto" aria-label={t("rawEvents")}>
                        {breakGlassEvents.map((event) => (
                          <pre
                            key={event.id}
                            className="whitespace-pre-wrap rounded bg-muted p-2 text-xs"
                          >
                            {JSON.stringify(event, null, 2)}
                          </pre>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </section>
              ) : null}

              {myMembership ? (
                <div className="space-y-2">
                  {myMembership.role === "owner" &&
                  members.filter((member) => member.role === "owner").length === 1 ? (
                    <p className="text-sm text-muted-foreground">{t("transferBeforeLeaving")}</p>
                  ) : null}
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={
                      myMembership.role === "owner" &&
                      members.filter((member) => member.role === "owner").length === 1
                    }
                    onClick={() => void leaveConversation()}
                  >
                    {t("leaveConversation")}
                  </Button>
                </div>
              ) : null}
              {canDelete ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" className="w-full">
                      {t("deleteConversation")}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
                      <AlertDialogDescription>{t("deleteWarning")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("cancelDelete")}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void deleteSharedConversation()}>
                        {t("confirmDelete")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
