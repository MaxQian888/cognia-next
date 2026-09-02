"use client"

/**
 * The org's invitations, read live from the collaboration server.
 *
 * # Not a mirror
 *
 * The roster beside this is a projection the sync pulls. Invitations are
 * not: they carry no local row, so this reads the server on demand, when the
 * section is opened and after each change, and says so when it cannot. A
 * stale invitation list would be worse than none, because the one thing
 * anybody opens it for is to pull a token back.
 *
 * # Who sees what
 *
 * The server narrows. An owner or admin gets every invitation the org has
 * minted, a maintainer only the ones they minted themselves, and this list
 * shows whatever came back without a second filter.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { MailIcon, RefreshCwIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  membershipFailureMessage,
  toMembershipAdminFailure,
  type MembershipAdminFailure,
  type MembershipAdminState,
} from "@/hooks/workspace/use-membership-admin"

import type { CollabInvitation } from "@/lib/collab/client"

export type InvitationStatus = "pending" | "redeemed" | "revoked" | "expired"

/** Redeemed and revoked are facts. Expired is a clock, so it takes `now`. */
export function invitationStatus(invitation: CollabInvitation, now: number): InvitationStatus {
  if (invitation.redeemedAt != null) return "redeemed"
  if (invitation.revokedAt != null) return "revoked"
  if (invitation.expiresAt <= now) return "expired"
  return "pending"
}

export interface WorkspaceInvitationsProps {
  admin: Pick<
    MembershipAdminState,
    "status" | "canManageWorkspace" | "busy" | "listInvitations" | "revokeInvitation"
  >
  /** Bump to reload, e.g. after the dialog mints one. */
  reloadKey?: number
  now?: () => number
}

export function WorkspaceInvitations({ admin, reloadKey = 0, now }: WorkspaceInvitationsProps) {
  const t = useTranslations("workspace.members")
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<CollabInvitation[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<MembershipAdminFailure | null>(null)
  const clock = now ?? Date.now

  // The hook hands out fresh closures on every render. Loading must not
  // follow their identity, or every render would be a request, so the load
  // reads the latest admin through a ref and depends on nothing.
  const adminRef = useRef(admin)
  useEffect(() => {
    adminRef.current = admin
  })

  const explain = (cause: unknown): string => {
    const { key, values } = membershipFailureMessage(toMembershipAdminFailure(cause))
    return t(key, values)
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setRows(await adminRef.current.listInvitations())
    } catch (cause) {
      setError(toMembershipAdminFailure(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  // A load is a request to the server, made when the section is open and
  // when something changed. Deferred out of the effect body, the same shape
  // the members hook uses.
  useEffect(() => {
    if (!open) return
    queueMicrotask(() => void load())
  }, [open, reloadKey, load])

  const revoke = async (invitation: CollabInvitation) => {
    try {
      await admin.revokeInvitation(invitation.id, t("reason.invitationRevoked"))
      toast.success(t("toast.invitationRevoked"))
      await load()
    } catch (cause) {
      toast.error(t("toast.failed"), { description: explain(cause) })
    }
  }

  if (admin.status !== "ready" || !admin.canManageWorkspace) return null

  return (
    <section className="flex flex-col gap-1.5" data-testid="workspace-invitations">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="-ml-2 h-7 text-xs"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          data-testid="workspace-invitations-toggle"
        >
          <MailIcon aria-hidden className="size-3.5" />
          {t(open ? "invitations.hide" : "invitations.show")}
        </Button>
        {open ? (
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-6"
            disabled={loading}
            title={t("invitations.reload")}
            aria-label={t("invitations.reload")}
            onClick={() => void load()}
            data-testid="workspace-invitations-reload"
          >
            <RefreshCwIcon aria-hidden className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
          </Button>
        ) : null}
      </div>

      {open ? (
        error ? (
          <p
            role="alert"
            className="text-xs text-destructive"
            data-testid="workspace-invitations-error"
          >
            {t(membershipFailureMessage(error).key, membershipFailureMessage(error).values)}
          </p>
        ) : rows === null ? (
          <p className="text-xs text-muted-foreground">{t("invitations.loading")}</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="workspace-invitations-empty">
            {t("invitations.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rows.map((invitation) => {
              const status = invitationStatus(invitation, clock())
              const scope = invitation.orgRole
                ? t("invitations.scopeOrg", { role: t(`orgRole.${invitation.orgRole}`) })
                : t("invitations.scopeWorkspace", {
                    role: t(`role.${invitation.workspaceRole ?? "viewer"}`),
                  })
              return (
                <li
                  key={invitation.id}
                  className="flex items-center gap-2 text-xs"
                  data-testid={`workspace-invitation-${invitation.id}`}
                  data-status={status}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {scope}
                    <span className="text-muted-foreground">
                      {" "}
                      {t("invitations.createdBy", { who: invitation.createdBy })}
                    </span>
                  </span>
                  <span className="text-muted-foreground">
                    {t("invitations.expires", {
                      date: new Date(invitation.expiresAt).toLocaleDateString(),
                    })}
                  </span>
                  <Badge variant={status === "pending" ? "secondary" : "outline"}>
                    {t(`invitations.status.${status}`)}
                  </Badge>
                  {status === "pending" ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="size-6"
                      disabled={admin.busy}
                      title={t("invitations.revoke")}
                      aria-label={t("invitations.revoke")}
                      onClick={() => void revoke(invitation)}
                      data-testid={`workspace-invitation-revoke-${invitation.id}`}
                    >
                      <XIcon aria-hidden className="size-3.5" />
                    </Button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )
      ) : null}
    </section>
  )
}

export default WorkspaceInvitations
