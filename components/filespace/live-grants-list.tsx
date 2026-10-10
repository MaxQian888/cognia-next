"use client"

/**
 * Live shares as a list with their controls (ADR-0222 §7.5): what each
 * shares, how, until when, and who signs in with it; suspend, resume,
 * revoke, issue a new password, and read its activity.
 *
 * One conversation's shares in its Files panel, every share on the host in
 * Settings. The host does every change; the list reloads from it afterwards
 * rather than guessing the result.
 */

import { useState } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { toast } from "sonner"
import { MoreHorizontalIcon } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  fileShareErrorDetails,
  resumeLiveGrant,
  revokeLiveGrant,
  rotateLiveCredential,
  suspendLiveGrant,
  type FileShareTarget,
} from "@/lib/filespace/grants-client"
import type { Transport } from "@/lib/tauri/transport-types"
import type {
  FileShareStatus,
  IssuedLiveCredential,
  LiveCredential,
  LiveEndpoints,
  LiveGrantView,
} from "@/types/filespace/live"

import { LiveShareAudit } from "./live-share-audit"
import { LiveShareCredentials } from "./live-share-credentials"

const STATUS_VARIANT = {
  active: "secondary",
  suspended: "outline",
  stale: "destructive",
  expired: "outline",
  revoked: "outline",
} as const

const KNOWN_REASONS = [
  "owner",
  "policy",
  "session_archived",
  "session_deleted",
  "mount_changed",
  "expired",
  "revoked",
  "provider_failed",
] as const

export interface LiveGrantsListProps {
  grants: LiveGrantView[]
  /** For each provider's endpoints when a password is reissued. */
  status: FileShareStatus | null
  hostId?: string
  /** Must be stable across renders. */
  transport?: Transport
  /** Name each share's conversation (the host-wide list). */
  showConversation?: boolean
  /** The host changed something; read it again. */
  onChanged: () => void
}

type Action = "suspend" | "resume" | "revoke"

/** The endpoints a credential of this provider dials, from the host's status. */
export function endpointsForProvider(
  status: FileShareStatus | null,
  provider: LiveGrantView["grant"]["provider"]
): LiveEndpoints | null {
  if (!status) return null
  return provider === "sftpgo" ? status.sftpgo.endpoints : status.listener.endpoints
}

export function LiveGrantsList({
  grants,
  status,
  hostId,
  transport,
  showConversation = false,
  onChanged,
}: LiveGrantsListProps) {
  const t = useTranslations("liveShare")
  const target: FileShareTarget = transport ? { transport } : { hostId }
  const [busy, setBusy] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<LiveGrantView | null>(null)
  const [rotated, setRotated] = useState<{
    issued: IssuedLiveCredential
    endpoints: LiveEndpoints | null
  } | null>(null)
  const [auditOf, setAuditOf] = useState<LiveGrantView | null>(null)

  const fail = (error: unknown) => {
    const { code, message } = fileShareErrorDetails(error)
    toast.error(t(`errors.${code}`, { message }))
  }

  const act = async (view: LiveGrantView, action: Action) => {
    setBusy(view.grant.id)
    const run = { suspend: suspendLiveGrant, resume: resumeLiveGrant, revoke: revokeLiveGrant }[
      action
    ]
    const done = { suspend: "suspended", resume: "resumed", revoke: "revoked" }[action]
    try {
      await run(view.grant.id, target)
      toast.success(t(`grants.toast.${done}`))
    } catch (error) {
      fail(error)
    } finally {
      setBusy(null)
      onChanged()
    }
  }

  const rotate = async (view: LiveGrantView, credential: LiveCredential) => {
    setBusy(view.grant.id)
    try {
      const issued = await rotateLiveCredential(credential.id, target)
      setRotated({ issued, endpoints: endpointsForProvider(status, view.grant.provider) })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(null)
      onChanged()
    }
  }

  if (grants.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("grants.empty")}</p>
  }

  return (
    <>
      <ul className="space-y-2" data-testid="live-grants-list">
        {grants.map((view) => (
          <GrantRow
            key={view.grant.id}
            view={view}
            busy={busy === view.grant.id}
            showConversation={showConversation}
            onAction={(action) =>
              action === "revoke" ? setRevoking(view) : void act(view, action)
            }
            onRotate={(credential) => void rotate(view, credential)}
            onAudit={() => setAuditOf(view)}
          />
        ))}
      </ul>

      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("grants.revokeConfirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("grants.revokeConfirm.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("dialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (revoking) void act(revoking, "revoke")
                setRevoking(null)
              }}
            >
              {t("grants.revokeConfirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={rotated !== null} onOpenChange={(open) => !open && setRotated(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          {rotated ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {t("grants.rotate.title", { username: rotated.issued.credential.username })}
                </DialogTitle>
                <DialogDescription>{t("grants.rotate.description")}</DialogDescription>
              </DialogHeader>
              <LiveShareCredentials
                credentials={[rotated.issued]}
                endpoints={
                  rotated.endpoints ?? {
                    webdavUrls: [],
                    sftp: [],
                    sftpHostKeyFingerprint: null,
                    tlsFingerprint: null,
                    unavailableReason: null,
                  }
                }
              />
              <DialogFooter>
                <Button type="button" onClick={() => setRotated(null)}>
                  {t("dialog.done")}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Sheet open={auditOf !== null} onOpenChange={(open) => !open && setAuditOf(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>
              {t("audit.title")}
              {auditOf ? ` · ${auditOf.grant.label ?? t("grants.untitled")}` : ""}
            </SheetTitle>
            <SheetDescription>{t("audit.description")}</SheetDescription>
          </SheetHeader>
          {auditOf ? (
            <div className="px-4 pb-4">
              <LiveShareAudit
                grantId={auditOf.grant.id}
                {...(transport ? { transport } : { hostId })}
              />
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  )
}

function GrantRow({
  view,
  busy,
  showConversation,
  onAction,
  onRotate,
  onAudit,
}: {
  view: LiveGrantView
  busy: boolean
  showConversation: boolean
  onAction: (action: Action) => void
  onRotate: (credential: LiveCredential) => void
  onAudit: () => void
}) {
  const t = useTranslations("liveShare")
  const tp = useTranslations("liveShare.dialog.permission")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const { grant, credentials } = view
  const label = grant.label ?? t("grants.untitled")
  const ended = grant.status === "revoked" || grant.status === "expired"
  const reason = grant.statusReason
  const liveCredentials = credentials.filter((credential) => credential.revokedAt === null)

  return (
    <li className="space-y-1 rounded-md border px-3 py-2" data-testid={`live-grant-${grant.id}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{label}</span>
            <Badge variant={STATUS_VARIANT[grant.status]} className="text-[10px]">
              {t(`grants.status.${grant.status}`)}
            </Badge>
            {grant.protocols.map((protocol) => (
              <Badge key={protocol} variant="outline" className="text-[10px]">
                {t(`credentials.protocol.${protocol}`)}
              </Badge>
            ))}
            {grant.provider === "sftpgo" ? (
              <Badge variant="outline" className="text-[10px]">
                {t("dialog.provider.sftpgo")}
              </Badge>
            ) : null}
          </div>
          {showConversation ? (
            <p className="text-[11px] text-muted-foreground">
              {t("grants.conversation", { id: grant.sessionId })}
            </p>
          ) : null}
          <p
            className="truncate font-mono text-[11px] text-muted-foreground"
            title={grant.paths.map((path) => path.virtualPath).join("\n")}
          >
            {grant.paths.map((path) => path.virtualPath).join(", ")}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {[
              tp("read"),
              ...(grant.permissions.includes("download") ? [tp("download")] : []),
              ...(grant.permissions.includes("write") ? [tp("write")] : []),
            ].join(" · ")}
            {" · "}
            {t(grant.expiresAt <= now.getTime() ? "grants.expired" : "grants.expires", {
              when: format.relativeTime(new Date(grant.expiresAt), now),
            })}
          </p>
          {reason && grant.status !== "active" ? (
            <p className="text-[11px] text-muted-foreground" data-testid="live-grant-reason">
              {(KNOWN_REASONS as readonly string[]).includes(reason)
                ? t(`grants.reason.${reason}`)
                : reason}
            </p>
          ) : null}
          {liveCredentials.length > 0 && !ended ? (
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {liveCredentials.map((credential) => credential.username).join(", ")}
            </p>
          ) : null}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              disabled={busy}
              aria-label={t("grants.actions.menu", { label })}
            >
              <MoreHorizontalIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {grant.status === "active" ? (
              <DropdownMenuItem onSelect={() => onAction("suspend")}>
                {t("grants.actions.suspend")}
              </DropdownMenuItem>
            ) : null}
            {grant.status === "suspended" || grant.status === "stale" ? (
              <DropdownMenuItem onSelect={() => onAction("resume")}>
                {t("grants.actions.resume")}
              </DropdownMenuItem>
            ) : null}
            {!ended
              ? liveCredentials.map((credential) => (
                  <DropdownMenuItem key={credential.id} onSelect={() => onRotate(credential)}>
                    {t("grants.actions.rotateFor", {
                      protocol: t(`credentials.protocol.${credential.protocol}`),
                    })}
                  </DropdownMenuItem>
                ))
              : null}
            <DropdownMenuItem onSelect={onAudit}>{t("grants.actions.audit")}</DropdownMenuItem>
            {!ended ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => onAction("revoke")}>
                  {t("grants.actions.revoke")}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}
