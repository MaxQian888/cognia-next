"use client"

/**
 * The account menu's organization block: which org this profile works in,
 * the role it holds there, and the other orgs it could switch to.
 *
 * Switching used to live only three clicks deep, in the account manager's
 * Identity tab. Both surfaces now share `lib/identity/org-switch.ts`, so the
 * menu is a shortcut to the same path, not a second implementation.
 *
 * Read lazily, when the menu opens, for the same reason the usage figure is:
 * the menu is mounted for the whole session and the membership listing is a
 * network call nobody can see until the menu is out.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowLeftRightIcon, BuildingIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import {
  currentOrgIdOf,
  loadOrgSwitchSnapshot,
  switchOrganization,
  type OrgSwitchDeps,
  type OrgSwitchSnapshot,
} from "@/lib/identity/org-switch"

import type { CollabAccountMembership } from "@/lib/collab/client"

export interface SidebarOrgSectionProps {
  accountId: string
  /** Load only while the menu is open. */
  open: boolean
  onSwitched?: () => void
  deps?: OrgSwitchDeps
}

export function SidebarOrgSection({ accountId, open, onSwitched, deps }: SidebarOrgSectionProps) {
  const t = useTranslations("desktop.sidebarUser.org")
  const tRole = useTranslations("account.identity.roleName")
  const [snapshot, setSnapshot] = useState<OrgSwitchSnapshot | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)
  const depsRef = useRef(deps)
  useEffect(() => {
    depsRef.current = deps
  })

  const load = useCallback(async () => {
    try {
      setSnapshot(await loadOrgSwitchSnapshot(accountId, depsRef.current))
    } catch {
      // Reading the session or the deployment failed outright: the block has
      // nothing true to say, so it says nothing rather than a half answer.
      setSnapshot(null)
    }
  }, [accountId])

  useEffect(() => {
    if (open) queueMicrotask(() => void load())
  }, [open, load])

  if (!open || !snapshot || snapshot.state.status !== "active") return null
  const currentOrgId = currentOrgIdOf(snapshot)
  const memberships = snapshot.memberships
  // The official account is personal; a deployment with no collaboration
  // service has no orgs. Neither gets an empty "Organization" heading.
  if (!currentOrgId && !memberships?.length) return null

  const current = memberships?.find((row) => row.orgId === currentOrgId)
  const others = memberships?.filter((row) => row.orgId !== currentOrgId) ?? []
  const role = current?.orgRole ?? snapshot.state.identity.orgRole

  const switchTo = async (membership: CollabAccountMembership) => {
    setSwitching(membership.orgId)
    try {
      await switchOrganization(snapshot, membership, accountId, depsRef.current)
      toast.success(t("switched", { org: membership.orgName }))
      onSwitched?.()
      await load()
    } catch (cause) {
      toast.error(t("switchFailed"), {
        description: cause instanceof Error ? cause.message : String(cause),
      })
    } finally {
      setSwitching(null)
    }
  }

  return (
    <section aria-label={t("heading")} className="px-1 py-1" data-testid="sidebar-org-section">
      <p className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">{t("heading")}</p>
      <div
        className="flex items-center gap-2.5 rounded-md px-1 py-1.5 text-[13px]"
        data-testid="sidebar-org-current"
      >
        <BuildingIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{current?.orgName ?? currentOrgId}</span>
        {role ? (
          <Badge variant="secondary" className="text-[10px] font-normal">
            {tRole(role)}
          </Badge>
        ) : null}
      </div>
      {snapshot.membershipsError ? (
        <p role="alert" className="px-1 text-[11px] text-destructive">
          {t("listFailed")}
        </p>
      ) : null}
      {others.map((membership) => (
        <button
          key={membership.orgId}
          type="button"
          disabled={switching !== null}
          onClick={() => void switchTo(membership)}
          data-testid={`sidebar-org-switch-${membership.orgId}`}
          className="flex w-full items-center gap-2.5 rounded-md px-1 py-1.5 text-left text-[13px] transition-colors hover:bg-accent disabled:opacity-60"
        >
          <ArrowLeftRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {switching === membership.orgId
              ? t("switching", { org: membership.orgName })
              : t("switchTo", { org: membership.orgName })}
          </span>
        </button>
      ))}
    </section>
  )
}
