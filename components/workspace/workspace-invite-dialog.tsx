"use client"

/**
 * Mint an invitation to this workspace, or to the org. ADR-0149 section 4.
 *
 * # The token is shown once
 *
 * The server keeps the SHA-256 of the token and returns the clear value
 * exactly once, in the create response. This dialog shows it, offers to copy
 * it, and forgets it when closed. Nothing writes it to Dexie, localStorage or
 * a log: an invitation that can be read back later is an invitation that can
 * be redeemed by whoever reads it back.
 *
 * # Scope
 *
 * A workspace invitation seats the person in this workspace only, which for
 * an outsider makes them a guest. An org invitation makes them an org member
 * with no workspace seats. The second is offered only to org owners and
 * admins, because that is who the server lets mint one.
 */

import { useId, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, CopyIcon, LinkIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useCopy } from "@/hooks/ui/use-copy"
import { ORG_ROLES, WORKSPACE_ROLES, type OrgRole, type WorkspaceRole } from "@/types/identity"

import type { IssuedCollabInvitation } from "@/lib/collab/client"
import {
  membershipFailureMessage,
  toMembershipAdminFailure,
  type MembershipAdminState,
} from "@/hooks/workspace/use-membership-admin"

export type InviteScope = "workspace" | "org"

/** The landing link for a token: `/invite` keeps it for the sign-in gate. */
export function invitationLink(token: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin
  return `${origin}/invite?token=${encodeURIComponent(token)}`
}

const EXPIRY_DAYS = [1, 7, 30] as const

export interface WorkspaceInviteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired once per minted invitation, so a list beside the dialog can reload. */
  onIssued?: (issued: IssuedCollabInvitation) => void
  admin: Pick<
    MembershipAdminState,
    "canManageOrg" | "canManageWorkspace" | "busy" | "inviteToWorkspace" | "inviteToOrg"
  >
}

export function WorkspaceInviteDialog({
  open,
  onOpenChange,
  admin,
  onIssued,
}: WorkspaceInviteDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="workspace-invite-dialog">
        {/*
          The form and its state live in a child that exists only while the
          dialog is open. Closing unmounts it, which is how the token is
          forgotten: no effect, no reset, nothing to get out of step.
        */}
        <InviteForm admin={admin} close={() => onOpenChange(false)} onIssued={onIssued} />
      </DialogContent>
    </Dialog>
  )
}

function InviteForm({
  admin,
  close,
  onIssued,
}: {
  admin: WorkspaceInviteDialogProps["admin"]
  close: () => void
  onIssued?: (issued: IssuedCollabInvitation) => void
}) {
  const t = useTranslations("workspace.members.inviteDialog")
  const tMembers = useTranslations("workspace.members")
  const reasonId = useId()
  const scopeLabelId = useId()
  const [scope, setScope] = useState<InviteScope>("workspace")
  const [workspaceRole, setWorkspaceRole] = useState<WorkspaceRole>("member")
  const [orgRole, setOrgRole] = useState<OrgRole>("member")
  const [expiresInDays, setExpiresInDays] = useState<(typeof EXPIRY_DAYS)[number]>(7)
  const [reason, setReason] = useState("")
  const [issued, setIssued] = useState<IssuedCollabInvitation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { copied, isCopying, copy } = useCopy({ scope: "collaboration invitation" })

  const submit = async () => {
    setError(null)
    if (!reason.trim()) {
      setError(t("reasonRequired"))
      return
    }
    try {
      const result =
        scope === "org"
          ? await admin.inviteToOrg({ role: orgRole, reason: reason.trim(), expiresInDays })
          : await admin.inviteToWorkspace({
              role: workspaceRole,
              reason: reason.trim(),
              expiresInDays,
            })
      setIssued(result)
      onIssued?.(result)
    } catch (cause) {
      // Translated headline, the server's sentence as detail. The key lives
      // under `workspace.members`, one level above this dialog's namespace.
      const { key, values } = membershipFailureMessage(toMembershipAdminFailure(cause))
      setError(tMembers(key, values))
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("title")}</DialogTitle>
        <DialogDescription>{t("description")}</DialogDescription>
      </DialogHeader>

      {issued ? (
        <div className="flex flex-col gap-3" data-testid="workspace-invite-issued">
          <p className="text-sm">{t("issuedHint")}</p>
          <code
            className="select-all break-all rounded-md border bg-muted p-3 font-mono text-xs"
            data-testid="workspace-invite-token"
          >
            {issued.token}
          </code>
          <p className="text-xs text-muted-foreground">
            {t("expires", { date: new Date(issued.expiresAt).toLocaleString() })}
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isCopying}
              onClick={() => void copy(issued.token)}
              data-testid="workspace-invite-copy"
            >
              {copied ? (
                <CheckIcon data-icon="inline-start" />
              ) : (
                <CopyIcon data-icon="inline-start" />
              )}
              <span aria-live="polite">{t(copied ? "copied" : "copy")}</span>
            </Button>
            <Button
              type="button"

              variant="outline"

              disabled={isCopying}

              onClick={() => void copy(invitationLink(issued.token))}

              data-testid="workspace-invite-copy-link"
            >
              <LinkIcon data-icon="inline-start" />

              {t("copyLink")}
            </Button>

            <Button type="button" onClick={close}>
              {t("done")}
            </Button>
          </DialogFooter>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {admin.canManageOrg ? (
            <div className="flex flex-col gap-1.5">
              <Label id={scopeLabelId}>{t("scopeLabel")}</Label>
              {/*
                Two pressed buttons rather than a select: two options do not
                need a menu, and the choice changes which roles the next field
                offers, so it wants to be visible at all times.
              */}
              <div
                role="group"
                aria-labelledby={scopeLabelId}
                className="grid grid-cols-2 gap-2"
                data-testid="workspace-invite-scope"
              >
                {(["workspace", "org"] as const).map((option) => (
                  <Button
                    key={option}
                    type="button"
                    size="sm"
                    variant={scope === option ? "default" : "outline"}
                    aria-pressed={scope === option}
                    onClick={() => setScope(option)}
                    data-testid={`workspace-invite-scope-${option}`}
                  >
                    {t(option === "org" ? "scopeOrg" : "scopeWorkspace")}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label>{t("roleLabel")}</Label>
            {scope === "org" ? (
              <Select value={orgRole} onValueChange={(value) => setOrgRole(value as OrgRole)}>
                <SelectTrigger aria-label={t("roleLabel")} data-testid="workspace-invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ORG_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {t(`orgRole.${role}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Select
                value={workspaceRole}
                onValueChange={(value) => setWorkspaceRole(value as WorkspaceRole)}
              >
                <SelectTrigger aria-label={t("roleLabel")} data-testid="workspace-invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORKSPACE_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {t(`workspaceRole.${role}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t("expiryLabel")}</Label>
            <Select
              value={String(expiresInDays)}
              onValueChange={(value) =>
                setExpiresInDays(Number(value) as (typeof EXPIRY_DAYS)[number])
              }
            >
              <SelectTrigger aria-label={t("expiryLabel")} data-testid="workspace-invite-expiry">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPIRY_DAYS.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {t("expiryDays", { days })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={reasonId}>{t("reasonLabel")}</Label>
            <Input
              id={reasonId}
              value={reason}
              placeholder={t("reasonPlaceholder")}
              onChange={(event) => setReason(event.target.value)}
              data-testid="workspace-invite-reason"
            />
            <p className="text-xs text-muted-foreground">{t("reasonHint")}</p>
          </div>

          {error ? (
            <p
              role="alert"
              className="text-xs text-destructive"
              data-testid="workspace-invite-error"
            >
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              {t("cancel")}
            </Button>
            <Button
              type="button"
              disabled={admin.busy || !admin.canManageWorkspace}
              onClick={() => void submit()}
              data-testid="workspace-invite-submit"
            >
              {t("submit")}
            </Button>
          </DialogFooter>
        </div>
      )}
    </>
  )
}

export default WorkspaceInviteDialog
