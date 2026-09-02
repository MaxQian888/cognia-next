"use client"

/**
 * Who is in this workspace, ADR-0149 section 4.
 *
 * # Why this is where Guest becomes visible
 *
 * A guest is a person with workspace membership and no membership in the org
 * that owns it. Every earlier batch could *describe* that state. None of them
 * could show it to anybody but the guest themselves, because the only
 * membership the client ever learned was the signed-in person's own. The
 * roster pull changed that, and this is the surface that spends it.
 *
 * # Reads the projection, never the network
 *
 * `lib/collab/refresh.ts` owns fetching. This renders whatever the mirror last
 * heard, so opening the tab never blocks and an unreachable server degrades to
 * stale-but-visible rather than empty, the same posture the board takes.
 *
 * That posture is only honest if the surface says so, which is what the
 * freshness note and the shared stale badge are for. A roster that silently
 * shows a week-old answer is a worse failure than one that shows nothing.
 *
 * `guest` is derived on every read by `listWorkspaceRoster`. Nothing stores it,
 * so promoting somebody into the org needs no second write here and cannot be
 * forgotten.
 *
 * # Where the controls get their power
 *
 * The collaboration server publishes invitation, role and offboarding routes,
 * and `lib/collab/membership-admin.ts` calls them. None of that writes a
 * membership row locally: every write is followed by a refresh, and
 * `lib/db/workspace-membership-producers.test.ts` still pins `lib/collab/sync.ts`
 * as the only writer. So the roster stays a mirror, and the controls are
 * requests to the authority that owns it.
 *
 * The controls are rendered disabled with the reason attached, rather than
 * omitted, when the plane is not configured, nobody is signed in, or this
 * person may not manage the workspace: hiding them collapses "not built",
 * "not permitted" and "not available on this device" into one silence.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { UserMinusIcon, UserPlusIcon, UserXIcon, UsersIcon } from "lucide-react"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"

import { CollabRefreshStaleBadge } from "@/components/issues/collab-refresh-stale-badge"
import { ConsoleSection } from "@/components/surface/console-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { listOrgMembers, listWorkspaceRoster, type WorkspaceRosterEntry } from "@/lib/db/identity"
import { ORG_ROLES, WORKSPACE_ROLES, type OrgRole, type WorkspaceRole } from "@/types/identity"
import { cn } from "@/lib/utils"
import {
  membershipFailureMessage,
  toMembershipAdminFailure,
  useMembershipAdmin,
  type UseMembershipAdminDeps,
} from "@/hooks/workspace/use-membership-admin"

import { WorkspaceInviteDialog } from "./workspace-invite-dialog"
import { WorkspaceInvitations } from "./workspace-invitations"
import { WorkspaceMembershipAudit } from "./workspace-membership-audit"

/** Above this the flat list stops being scannable and the role filter appears. */
const FILTER_THRESHOLD = 8

/**
 * Two letters from a display name, or from the id when the projection holds a
 * membership but not yet the person.
 *
 * Deliberately not a generated colour: an avatar plate that changes hue per
 * person is a second identity signal competing with the name, and this list is
 * short enough that the name is already the fastest thing to read.
 */
export function initialsFor(entry: WorkspaceRosterEntry): string {
  // The prefix comes off BEFORE the split. Every id carries `usr_`, and it is
  // also a word boundary, so splitting first made every nameless person's
  // avatar start with U.
  const source = (entry.user?.displayName?.trim() || entry.membership.userId).replace(/^usr_/, "")
  const words = source.split(/[\s_-]+/).filter(Boolean)
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase()
  return source.slice(0, 2).toUpperCase()
}

export interface WorkspaceMembersProps {
  workspaceId: string | null
  /** Test seam for the admin hook. Production passes nothing. */
  adminDeps?: UseMembershipAdminDeps
}

export function WorkspaceMembers({ workspaceId, adminDeps }: WorkspaceMembersProps) {
  const t = useTranslations("workspace.members")
  const [roleFilter, setRoleFilter] = useState<string>("all")
  const [inviteOpen, setInviteOpen] = useState(false)
  /** Bumped after every server write, so the live sections below re-read. */
  const [writes, setWrites] = useState(0)
  const admin = useMembershipAdmin(workspaceId, adminDeps)
  const orgId = admin.context?.orgId ?? null

  const rosterQuery = useLiveQuery<WorkspaceRosterEntry[]>(
    () =>
      typeof window === "undefined" || !workspaceId
        ? Promise.resolve([])
        : listWorkspaceRoster(workspaceId),
    [workspaceId]
  )
  // Memoised rather than `?? []` inline: a fresh literal on every render makes
  // the filter below recompute forever, which the hook lint catches.
  const roster = useMemo(() => rosterQuery ?? [], [rosterQuery])

  // Org roles per person, for the org-role control. The roster entry carries
  // the workspace seat and the guest flag, not the org standing.
  const orgRolesQuery = useLiveQuery<Record<string, OrgRole>>(async () => {
    if (typeof window === "undefined" || !orgId) return {}
    const rows = await listOrgMembers(orgId)
    return Object.fromEntries(rows.map((row) => [row.userId, row.role]))
  }, [orgId])
  const orgRoles = useMemo(() => orgRolesQuery ?? {}, [orgRolesQuery])

  /**
   * Which of these people is the reader.
   *
   * The binding is the profile-to-person link the sign-in writes, so it answers
   * "who am I on this device" without a network call. A roster that does not
   * mark you makes you scan for your own name, which is the first thing anyone
   * looks for. Legacy aliases count: a row still under an id this profile was
   * reconciled away from is still this person.
   */
  const selfUserIds = admin.selfUserIds

  const filtered = useMemo(
    () =>
      roleFilter === "all"
        ? roster
        : roster.filter((entry) => entry.membership.role === roleFilter),
    [roster, roleFilter]
  )

  if (!workspaceId) return null

  const showFilter = roster.length > FILTER_THRESHOLD
  const inviteDisabledReason =
    admin.status === "loading"
      ? null
      : admin.status === "unavailable"
        ? t(`unavailable.${admin.reason ?? "not-configured"}`)
        : admin.canManageWorkspace
          ? null
          : t("unavailable.not-permitted")

  // The hook reports failures as codes. The words are chosen here, in the
  // reader's locale, and the server's own sentence rides along as detail.
  const explain = (cause: unknown): string => {
    const { key, values } = membershipFailureMessage(toMembershipAdminFailure(cause))
    return t(key, values)
  }
  const wrote = () => setWrites((value) => value + 1)
  const changeRole = async (userId: string, role: WorkspaceRole) => {
    try {
      await admin.changeWorkspaceRole({ userId, role, reason: t("reason.roleChanged") })
      toast.success(t("toast.roleChanged"))
      wrote()
    } catch (cause) {
      toast.error(t("toast.failed"), { description: explain(cause) })
    }
  }
  const changeOrgRole = async (userId: string, role: OrgRole) => {
    try {
      await admin.changeOrgRole({ userId, role, reason: t("reason.orgRoleChanged") })
      toast.success(t("toast.orgRoleChanged"))
      wrote()
    } catch (cause) {
      toast.error(t("toast.failed"), { description: explain(cause) })
    }
  }
  const remove = async (userId: string) => {
    try {
      await admin.removeFromWorkspace({ userId, reason: t("reason.removed") })
      toast.success(t("toast.removed"))
      wrote()
    } catch (cause) {
      toast.error(t("toast.failed"), { description: explain(cause) })
    }
  }
  const offboard = async (userId: string) => {
    try {
      await admin.offboardFromOrg({ userId, reason: t("reason.offboarded") })
      toast.success(t("toast.offboarded"))
      wrote()
    } catch (cause) {
      toast.error(t("toast.failed"), { description: explain(cause) })
    }
  }

  return (
    <ConsoleSection
      id="members"
      pane="workspace-pane"
      idPrefix="workspace-section"
      icon={UsersIcon}
      title={t("title")}
      meta={
        <span className="flex items-center gap-1.5">
          <CollabRefreshStaleBadge />
          <span className="tabular-nums">{roster.length}</span>
        </span>
      }
    >
      <div className="flex flex-col gap-2" data-testid="workspace-members">
        {showFilter ? (
          <Select value={roleFilter} onValueChange={setRoleFilter}>
            <SelectTrigger
              size="sm"
              className="w-40"
              aria-label={t("roleFilterAria")}
              data-testid="workspace-members-role-filter"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allRoles")}</SelectItem>
              {WORKSPACE_ROLES.map((role) => (
                <SelectItem key={role} value={role}>
                  {t(`role.${role}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {roster.length === 0 ? (
          /*
            Deliberately not an error. A workspace nobody shares is the ordinary
            case, and "no members" alone reads as a failure to load. Saying that
            the collaboration server is optional, and where to point at one, is
            the difference between an empty list and a broken one.
          */
          <div className="flex flex-col items-start gap-1.5" data-testid="workspace-members-empty">
            <p className="text-xs text-muted-foreground">{t("empty")}</p>
            <Button asChild size="sm" variant="ghost" className="-ml-2 h-7 text-xs">
              <Link href="/settings?section=companion">{t("configureCollaboration")}</Link>
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="workspace-members-no-matches">
            {t("noMatches")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {filtered.map((entry) => {
              const isSelf = selfUserIds.includes(entry.membership.userId)
              const manageable = admin.canManageWorkspace && !isSelf
              return (
                <li
                  key={entry.membership.id}
                  className="flex items-center gap-2 text-xs"
                  data-testid={`workspace-member-${entry.membership.userId}`}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
                      isSelf ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                    )}
                  >
                    {initialsFor(entry)}
                  </span>
                  {/*
                    Falls back to the raw `usr_` id rather than a placeholder
                    word: an id somebody can search for beats "unknown person",
                    the same call the device console and the Feishu principals
                    card make.
                  */}
                  <span className="min-w-0 flex-1 truncate" title={entry.membership.userId}>
                    {entry.user?.displayName ?? entry.membership.userId}
                  </span>
                  {isSelf ? (
                    <Badge
                      variant="secondary"
                      data-testid={`workspace-member-self-${entry.membership.userId}`}
                    >
                      {t("you")}
                    </Badge>
                  ) : null}
                  {entry.guest ? (
                    <Badge
                      variant="secondary"
                      aria-label={t("standingAria")}
                      data-testid={`workspace-member-guest-${entry.membership.userId}`}
                    >
                      {t("guest")}
                    </Badge>
                  ) : null}
                  {manageable ? (
                    <Select
                      value={entry.membership.role}
                      onValueChange={(value) =>
                        void changeRole(entry.membership.userId, value as WorkspaceRole)
                      }
                      disabled={admin.busy}
                    >
                      <SelectTrigger
                        size="sm"
                        className="h-6 w-28 text-[11px]"
                        aria-label={t("roleAria")}
                        data-testid={`workspace-member-role-${entry.membership.userId}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WORKSPACE_ROLES.map((role) => (
                          <SelectItem key={role} value={role}>
                            {t(`role.${role}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant="outline" aria-label={t("roleAria")}>
                      {t(`role.${entry.membership.role}`)}
                    </Badge>
                  )}
                  {manageable && admin.canManageOrg && !entry.guest ? (
                    <Select
                      value={orgRoles[entry.membership.userId] ?? "member"}
                      onValueChange={(value) =>
                        void changeOrgRole(entry.membership.userId, value as OrgRole)
                      }
                      disabled={admin.busy}
                    >
                      <SelectTrigger
                        size="sm"
                        className="h-6 w-28 text-[11px]"
                        aria-label={t("orgRoleAria")}
                        data-testid={`workspace-member-org-role-${entry.membership.userId}`}
                      >
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
                  ) : null}
                  {manageable ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="size-6"
                      disabled={admin.busy}
                      title={t("remove")}
                      aria-label={t("remove")}
                      onClick={() => void remove(entry.membership.userId)}
                      data-testid={`workspace-member-remove-${entry.membership.userId}`}
                    >
                      <UserMinusIcon aria-hidden className="size-3.5" />
                    </Button>
                  ) : null}
                  {manageable && admin.canManageOrg && !entry.guest ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="size-6 text-destructive"
                      disabled={admin.busy}
                      title={t("offboard")}
                      aria-label={t("offboard")}
                      onClick={() => void offboard(entry.membership.userId)}
                      data-testid={`workspace-member-offboard-${entry.membership.userId}`}
                    >
                      <UserXIcon aria-hidden className="size-3.5" />
                    </Button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}

        <div className="flex items-center gap-2 border-t pt-2">
          {/*
            Present and refused, not absent. See the file header: the reason
            the button is off is the useful fact, so it rides on the button.
          */}
          <Button
            size="sm"
            variant="ghost"
            className="-ml-2 h-7 text-xs"
            disabled={inviteDisabledReason !== null || admin.status === "loading"}
            title={inviteDisabledReason ?? undefined}
            data-unavailable={inviteDisabledReason !== null ? "true" : undefined}
            onClick={() => setInviteOpen(true)}
            data-testid="workspace-members-invite"
          >
            <UserPlusIcon aria-hidden className="size-3.5" />
            {t("invite")}
          </Button>
          {inviteDisabledReason ? (
            <p
              className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
              data-testid="workspace-members-invite-reason"
            >
              {inviteDisabledReason}
            </p>
          ) : (
            <p className="min-w-0 flex-1 text-right text-[11px] text-muted-foreground">
              {t("cachedNote")}
            </p>
          )}
        </div>
        <WorkspaceInvitations admin={admin} reloadKey={writes} />
        <WorkspaceMembershipAudit admin={admin} reloadKey={writes} />
      </div>
      <WorkspaceInviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        admin={admin}
        onIssued={wrote}
      />
    </ConsoleSection>
  )
}
