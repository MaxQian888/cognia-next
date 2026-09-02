"use client"

/**
 * The org's membership audit, for its owners and admins.
 *
 * Every write the roster makes lands here with the reason the writer gave,
 * which is the point of asking for one. Read live from the server on demand,
 * like the invitation list: nothing mirrors it, and an audit that could be
 * stale would not be worth reading.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { HistoryIcon, RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  membershipFailureMessage,
  toMembershipAdminFailure,
  type MembershipAdminFailure,
  type MembershipAdminState,
} from "@/hooks/workspace/use-membership-admin"

import type { CollabMembershipAuditEvent } from "@/lib/collab/client"

const AUDIT_LIMIT = 50

export interface WorkspaceMembershipAuditProps {
  admin: Pick<MembershipAdminState, "status" | "canManageOrg" | "context">
  /** Bump to reload after a write. */
  reloadKey?: number
}

export function WorkspaceMembershipAudit({ admin, reloadKey = 0 }: WorkspaceMembershipAuditProps) {
  const t = useTranslations("workspace.members")
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<CollabMembershipAuditEvent[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<MembershipAdminFailure | null>(null)

  const contextRef = useRef(admin.context)
  useEffect(() => {
    contextRef.current = admin.context
  })

  const load = useCallback(async () => {
    const context = contextRef.current
    if (!context) return
    setLoading(true)
    setError(null)
    try {
      setRows(await context.client.listAuthorizationAudit(context.orgId, AUDIT_LIMIT))
    } catch (cause) {
      setError(toMembershipAdminFailure(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    queueMicrotask(() => void load())
  }, [open, reloadKey, load])

  if (admin.status !== "ready" || !admin.canManageOrg || !admin.context) return null

  return (
    <section className="flex flex-col gap-1.5" data-testid="workspace-membership-audit">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="-ml-2 h-7 text-xs"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          data-testid="workspace-membership-audit-toggle"
        >
          <HistoryIcon aria-hidden className="size-3.5" />
          {t(open ? "audit.hide" : "audit.show")}
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
            data-testid="workspace-membership-audit-reload"
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
            data-testid="workspace-membership-audit-error"
          >
            {t(membershipFailureMessage(error).key, membershipFailureMessage(error).values)}
          </p>
        ) : rows === null ? (
          <p className="text-xs text-muted-foreground">{t("audit.loading")}</p>
        ) : rows.length === 0 ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="workspace-membership-audit-empty"
          >
            {t("audit.empty")}
          </p>
        ) : (
          <ol className="flex flex-col gap-1">
            {rows.map((event) => (
              <li
                key={event.id}
                className="flex flex-col gap-0.5 text-xs"
                data-testid={`workspace-membership-audit-${event.id}`}
              >
                <span className="flex flex-wrap items-center gap-x-2">
                  <span className="font-medium">{event.action}</span>
                  {event.targetUserId ? (
                    <span className="truncate font-mono text-[11px]">{event.targetUserId}</span>
                  ) : null}
                  {event.oldRole || event.newRole ? (
                    <span className="text-muted-foreground">
                      {t("audit.roleChange", {
                        from: event.oldRole ?? "",
                        to: event.newRole ?? "",
                      })}
                    </span>
                  ) : null}
                  <span className="ml-auto text-muted-foreground">
                    {new Date(event.createdAt).toLocaleString()}
                  </span>
                </span>
                <span className="truncate text-muted-foreground">
                  {event.reason}
                  {"  "}
                  {t("audit.actor", { who: event.actorUserId })}
                </span>
              </li>
            ))}
          </ol>
        )
      ) : null}
    </section>
  )
}

export default WorkspaceMembershipAudit
