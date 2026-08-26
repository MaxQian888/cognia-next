"use client"

/**
 * Who is in this workspace — ADR-0149 §4.
 *
 * # Why this is where Guest becomes visible
 *
 * A guest is a person with workspace membership and no membership in the org
 * that owns it. Every earlier batch could *describe* that state; none of them
 * could show it to anybody but the guest themselves, because the only
 * membership the client ever learned was the signed-in person's own. The
 * roster pull changed that, and this is the surface that spends it.
 *
 * # Reads the projection, never the network
 *
 * `lib/collab/refresh.ts` owns fetching. This renders whatever the mirror last
 * heard, so opening the tab never blocks and an unreachable server degrades to
 * stale-but-visible rather than empty — the same posture the board takes.
 *
 * `guest` is derived on every read by `listWorkspaceRoster`. Nothing stores it,
 * so promoting somebody into the org needs no second write here and cannot be
 * forgotten.
 */

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { UsersIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { listWorkspaceRoster, type WorkspaceRosterEntry } from "@/lib/db/identity"

export function WorkspaceMembers({ workspaceId }: { workspaceId: string | null }) {
  const t = useTranslations("workspace.members")

  const roster =
    useLiveQuery<WorkspaceRosterEntry[]>(
      () =>
        typeof window === "undefined" || !workspaceId
          ? Promise.resolve([])
          : listWorkspaceRoster(workspaceId),
      [workspaceId]
    ) ?? []

  if (!workspaceId) return null

  return (
    <section className="space-y-2" data-testid="workspace-members">
      <div className="flex items-center gap-2">
        <UsersIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-medium">{t("title")}</h3>
      </div>

      {roster.length === 0 ? (
        // Deliberately not an error. A workspace nobody shares is the ordinary
        // case, and "no members" would read as a failure to load.
        <p className="text-xs text-muted-foreground italic" data-testid="workspace-members-empty">
          {t("empty")}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {roster.map((entry) => (
            <li
              key={entry.membership.id}
              className="flex items-center justify-between gap-2 text-xs"
              data-testid={`workspace-member-${entry.membership.userId}`}
            >
              {/*
                Falls back to the raw `usr_` id rather than a placeholder word:
                an id somebody can search for beats "unknown person", the same
                call the device console and the Feishu principals card make.
              */}
              <span className="min-w-0 truncate" title={entry.membership.userId}>
                {entry.user?.displayName ?? entry.membership.userId}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {entry.guest ? (
                  <Badge
                    variant="secondary"
                    aria-label={t("standingAria")}
                    data-testid={`workspace-member-guest-${entry.membership.userId}`}
                  >
                    {t("guest")}
                  </Badge>
                ) : null}
                <Badge variant="outline" aria-label={t("roleAria")}>
                  {t(`role.${entry.membership.role}`)}
                </Badge>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
