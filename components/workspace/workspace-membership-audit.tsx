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
import { useFormatter, useTranslations } from "next-intl"
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

/**
 * Every action the collaboration server writes to the audit, as the server
 * spells it (`crates/cognia-collab-server/src/store.rs`). Listed so the test
 * can hold both locales to a label for each; the renderer still falls back to
 * the raw value for one added server-side before the client learns it.
 */
export const MEMBERSHIP_AUDIT_ACTIONS = [
  "account.bootstrapped",
  "invitation.created",
  "invitation.redeemed",
  "invitation.revoked",
  "org.member.changed",
  "org.member.offboarded",
  "workspace.member.changed",
  "workspace.member.removed",
] as const

/**
 * The message key for a server action: `org.member.changed` → `orgMemberChanged`.
 *
 * Flattened because next-intl reads dots as nesting, so the raw value would
 * address a path rather than a message.
 */
export function auditActionKey(action: string): string {
  return action
    .split(/[._-]+/)
    .filter(Boolean)
    .map((word, index) => (index === 0 ? word : word[0]!.toUpperCase() + word.slice(1)))
    .join("")
}

export interface WorkspaceMembershipAuditProps {
  admin: Pick<MembershipAdminState, "status" | "canManageOrg" | "context">
  /** Bump to reload after a write. */
  reloadKey?: number
}

export function WorkspaceMembershipAudit({ admin, reloadKey = 0 }: WorkspaceMembershipAuditProps) {
  const t = useTranslations("workspace.members")
  const format = useFormatter()
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

  const actionLabel = (action: string): string => {
    const key = `audit.actions.${auditActionKey(action)}`
    return t.has(key) ? t(key) : action
  }
  // A workspace-scoped event carries workspace seats; everything else, an
  // org invitation, an org role change, the bootstrap claim, carries org roles.
  const roleLabel = (role: string | undefined, workspaceScoped: boolean): string => {
    if (!role) return ""
    const key = workspaceScoped ? `role.${role}` : `orgRole.${role}`
    return t.has(key) ? t(key) : role
  }

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
                  <span className="font-medium">{actionLabel(event.action)}</span>
                  {event.targetUserId ? (
                    <span className="truncate font-mono text-[11px]">{event.targetUserId}</span>
                  ) : null}
                  {event.oldRole || event.newRole ? (
                    <span className="text-muted-foreground">
                      {event.oldRole && event.newRole
                        ? t("audit.roleChange", {
                            from: roleLabel(event.oldRole, Boolean(event.workspaceId)),
                            to: roleLabel(event.newRole, Boolean(event.workspaceId)),
                          })
                        : roleLabel(event.oldRole || event.newRole, Boolean(event.workspaceId))}
                    </span>
                  ) : null}
                  <span className="ml-auto whitespace-nowrap text-muted-foreground">
                    {format.dateTime(new Date(event.createdAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </span>
                </span>
                <span className="truncate text-muted-foreground">
                  {t("audit.detail", {
                    reason: event.reason,
                    actor: t("audit.actor", { who: event.actorUserId }),
                  })}
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
